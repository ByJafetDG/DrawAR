export type Frame = { width: number; height: number; data: ArrayBuffer };

export const createSheetWorker = () => new Worker(new URL('./sheet.worker.ts', import.meta.url), { type: 'module' });
export const createMarksWorker = () => new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' });
export const createStrokesWorker = () => new Worker(new URL('./strokes.worker.ts', import.meta.url), { type: 'module' });

// Feeds video frames to a tracking worker so the camera and the overlay stay smooth.
export class FrameWorker<Response extends { type: string }> {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  busy = false;

  constructor(
    private readonly worker: Worker,
    private readonly longSide: number,
    onMessage: (msg: Response) => void,
    onError: (message: string) => void,
    skipBusy: Response['type'][] = [],
  ) {
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      if (!skipBusy.includes(e.data.type)) this.busy = false;
      onMessage(e.data);
    };
    this.worker.onerror = (e) => {
      this.busy = false;
      onError(e.message);
    };
  }

  private grab(video: HTMLVideoElement): Frame | null {
    const { videoWidth: vw, videoHeight: vh } = video;
    if (!vw || !vh) return null;
    const scale = this.longSide / Math.max(vw, vh);
    const width = Math.round(vw * scale);
    const height = Math.round(vh * scale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(video, 0, 0, width, height);
    return { width, height, data: this.ctx.getImageData(0, 0, width, height).data.buffer };
  }

  // For messages without a frame, which do not make the worker busy.
  post(message: object): void {
    this.worker.postMessage(message);
  }

  // Sends the current video frame; frames are skipped while the worker is busy.
  send(type: string, video: HTMLVideoElement, extra: object = {}): Frame | null {
    if (this.busy) return null;
    const frame = this.grab(video);
    if (!frame) return null;
    this.busy = true;
    this.worker.postMessage({ type, ...frame, ...extra }, [frame.data]);
    return frame;
  }

  destroy(): void {
    this.worker.terminate();
  }
}
