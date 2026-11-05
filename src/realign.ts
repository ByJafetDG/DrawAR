import { frameToStage } from './lib/camera';
import { fromQuad, invert, mul, type Mat3, type Pt } from './lib/homography';
import type { Overlay } from './lib/overlay';
import { RestWatch } from './lib/rest';
import type { SheetResponse } from './lib/sheet.worker';
import type { StrokeResponse } from './lib/strokes.worker';
import { FrameWorker, createSheetWorker, createStrokesWorker } from './lib/tracker';

export type RealignHost = {
  stage: HTMLElement;
  video: HTMLVideoElement;
  overlay: Overlay;
  image: HTMLCanvasElement;
  toast(text: string): void;
  onMoved(): void;
};

const SHEET_SIDE = 800;
const STROKES_SIDE = 640;
const IMAGE_SIDE = 1024;
const EVERY_MS = 160; // the image only moves when the sheet rests, so a slow pace saves battery
const STROKES_EVERY = 2; // ticks
const STABLE_FINDS = 3;
const SETTLE_MS = 2500; // after one way moves the image, a late answer from the other is stale
const UNIT: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

// Draw with Camera leaves the image on the screen, so moving the sheet would leave it behind.
// Two background trackers bring it back. The sheet's outline is exact and works on a blank page;
// the strokes work when the phone is too close to see the edges, by comparing what is drawn with
// what was seen before and with the image itself. Whichever answers first moves the image.
export class SheetFollower {
  private readonly sheet: FrameWorker<SheetResponse>;
  private readonly strokes: FrameWorker<StrokeResponse>;
  private readonly rest = new RestWatch();
  private readonly timer: number;
  private sheetFrameWidth = 1;
  private locked = false;
  private finds = 0;
  private ticks = 0;
  private lastMove = -Infinity;

  constructor(private readonly host: RealignHost) {
    // A failure here only costs the automatic adjustment, which is not worth an error on screen.
    this.sheet = new FrameWorker<SheetResponse>(createSheetWorker(), SHEET_SIDE, (msg) => this.onSheet(msg), () => undefined, ['snapshot']);
    this.strokes = new FrameWorker<StrokeResponse>(createStrokesWorker(), STROKES_SIDE, (msg) => this.onStrokes(msg), () => undefined);
    this.sendImage();
    this.timer = window.setInterval(() => this.tick(), EVERY_MS);
  }

  private sendImage(): void {
    const { image } = this.host;
    const scale = Math.min(1, IMAGE_SIDE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    this.strokes.post({ type: 'image', width: canvas.width, height: canvas.height, data: data.buffer, bitmapWidth: image.width });
  }

  // The width FrameWorker will give a frame of this video, worked out before grabbing it.
  private frameWidth(side: number): number {
    const { videoWidth: vw, videoHeight: vh } = this.host.video;
    return Math.round(vw * (side / Math.max(vw, vh)));
  }

  private tick(): void {
    const { video, stage, overlay } = this.host;
    if (video.readyState < 2) return;
    const type = this.locked ? 'track' : this.finds >= STABLE_FINDS ? 'lock' : 'find';
    const frame = this.sheet.send(type, video);
    if (frame) this.sheetFrameWidth = frame.width;
    if (++this.ticks % STROKES_EVERY) return;
    const toFrame = invert(frameToStage(video, stage, this.frameWidth(STROKES_SIDE)));
    this.strokes.send('frame', video, { pose: mul(toFrame, overlay.imageToStage) });
  }

  private onSheet(msg: SheetResponse): void {
    if (msg.type === 'found') {
      this.finds = msg.quad ? this.finds + 1 : 0;
    } else if (msg.type === 'locked') {
      this.finds = 0;
      this.locked = !!msg.quad;
      if (msg.quad) this.host.toast('Hoja detectada: si la mueves, la imagen la sigue');
    } else if (msg.type === 'pose') {
      const move = this.rest.read(msg.quad, msg.sides === 4, performance.now());
      if (!move || this.recentlyMoved()) return;
      this.follow(mul(fromQuad(UNIT, move.to), invert(fromQuad(UNIT, move.from))), this.sheetFrameWidth, 'Imagen reajustada a tu hoja');
      this.strokes.post({ type: 'rebase' });
    }
  }

  private onStrokes(msg: StrokeResponse): void {
    if (msg.type !== 'moved' || this.recentlyMoved()) return;
    this.follow(msg.transform, this.frameWidth(STROKES_SIDE), 'Imagen reajustada con tus trazos');
    this.rest.forget();
  }

  private recentlyMoved(): boolean {
    return performance.now() - this.lastMove < SETTLE_MS;
  }

  private follow(onFrame: Mat3, frameWidth: number, message: string): void {
    const { overlay, stage, video, toast, onMoved } = this.host;
    const toStage = frameToStage(video, stage, frameWidth);
    overlay.glideWorld(mul(mul(mul(toStage, onFrame), invert(toStage)), overlay.worldMatrix));
    this.lastMove = performance.now();
    toast(message);
    onMoved();
  }

  destroy(): void {
    clearInterval(this.timer);
    this.sheet.destroy();
    this.strokes.destroy();
  }
}
