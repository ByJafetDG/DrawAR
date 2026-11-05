import type { FilterOptions } from './filters';
import type { FilterRequest } from './filters.worker';

export { DRAWING_STEPS, type Filter } from './filters';
export type ProcessOptions = FilterOptions & { grid: number }; // grid: squares across the short side, 0 is off
export type PreparedImage = { blob: Blob; thumb: Blob; canvas: HTMLCanvasElement };

const MAX_SIDE = 1400;
const THUMB_SIDE = 220;

function scaled(source: CanvasImageSource, width: number, height: number, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = scaled(bitmap, bitmap.width, bitmap.height, MAX_SIDE);
  bitmap.close();
  return canvas;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo guardar la imagen'))), type, quality);
  });
}

// A 12 MP phone photo costs far more to decode than to draw. It is reduced once here, and only
// the small copy and a thumbnail are kept, so reopening a recent image is instant.
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const keepsAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/svg+xml';
  return prepareCanvas(await blobToCanvas(file), keepsAlpha);
}

export async function prepareCanvas(canvas: HTMLCanvasElement, keepsAlpha: boolean): Promise<PreparedImage> {
  const blob = await encode(canvas, keepsAlpha ? 'image/png' : 'image/jpeg', 0.92);
  const small = scaled(canvas, canvas.width, canvas.height, THUMB_SIDE);
  const backed = document.createElement('canvas');
  backed.width = small.width;
  backed.height = small.height;
  const ctx = backed.getContext('2d')!;
  ctx.fillStyle = '#fff'; // JPEG has no alpha, and black would hide a cut-out subject
  ctx.fillRect(0, 0, backed.width, backed.height);
  ctx.drawImage(small, 0, 0);
  return { blob, thumb: await encode(backed, 'image/jpeg', 0.8), canvas };
}

// Letters across and numbers down, so a square can be found on the paper by its name.
function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, squares: number) {
  const step = Math.min(w, h) / squares;
  ctx.strokeStyle = 'rgba(232, 83, 43, 0.85)';
  ctx.lineWidth = Math.max(1, Math.max(w, h) / 800);
  ctx.beginPath();
  for (let x = step; x < w - 1; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = step; y < h - 1; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  const size = Math.max(14, step * 0.2);
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = (text: string, x: number, y: number) => {
    ctx.fillStyle = 'rgba(232, 83, 43, 0.92)';
    ctx.beginPath();
    ctx.arc(x, y, size * 0.72, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y + size * 0.04);
  };
  const inset = size * 0.95;
  for (let column = 0; column * step < w - 1; column++) label(String.fromCharCode(65 + column), column * step + step / 2, inset);
  for (let row = 0; row * step < h - 1; row++) label(String(row + 1), inset, row * step + step / 2);
}

// Filters run in a worker: a large image would otherwise freeze the camera while they compute.
export class ImageProcessor {
  private readonly worker = new Worker(new URL('./filters.worker.ts', import.meta.url), { type: 'module' });
  private readonly pixels: Uint8ClampedArray;
  private lastId = 0;

  constructor(private readonly source: HTMLCanvasElement) {
    const { width, height } = source;
    this.pixels = source.getContext('2d')!.getImageData(0, 0, width, height).data;
  }

  // Resolves to null when a newer request made this one pointless.
  async render(opts: ProcessOptions): Promise<HTMLCanvasElement | null> {
    const { width, height } = this.source;
    const id = ++this.lastId;
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d')!;
    if (opts.filter === 'original' && !opts.removeWhite) {
      ctx.drawImage(this.source, 0, 0);
    } else {
      const copy = this.pixels.slice();
      const { filter, detail, removeWhite, step } = opts;
      const request: FilterRequest = { id, width, height, data: copy.buffer, opts: { filter, detail, removeWhite, step } };
      const result = await new Promise<ArrayBuffer>((resolve) => {
        const onDone = (e: MessageEvent<{ id: number; data: ArrayBuffer }>) => {
          if (e.data.id !== id) return;
          this.worker.removeEventListener('message', onDone);
          resolve(e.data.data);
        };
        this.worker.addEventListener('message', onDone);
        this.worker.postMessage(request, [copy.buffer]);
      });
      if (id !== this.lastId) return null;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(result), width, height), 0, 0);
    }
    if (opts.grid) drawGrid(ctx, width, height, opts.grid);
    return out;
  }

  destroy(): void {
    this.worker.terminate();
  }
}
