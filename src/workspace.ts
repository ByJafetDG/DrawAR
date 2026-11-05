import { ArSession, type Tone } from './ar';
import { icon, type IconName } from './icons';
import { deliverFile } from './lib/backup';
import { Camera, friendlyCameraError, keepAwake, type Facing } from './lib/camera';
import { attachGestures } from './lib/gestures';
import { DRAWING_STEPS, ImageProcessor, type Filter, type ProcessOptions } from './lib/image';
import { IDENTITY, invert, mul, type Mat3 } from './lib/homography';
import { Overlay } from './lib/overlay';
import { saveProject, type Project, type ProjectState } from './lib/store';
import type { TimeLapse } from './lib/timelapse';
import { SheetFollower } from './realign';

export type Mode = Project['mode'];
export type Session = { canvas: HTMLCanvasElement; project: Project; timelapse: TimeLapse };

const FILTERS: [Filter, string][] = [
  ['original', 'Original'],
  ['gris', 'Gris'],
  ['lapiz', 'Lápiz'],
  ['contorno', 'Contorno'],
  ['etapas', 'Etapas'],
];

const GRID_SIZES = [0, 4, 8, 12];
const COACH_KEY = 'drawar.coach';
const COACH_MS = 7000;
const TOAST_MS = 2600;
const UNLOCK_HOLD_MS = 800;
const SAVE_DELAY_MS = 1000;
const BLINK_MS = 700;

const tool = (action: string, name: IconName, label: string, pressable = false) =>
  `<button class="tool" data-action="${action}" ${pressable ? 'aria-pressed="false"' : ''}>${icon(name)}<span>${label}</span></button>`;

const tab = (id: string, name: IconName, label: string) =>
  `<button class="tab" data-tab="${id}" aria-pressed="false">${icon(name)}<span>${label}</span></button>`;

const TEMPLATE = (mode: Mode) => `
  <div class="stage" data-role="stage">
    ${mode === 'screen' ? '' : '<video playsinline muted autoplay></video>'}
    <div class="layers" data-role="layers"></div>
  </div>
  <header class="ws-top" data-role="top">
    <button class="round" data-action="back" aria-label="Volver">${icon('back')}</button>
    <div class="status" data-role="status" role="status" hidden><i></i><span></span></div>
    <button class="round" data-action="clean" aria-label="Ocultar controles">${icon('hide')}</button>
  </header>
  <div class="stepper" data-role="stepper" hidden>
    <button data-action="step-back" aria-label="Paso anterior">${icon('back')}</button>
    <span data-role="step-name"></span>
    <button data-action="step-next" aria-label="Paso siguiente">${icon('next')}</button>
  </div>
  <div class="toasts" data-role="toasts" aria-live="polite"></div>
  <span class="rec" data-role="rec" hidden><i></i>REC</span>
  <div class="coach" data-role="coach" hidden>Un dedo mueve · dos dedos escalan y giran</div>
  ${mode === 'screen' ? '' : `<button class="round compare" data-role="compare" aria-label="Mantén para ver solo tu dibujo" hidden>${icon('eye')}</button>`}
  <footer class="dock" data-role="dock">
    <div class="tray" data-role="tray" hidden>
      <section data-panel="adjust" hidden>
        <label class="slider"><span>Giro</span><input type="range" min="-180" max="180" value="0" data-role="rotation" /><output data-role="rotation-value">0°</output></label>
        <div class="tools">
          ${tool('flip', 'flip', 'Voltear', true)}
          ${tool('center', 'center', 'Centrar')}
          ${mode === 'screen' ? '' : `${tool('blink', 'blink', 'Parpadeo', true)}${tool('copy', 'copy', 'Fijar copia')}${tool('uncopy', 'uncopy', 'Quitar copia')}`}
        </div>
      </section>
      <section data-panel="style" hidden>
        <div class="segments" data-role="filters">
          ${FILTERS.map(([id, label]) => `<button class="segment" data-filter="${id}" aria-pressed="${id === 'original'}">${label}</button>`).join('')}
        </div>
        <label class="slider" data-role="detail-row" hidden><span>Detalle</span><input type="range" min="0" max="100" value="50" data-role="detail" /></label>
        <div class="tools">
          <button class="tool" data-action="grid" aria-pressed="false">${icon('grid')}<span data-role="grid-label">Cuadrícula</span></button>
          ${mode === 'screen' ? '' : tool('white', 'white', 'Quitar blanco', true)}
        </div>
      </section>
      <section data-panel="options" hidden>
        <div class="tools">
          ${mode === 'screen' ? tool('background', 'contrast', 'Fondo negro', true) : ''}
          ${mode === 'ar' ? `${tool('rescan', 'scan', 'Reescanear')}<button class="tool" data-action="size"><b data-role="size-name">Carta</b><span>Tamaño de hoja</span></button>` : ''}
          ${mode === 'camera' ? tool('realign', 'scan', 'Reajuste automático', true) : ''}
          ${mode === 'screen' ? '' : `${tool('timelapse', 'video', 'Time-lapse', true)}${tool('torch', 'torch', 'Linterna', true)}${tool('switch', 'camera', 'Cámara')}`}
        </div>
      </section>
    </div>
    <label class="opacity"><span>Opacidad</span><input type="range" min="0" max="100" value="100" data-role="opacity" /></label>
    <nav class="tabs">
      ${tab('adjust', 'adjust', 'Ajustar')}
      ${tab('style', 'style', 'Estilo')}
      ${tab('options', 'options', mode === 'screen' ? 'Fondo' : 'Más')}
      <button class="lock" data-action="lock">${icon('lock')}<span>Bloquear</span></button>
    </nav>
  </footer>
  <button class="round reveal" data-action="clean" data-role="reveal" aria-label="Mostrar controles" hidden>${icon('sparkle')}</button>
  <button class="unlock" data-role="unlock" hidden><span></span>${icon('lock')}Mantén para desbloquear</button>
`;

