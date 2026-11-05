import { frameToStage } from './lib/camera';
import { apply, fromQuad, maxDistance, mul, type Mat3, type Pt } from './lib/homography';
import type { Overlay } from './lib/overlay';
import type { SheetResponse } from './lib/sheet.worker';
import type { SheetMemory } from './lib/store';
import { FrameWorker, createMarksWorker, createSheetWorker } from './lib/tracker';
import type { TrackerResponse } from './lib/tracker.worker';

export type Tone = 'ok' | 'warn' | '';

export type ArHost = {
  root: HTMLElement;
  stage: HTMLElement;
  video: HTMLVideoElement;
  overlay: Overlay;
  resume: SheetMemory | null; // a saved sheet; the overlay already holds its placement
  setStatus(text: string, tone?: Tone): void;
  toast(text: string): void;
  onTracking(tracking: boolean): void;
  onSheetSize(name: string | null): void;
  onMemory(): void;
};

type Phase = 'aim' | 'aim-marks' | 'tracking';

// Saved sheets keep an index into this list, so new sizes go at the end.
const SIZES = [
  { name: 'Carta', ratio: 279 / 216 },
  { name: 'A4', ratio: 297 / 210 },
  { name: 'Medida', ratio: 0 }, // the proportions the camera measured
  { name: 'A3', ratio: 420 / 297 },
];
const MEASURED = 2;
const SIZE_ORDER = [0, 1, 3, MEASURED];
const SIZE_SNAP = 0.08;
const SHEET_LONG_SIDE = 1400; // sheet coordinates, an arbitrary unit
const STABLE_FINDS = 4; // consecutive detections before offering to lock
const HELP_AFTER_MS = 7000;
const SNAPSHOT_EVERY_MS = 6000;
const SHEET_FRAME_SIDE = 800;
const MARKS_FRAME_SIDE = 640;

const MIN_REF_FEATURES = 120;
const MIN_REF_COVERAGE = 0.5;
const GOOD_READINGS_NEEDED = 3; // a single lucky reading must not enable capture
const MAX_POSE_DISAGREEMENT = 30; // frame pixels between two consecutive poses

const LOST_AFTER_FRAMES = 4;
const DEADBAND = { sheet: 0.3, marks: 0.7 }; // frame pixels: ignores jitter on a phone sitting on a stand
const FOLLOW = 0.35;

const rectangle = (w: number, h: number): Pt[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

const CARD = `
  <h2 data-role="ar-title">Busca la hoja</h2>
  <p data-role="ar-text"></p>
  <div class="meter" data-role="ar-meter" hidden><span></span></div>
  <button class="primary" data-role="ar-lock" disabled>Fijar hoja</button>
  <button class="link" data-role="ar-switch">Usar marcas (cuaderno, pared o lienzo)</button>
`;

export class ArSession {
  private readonly card = document.createElement('div');
  private readonly outline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  private readonly sheet: FrameWorker<SheetResponse>;
  private marks: FrameWorker<TrackerResponse> | null = null;

  private phase: Phase = 'aim';
  private kind: 'sheet' | 'marks' = 'sheet';
  private raf = 0;
  private frame = { width: 1, height: 1 };
  private ref: Pt[] = rectangle(1, 1);
  private target: Pt[] | null = null;
  private current: Pt[] | null = null;
  private candidate: Pt[] | null = null;
  private lostFrames = 0;
  private placed = false; // keeps the image where the user left it when rescanning

  private lastSend = 0;
  private stableFinds = 0;
  private aimStart = performance.now();
  private goodReadings = 0;
  private wantLock = false;

  private measuredRatio = 1;
  private portrait = true;
  private sizeIndex = 0;
  private latest: SheetMemory | null;
  private readonly snapshotTimer: number;

  constructor(private readonly host: ArHost) {
    this.latest = host.resume;
    this.card.className = 'ar-card';
    this.card.innerHTML = CARD;
    this.outline.setAttribute('class', 'sheet-outline');
    this.outline.append(this.polygon);
    host.stage.append(this.outline);
    host.root.append(this.card);
    this.card.querySelector<HTMLElement>('[data-role="ar-lock"]')!.onclick = () => (this.wantLock = true);
    this.card.querySelector<HTMLElement>('[data-role="ar-switch"]')!.onclick = () => this.useMarks();
    this.sheet = new FrameWorker<SheetResponse>(
      createSheetWorker(),
      SHEET_FRAME_SIDE,
      (msg) => this.onSheet(msg),
      (message) => host.setStatus(`Error de tracking: ${message}`, 'warn'),
      ['snapshot'],
    );
    if (host.resume) {
      this.sheet.post({ type: 'resume', ink: host.resume.ink, aspect: host.resume.aspect });
      this.sizeIndex = host.resume.sizeIndex;
      this.placed = true;
    }
    this.snapshotTimer = window.setInterval(() => this.requestMemory(), SNAPSHOT_EVERY_MS);
    host.overlay.setVisible(false);
    this.showAimHelp();
    this.loop();
  }

  // What must be saved to find this sheet again another day.
  get memory(): SheetMemory | null {
    return this.kind === 'sheet' ? this.latest : null;
  }

  requestMemory(): void {
    if (this.kind === 'sheet' && this.phase === 'tracking') this.sheet.post({ type: 'snapshot' });
  }

  private el<T extends HTMLElement>(role: string): T {
    return this.card.querySelector<T>(`[data-role="ar-${role}"]`)!;
  }

  private write(title: string, text: string): void {
    this.el('title').textContent = title;
    this.el('text').textContent = text;
  }

  private showAimHelp(): void {
    const slow = performance.now() - this.aimStart > HELP_AFTER_MS;
    if (slow) this.write('Busca la hoja', 'No la encuentro. Pon la hoja sobre un fondo más oscuro y con buena luz.');
    else if (this.placed) this.write('Coloca tu hoja', 'Ponla entera a la vista y tu imagen volverá a su lugar.');
    else this.write('Busca la hoja', 'Que se vea entera en la pantalla, sobre una mesa más oscura que el papel.');
  }

  private frameToScreen(): Mat3 {
    return frameToStage(this.host.video, this.host.stage, this.frame.width);
  }

  private drawOutline(quad: Pt[] | null): void {
    this.outline.classList.toggle('visible', !!quad);
    if (!quad) return;
    const toScreen = this.frameToScreen();
    this.polygon.setAttribute('points', quad.map((p) => apply(toScreen, p)).map((p) => `${p.x},${p.y}`).join(' '));
  }

  private applySheetSize(): void {
    const size = SIZES[this.sizeIndex];
    const short = SHEET_LONG_SIDE / (size.ratio || this.measuredRatio);
    this.ref = this.portrait ? rectangle(short, SHEET_LONG_SIDE) : rectangle(SHEET_LONG_SIDE, short);
    this.host.onSheetSize(size.name);
  }

  // Lets the user correct the paper size if the measured proportions were off.
  cycleSheetSize(): void {
    if (this.kind !== 'sheet') return;
    this.sizeIndex = SIZE_ORDER[(SIZE_ORDER.indexOf(this.sizeIndex) + 1) % SIZE_ORDER.length];
    this.applySheetSize();
  }

  private enterTracking(): void {
    this.phase = 'tracking';
    this.lostFrames = 0;
    this.candidate = null;
    this.card.hidden = true;
    this.drawOutline(null);
    const { overlay } = this.host;
    overlay.setVisible(true);
    overlay.setDimmed(false);
    if (!this.placed) this.recenter();
    this.placed = true;
    this.host.onTracking(true);
    this.host.setStatus(this.kind === 'sheet' ? 'Fijado a la hoja' : 'Fijado a las marcas', 'ok');
  }

  recenter(): void {
    const { x: w, y: h } = this.ref[2];
    this.host.overlay.reset({ x: w / 2, y: h / 2 }, w * 0.82, h * 0.82);
  }

  rescan(): void {
    this.phase = this.kind === 'sheet' ? 'aim' : 'aim-marks';
    this.target = this.current = this.candidate = null;
    this.stableFinds = this.goodReadings = 0;
    this.aimStart = performance.now();
    this.wantLock = false;
    this.host.overlay.setVisible(false);
    this.host.onTracking(false);
    this.host.setStatus('');
    this.card.hidden = false;
    this.el<HTMLButtonElement>('lock').disabled = true;
    if (this.kind === 'sheet') this.showAimHelp();
  }

  private useMarks(): void {
    this.kind = 'marks';
    this.phase = 'aim-marks';
    this.placed = false;
    this.wantLock = false;
    this.drawOutline(null);
    this.host.onSheetSize(null);
    this.el('switch').hidden = true;
    this.el('meter').hidden = false;
    this.el<HTMLButtonElement>('lock').disabled = true;
    this.el('lock').textContent = 'Capturar superficie';
    this.write('Modo marcas', 'Cargando el rastreador. La primera vez puede tardar unos segundos…');
    this.marks = new FrameWorker<TrackerResponse>(
      createMarksWorker(),
      MARKS_FRAME_SIDE,
      (msg) => this.onMarks(msg),
      (message) => this.host.setStatus(`Error de tracking: ${message}`, 'warn'),
      ['ready'],
    );
  }

  private onSheet(msg: SheetResponse): void {
    if (msg.type === 'found') {
      if (this.phase !== 'aim') return;
      this.stableFinds = msg.quad ? this.stableFinds + 1 : 0;
      this.drawOutline(msg.quad);
      const ready = this.stableFinds >= STABLE_FINDS;
      this.el<HTMLButtonElement>('lock').disabled = !ready;
      if (ready) this.write('Hoja detectada', 'Ya la tengo. Fíjala y coloca tu imagen.');
      else this.showAimHelp();
    } else if (msg.type === 'locked') {
      if (!msg.quad) {
        this.host.toast('Perdí la hoja, intenta de nuevo');
        return;
      }
      this.measuredRatio = Math.max(msg.aspect, 1 / msg.aspect);
      this.portrait = msg.aspect < 1;
      if (!this.placed) {
        const closest = SIZES.findIndex((s) => Math.abs(s.ratio / this.measuredRatio - 1) < SIZE_SNAP);
        this.sizeIndex = closest >= 0 ? closest : MEASURED;
      }
      this.applySheetSize();
      this.current = this.target = msg.quad;
      this.enterTracking();
      if (msg.recognized === true) this.host.toast('Reconocí tu dibujo');
      if (msg.recognized === false) this.host.toast('No reconocí el dibujo. ¿Es la misma hoja?');
    } else if (msg.type === 'snapshot') {
      this.latest = { ink: msg.ink, aspect: msg.aspect, sizeIndex: this.sizeIndex };
      this.host.onMemory();
    } else if (this.phase === 'tracking' && this.kind === 'sheet') {
      this.onPose(msg.quad, msg.returned, msg.turned);
    }
  }

  private onMarks(msg: TrackerResponse): void {
    if (msg.type === 'error') {
      this.host.setStatus(`Error de tracking: ${msg.message}`, 'warn');
    } else if (msg.type === 'ready') {
      this.write('Modo marcas', 'Haz unos 12 garabatos oscuros repartidos por la superficie, con buena luz.');
    } else if (msg.type === 'analysis') {
      this.showMarksQuality(msg.features, msg.coverage);
    } else if (msg.type === 'reference') {
      if (msg.features < MIN_REF_FEATURES || msg.coverage < MIN_REF_COVERAGE) {
        this.goodReadings = 0;
        this.showMarksQuality(msg.features, msg.coverage);
        this.host.toast('Muy poca textura: añade garabatos y repite');
        return;
      }
      this.ref = rectangle(this.frame.width, this.frame.height);
      this.current = this.target = this.ref;
      this.enterTracking();
    } else if (msg.type === 'pose' && this.phase === 'tracking' && this.kind === 'marks') {
      const h = msg.homography;
      const next = h ? this.ref.map((p) => apply(h, p)) : null;
      // A bad pose rarely repeats, so a new pose only counts once two readings in a row agree.
      const agrees = next && this.candidate && maxDistance(next, this.candidate) < MAX_POSE_DISAGREEMENT;
      this.candidate = next;
      if (!next || agrees) this.onPose(next, false, false);
    }
  }

  private showMarksQuality(features: number, coverage: number): void {
    const score = Math.min(features / MIN_REF_FEATURES, coverage / MIN_REF_COVERAGE, 1);
    this.goodReadings = score >= 1 ? this.goodReadings + 1 : 0;
    const ok = this.goodReadings >= GOOD_READINGS_NEEDED;
    const meter = this.el('meter').firstElementChild as HTMLElement;
    meter.style.width = `${Math.round(score * 100)}%`;
    meter.dataset.ok = String(ok);
    this.el('text').textContent = ok ? 'Buena textura. Mantén el celular firme y captura.' : 'Falta textura repartida por la superficie.';
    this.el<HTMLButtonElement>('lock').disabled = !ok;
  }

  private onPose(quad: Pt[] | null, returned: boolean, turned: boolean): void {
    const { overlay, setStatus, toast } = this.host;
    if (!quad) {
      // Keep the last pose: a hand over the paper should not make the drawing jump.
      if (++this.lostFrames === LOST_AFTER_FRAMES) {
        setStatus(this.kind === 'sheet' ? 'Pon la hoja entera a la vista' : 'Buscando las marcas…', 'warn');
        overlay.setDimmed(true);
      }
      return;
    }
    const wasLost = this.lostFrames >= LOST_AFTER_FRAMES;
    if (wasLost) {
      setStatus(this.kind === 'sheet' ? 'Fijado a la hoja' : 'Fijado a las marcas', 'ok');
      overlay.setDimmed(false);
    }
    if (returned && (wasLost || turned)) toast(turned ? 'Hoja girada: la imagen la siguió' : 'Hoja recuperada');
    this.lostFrames = 0;
    if (returned) {
      this.current = this.target = quad;
    } else if (maxDistance(quad, this.target!) > DEADBAND[this.kind]) {
      this.target = quad;
    }
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const { video } = this.host;
    if (video.readyState < 2) return;
    const now = performance.now();
    if (this.phase === 'aim') {
      const type = this.wantLock ? 'lock' : 'find';
      if (type === 'find' && now - this.lastSend < 90) return;
      const frame = this.sheet.send(type, video);
      if (!frame) return;
      this.frame = frame;
      this.lastSend = now;
      if (type === 'lock') this.wantLock = false;
    } else if (this.phase === 'aim-marks') {
      if (!this.marks) return;
      const type = this.wantLock ? 'reference' : 'analyze';
      if (type === 'analyze' && now - this.lastSend < 400) return;
      const frame = this.marks.send(type, video);
      if (!frame) return;
      this.frame = frame;
      this.lastSend = now;
      if (type === 'reference') this.wantLock = false;
    } else if (this.current && this.target) {
      const frame = (this.kind === 'sheet' ? this.sheet : this.marks!).send('track', video);
      if (frame) this.frame = frame;
      const target = this.target;
      this.current = this.current.map((p, i) => ({
        x: p.x + (target[i].x - p.x) * FOLLOW,
        y: p.y + (target[i].y - p.y) * FOLLOW,
      }));
      this.host.overlay.setWorld(mul(this.frameToScreen(), fromQuad(this.ref, this.current)));
    }
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.snapshotTimer);
    this.sheet.destroy();
    this.marks?.destroy();
    this.card.remove();
    this.outline.remove();
  }
}