function shouldCoach(): boolean {
  try {
    return !localStorage.getItem(COACH_KEY);
  } catch {
    return false;
  }
}

function markCoached(): void {
  try {
    localStorage.setItem(COACH_KEY, '1');
  } catch {
    // Without storage the hint simply shows again next time.
  }
}

export function openWorkspace(root: HTMLElement, mode: Mode, session: Session, onExit: () => void): () => void {
  root.className = `workspace mode-${mode}`;
  root.innerHTML = TEMPLATE(mode);

  const $ = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!;
  const action = <T extends HTMLElement = HTMLButtonElement>(name: string) => root.querySelector<T>(`[data-action="${name}"]`);
  const { project, timelapse } = session;
  const saved = project.state;
  const stage = $('stage');
  const dock = $('dock');
  const tray = $('tray');
  const status = $('status');
  const video = root.querySelector('video');
  const overlay = new Overlay($('layers'));
  const processor = new ImageProcessor(session.canvas);
  const camera = video ? new Camera(video) : null;
  const releaseWake = keepAwake();

  const defaults: ProcessOptions = { filter: 'original', detail: 50, removeWhite: mode !== 'screen', step: 0, grid: 0 };
  const opts: ProcessOptions = { ...defaults, ...saved?.opts };
  let opacity = saved?.opacity ?? (mode === 'screen' ? 1 : 0.5);
  let facing: Facing = 'environment';
  let destroyed = false;
  let openTab: string | null = null;
  let locked = false;
  let ar: ArSession | null = null;
  let follower: SheetFollower | null = null;
  let dirty = false;
  let saveTimer = 0;
  let blinkTimer = 0;
  let ready = false;

  const snapshot = (): ProjectState => ({
    opts: { ...opts },
    opacity,
    placement: { ...overlay.placement },
    copies: overlay.copyPlacements,
    stage: { width: stage.clientWidth, height: stage.clientHeight },
    sheet: ar ? ar.memory : null,
    world: mode === 'camera' ? overlay.worldMatrix : undefined,
  });

  const persist = () => {
    clearTimeout(saveTimer);
    if (!dirty || !ready) return;
    dirty = false;
    project.state = snapshot();
    void saveProject(project);
  };

  // Autosave: there is no save button to forget.
  const touch = () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(persist, SAVE_DELAY_MS);
  };

  const setStatus = (text: string, tone: Tone = '') => {
    status.hidden = !text;
    status.querySelector('span')!.textContent = text;
    status.dataset.tone = tone;
  };

  const toast = (text: string) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').append(el);
    setTimeout(() => el.remove(), TOAST_MS);
  };

  const redraw = async () => {
    const bitmap = await processor.render(opts);
    if (bitmap && !destroyed) overlay.setBitmap(bitmap);
  };

  const restyle = () => {
    touch();
    void redraw();
  };

  const toggle = (btn: HTMLElement, on: boolean) => btn.setAttribute('aria-pressed', String(on));

  const syncRotation = () => {
    const deg = Math.round((((overlay.placement.rot * 180) / Math.PI + 540) % 360) - 180);
    $<HTMLInputElement>('rotation').value = String(deg);
    $('rotation-value').textContent = `${deg}°`;
  };

  const syncStyle = () => {
    root.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) => toggle(b, b.dataset.filter === opts.filter));
    $('detail-row').hidden = !['lapiz', 'contorno', 'etapas'].includes(opts.filter);
    $('stepper').hidden = opts.filter !== 'etapas';
    $('step-name').textContent = `${opts.step + 1}/${DRAWING_STEPS.length} · ${DRAWING_STEPS[opts.step]}`;
    $('grid-label').textContent = opts.grid ? `${opts.grid} cuadros` : 'Cuadrícula';
    toggle(action('grid')!, opts.grid > 0);
  };

  const hideCoach = () => {
    $('coach').hidden = true;
    markCoached();
  };

  const gestures = attachGestures(stage, overlay, () => {
    syncRotation();
    hideCoach();
    touch();
  });

  const showCoach = () => {
    if (saved || !shouldCoach()) return;
    $('coach').hidden = false;
    setTimeout(() => !destroyed && hideCoach(), COACH_MS);
  };

  const recenter = () => {
    if (ar) {
      ar.recenter();
    } else {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      overlay.setWorld(IDENTITY);
      overlay.reset({ x: w / 2, y: h / 2 }, w * 0.82, h * 0.72);
    }
    syncRotation();
  };

  const startFollower = () => {
    follower = new SheetFollower({ stage, video: video!, overlay, image: session.canvas, toast, onMoved: touch });
    toggle(action('realign')!, true);
  };

  const setTab = (id: string | null) => {
    openTab = id;
    tray.hidden = !id;
    root.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== id));
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) => toggle(t, t.dataset.tab === id));
  };

  const startCamera = async () => {
    if (!camera) return;
    const previous = status.hidden ? '' : status.querySelector('span')!.textContent!;
    const previousTone = (status.dataset.tone ?? '') as Tone;
    setStatus('Abriendo cámara…');
    try {
      await camera.start(facing);
      if (destroyed) return camera.stop();
      setStatus(previous, previousTone);
      action('torch')?.toggleAttribute('hidden', !camera.hasTorch);
    } catch (err) {
      setStatus(friendlyCameraError(err), 'warn');
    }
  };

  const setLocked = (value: boolean) => {
    locked = value;
    gestures.setEnabled(!value);
    root.classList.toggle('locked', value);
    $('unlock').hidden = !value;
    if (value) setTab(null);
  };

  const setRecording = (on: boolean) => {
    $('rec').hidden = !on;
    const btn = action('timelapse');
    if (btn) toggle(btn, on);
  };

  const showTimeLapse = async () => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card">
        <h2>Tu time-lapse</h2>
        <p data-role="tl-text">Creando video…</p>
        <video data-role="tl-video" controls playsinline loop hidden></video>
        <button class="primary" data-role="tl-save" hidden>${icon('download')}Guardar video</button>
        <div class="modal-row">
          <button class="link" data-role="tl-clear" hidden>${icon('trash')}Borrar grabación</button>
          <button class="link" data-role="tl-close">Cerrar</button>
        </div>
      </div>`;
    root.append(modal);
    const part = <T extends HTMLElement>(name: string) => modal.querySelector<T>(`[data-role="tl-${name}"]`)!;
    let url = '';
    const close = () => {
      URL.revokeObjectURL(url);
      modal.remove();
    };
    part('close').onclick = close;
    part('clear').onclick = () => {
      timelapse.clear();
      close();
      toast('Grabación borrada');
    };
    try {
      const file = await timelapse.render((share) => {
        part('text').textContent = `Creando video… ${Math.round(share * 100)}%`;
      });
      url = URL.createObjectURL(file);
      part<HTMLVideoElement>('video').src = url;
      part('video').hidden = false;
      part('text').textContent = 'Puedes seguir grabando y crear otro más largo.';
      part('save').hidden = false;
      part('clear').hidden = false;
      part('save').onclick = () => void deliverFile(file);
    } catch (err) {
      part('text').textContent = err instanceof Error ? err.message : 'No se pudo crear el video.';
    }
  };

  const actions: Record<string, (btn: HTMLElement) => void> = {
    back: () => onExit(),
    clean: () => {
      const clean = root.classList.toggle('clean');
      $('reveal').hidden = !clean;
      if (clean) setTab(null);
    },
    lock: () => setLocked(true),
    center: () => {
      recenter();
      touch();
    },
    rescan: () => ar?.rescan(),
    realign: (btn) => {
      if (follower) {
        follower.destroy();
        follower = null;
        toggle(btn, false);
      } else {
        startFollower();
      }
    },
    size: () => {
      ar?.cycleSheetSize();
      touch();
    },
    flip: (btn) => {
      overlay.placement.flip = !overlay.placement.flip;
      toggle(btn, overlay.placement.flip);
      overlay.render();
      touch();
    },
    blink: (btn) => {
      const on = !blinkTimer;
      toggle(btn, on);
      clearInterval(blinkTimer);
      blinkTimer = 0;
      overlay.setHidden(false);
      let hidden = false;
      if (on) {
        blinkTimer = window.setInterval(() => overlay.setHidden((hidden = !hidden)), BLINK_MS);
      }
    },
    grid: () => {
      opts.grid = GRID_SIZES[(GRID_SIZES.indexOf(opts.grid) + 1) % GRID_SIZES.length];
      syncStyle();
      restyle();
    },
    white: (btn) => {
      opts.removeWhite = !opts.removeWhite;
      toggle(btn, opts.removeWhite);
      restyle();
    },
    'step-back': () => {
      opts.step = Math.max(0, opts.step - 1);
      syncStyle();
      restyle();
    },
    'step-next': () => {
      opts.step = Math.min(DRAWING_STEPS.length - 1, opts.step + 1);
      syncStyle();
      restyle();
    },
    background: (btn) => toggle(btn, root.classList.toggle('dark-stage')),
    copy: () => {
      overlay.addCopy();
      action('uncopy')!.disabled = false;
      toast('Copia fijada. Mueve la imagen para poner otra');
      touch();
    },
    uncopy: (btn) => {
      overlay.removeCopy();
      (btn as HTMLButtonElement).disabled = overlay.copyCount === 0;
      touch();
    },
    timelapse: () => {
      if (timelapse.recording) {
        timelapse.stop();
        setRecording(false);
        void showTimeLapse();
      } else {
        timelapse.start(video!);
        setRecording(true);
        toast('Grabando. Toma una foto cada pocos segundos');
      }
    },
    torch: (btn) => {
      void camera?.toggleTorch().then(() => toggle(btn, !!camera?.torchOn));
    },
    switch: () => {
      facing = facing === 'environment' ? 'user' : 'environment';
      void startCamera();
    },
  };

  const onClick = (e: Event) => {
    const el = e.target as HTMLElement;
    const btn = el.closest<HTMLElement>('[data-action]');
    if (btn) actions[btn.dataset.action!]?.(btn);
    const tabBtn = el.closest<HTMLElement>('[data-tab]');
    if (tabBtn) setTab(openTab === tabBtn.dataset.tab ? null : tabBtn.dataset.tab!);
    const filter = el.closest<HTMLElement>('[data-filter]');
    if (filter) {
      opts.filter = filter.dataset.filter as Filter;
      syncStyle();
      restyle();
    }
  };
  root.addEventListener('click', onClick);

  // A long press must not open the phone's text selection or context menu.
  const onContextMenu = (e: Event) => e.preventDefault();
  root.addEventListener('contextmenu', onContextMenu);

  $<HTMLInputElement>('opacity').addEventListener('input', (e) => {
    opacity = Number((e.target as HTMLInputElement).value) / 100;
    overlay.setOpacity(opacity);
    touch();
  });
  $<HTMLInputElement>('rotation').addEventListener('input', (e) => {
    const deg = Number((e.target as HTMLInputElement).value);
    overlay.placement.rot = (deg * Math.PI) / 180;
    $('rotation-value').textContent = `${deg}°`;
    overlay.render();
    touch();
  });
  $<HTMLInputElement>('detail').addEventListener('input', (e) => {
    opts.detail = Number((e.target as HTMLInputElement).value);
    restyle();
  });

  const compare = root.querySelector<HTMLElement>('[data-role="compare"]');
  if (compare) {
    const release = () => overlay.setHidden(false);
    compare.addEventListener('pointerdown', () => overlay.setHidden(true));
    compare.addEventListener('pointerup', release);
    compare.addEventListener('pointerleave', release);
    compare.addEventListener('pointercancel', release);
  }

  // Unlocking needs a long press so a pencil or a palm cannot do it by accident.
  const unlock = $('unlock');
  let holdTimer = 0;
  const cancelHold = () => {
    clearTimeout(holdTimer);
    unlock.classList.remove('holding');
  };
  unlock.addEventListener('pointerdown', () => {
    unlock.classList.add('holding');
    holdTimer = window.setTimeout(() => {
      cancelHold();
      setLocked(false);
    }, UNLOCK_HOLD_MS);
  });
  unlock.addEventListener('pointerup', cancelHold);
  unlock.addEventListener('pointerleave', cancelHold);
  unlock.addEventListener('pointercancel', cancelHold);

  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') return;
    ar?.requestMemory();
    persist();
  };
  document.addEventListener('visibilitychange', onVisibility);

  overlay.setOpacity(opacity);
  $<HTMLInputElement>('opacity').value = String(Math.round(opacity * 100));
  $<HTMLInputElement>('detail').value = String(opts.detail);
  if (mode !== 'screen') toggle(action('white')!, opts.removeWhite);
  syncStyle();

  // Only a sheet can be found again; a placement on screen or on old marks means nothing in AR.
  const restored = mode === 'ar' ? (saved?.sheet ? saved : null) : saved;

  const restoreLayout = () => {
    if (!restored) return false;
    const { placement, copies, stage: was, world } = restored;
    const x = mode === 'ar' ? 1 : stage.clientWidth / was.width;
    const y = mode === 'ar' ? 1 : stage.clientHeight / was.height;
    const scale = Math.min(x, y);
    const fit = (p: typeof placement) => ({ ...p, x: p.x * x, y: p.y * y, scale: p.scale * scale });
    if (mode === 'camera' && world) {
      const stretch: Mat3 = [x, 0, 0, 0, y, 0, 0, 0, 1];
      overlay.setWorld(mul(mul(stretch, world), invert(stretch)));
    }
    overlay.restore(fit(placement), copies.map(fit));
    toggle(action('flip')!, placement.flip);
    syncRotation();
    return true;
  };

  void redraw().then(() => {
    if (destroyed) return;
    const hasLayout = restoreLayout();
    if (action('uncopy')) action('uncopy')!.disabled = overlay.copyCount === 0;
    if (mode === 'ar') {
      dock.hidden = true;
      ar = new ArSession({
        root,
        stage,
        video: video!,
        overlay,
        resume: restored?.sheet ?? null,
        setStatus,
        toast,
        onTracking: (tracking) => {
          dock.hidden = !tracking;
          if (compare) compare.hidden = !tracking;
          if (tracking) {
            syncRotation();
            showCoach();
            touch();
          }
        },
        onSheetSize: (name) => {
          const size = action('size');
          if (size) size.hidden = !name;
          if (name) $('size-name').textContent = name;
        },
        onMemory: touch,
      });
    } else {
      if (!hasLayout) recenter();
      if (compare) compare.hidden = false;
      showCoach();
      if (mode === 'camera') startFollower();
    }
    ready = true;
  });

  if (mode === 'screen') {
    root.requestFullscreen?.().catch(() => undefined);
  } else {
    void startCamera();
  }

  return () => {
    persist();
    destroyed = true;
    timelapse.stop();
    clearInterval(blinkTimer);
    if (locked) setLocked(false);
    root.removeEventListener('click', onClick);
    root.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('visibilitychange', onVisibility);
    gestures.destroy();
    ar?.destroy();
    follower?.destroy();
    overlay.destroy();
    processor.destroy();
    camera?.stop();
    releaseWake();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    root.className = '';
    root.innerHTML = '';
  };
}
