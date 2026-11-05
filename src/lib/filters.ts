export type Filter = 'original' | 'gris' | 'lapiz' | 'contorno' | 'etapas';

export type FilterOptions = {
  filter: Filter;
  detail: number; // 0..100
  removeWhite: boolean;
  step: number; // 0-based index into DRAWING_STEPS
};

export const DRAWING_STEPS = ['Contorno', 'Sombras', 'Medios tonos', 'Completo'];

function toGray(px: Uint8ClampedArray): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0; i < gray.length; i++) {
    const a = px[i * 4 + 3] / 255;
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    gray[i] = lum * a + 255 * (1 - a); // transparent PNGs read as white paper
  }
  return gray;
}

// Three box-blur passes approximate a gaussian; ctx.filter is missing on older Safari.
function blur(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  const a = Uint8ClampedArray.from(src);
  const b = new Uint8ClampedArray(src.length);
  const size = radius * 2 + 1;
  const horizontal = (from: Uint8ClampedArray, to: Uint8ClampedArray) => {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += from[row + Math.max(0, Math.min(w - 1, x))];
      for (let x = 0; x < w; x++) {
        to[row + x] = sum / size;
        sum += from[row + Math.min(w - 1, x + radius + 1)] - from[row + Math.max(0, x - radius)];
      }
    }
  };
  const vertical = (from: Uint8ClampedArray, to: Uint8ClampedArray) => {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += from[Math.max(0, Math.min(h - 1, y)) * w + x];
      for (let y = 0; y < h; y++) {
        to[y * w + x] = sum / size;
        sum += from[Math.min(h - 1, y + radius + 1) * w + x] - from[Math.max(0, y - radius) * w + x];
      }
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    horizontal(a, b);
    vertical(b, a);
  }
  return a;
}

function pencil(px: Uint8ClampedArray, w: number, h: number, detail: number) {
  const gray = toGray(px);
  const inverted = gray.map((v) => 255 - v);
  const blurred = blur(inverted, w, h, Math.round(2 + detail / 12));
  for (let i = 0; i < gray.length; i++) {
    const dodge = Math.min(255, (gray[i] * 255) / Math.max(1, 255 - blurred[i]));
    const ink = 255 - dodge;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 30;
    px[i * 4 + 3] = Math.min(255, ink * 1.8);
  }
}

function edges(gray: Uint8ClampedArray, w: number, h: number, detail: number): Uint8ClampedArray {
  const threshold = 150 - detail * 1.3;
  const alpha = new Uint8ClampedArray(gray.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      alpha[i] = (Math.hypot(gx, gy) - threshold) * 4;
    }
  }
  return alpha;
}

function outline(px: Uint8ClampedArray, w: number, h: number, detail: number) {
  const alpha = edges(blur(toGray(px), w, h, 1), w, h, detail);
  for (let i = 0; i < alpha.length; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 20;
    px[i * 4 + 3] = alpha[i];
  }
}

// Gray level below which the given share of the drawn (non-white) pixels fall.
function toneLevel(gray: Uint8ClampedArray, share: number): number {
  const histogram = new Array<number>(256).fill(0);
  let drawn = 0;
  for (const v of gray) {
    if (v < 235) {
      histogram[v]++;
      drawn++;
    }
  }
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += histogram[level];
    if (seen >= drawn * share) return level;
  }
  return 128;
}

// Reveals the image the way it is usually drawn: lines first, then dark masses, then mid tones.
function drawingStep(px: Uint8ClampedArray, w: number, h: number, detail: number, step: number) {
  const gray = toGray(px);
  const lines = edges(blur(gray, w, h, 1), w, h, detail);
  const tones = blur(gray, w, h, 3);
  const dark = toneLevel(tones, 0.33);
  const mid = toneLevel(tones, 0.7);
  const ramp = (level: number, value: number) => Math.max(0, Math.min(1, (level + 6 - value) / 12));
  for (let i = 0; i < gray.length; i++) {
    let alpha = lines[i];
    if (step >= 1) alpha = Math.max(alpha, 185 * ramp(dark, tones[i]));
    if (step >= 2) alpha = Math.max(alpha, 105 * ramp(mid, tones[i]));
    if (step >= 3) {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = gray[i];
      px[i * 4 + 3] = Math.max(alpha, Math.min(255, ((245 - gray[i]) / 40) * 255));
    } else {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 25;
      px[i * 4 + 3] = alpha;
    }
  }
}

function dropWhite(px: Uint8ClampedArray) {
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i + 3] = Math.min(px[i + 3], Math.max(0, Math.min(255, ((245 - lum) / 40) * 255)));
  }
}

export function applyFilter(px: Uint8ClampedArray, w: number, h: number, opts: FilterOptions): void {
  if (opts.filter === 'gris') {
    const gray = toGray(px);
    for (let i = 0; i < gray.length; i++) {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = gray[i];
      px[i * 4 + 3] = 255;
    }
  } else if (opts.filter === 'lapiz') {
    pencil(px, w, h, opts.detail);
  } else if (opts.filter === 'contorno') {
    outline(px, w, h, opts.detail);
  } else if (opts.filter === 'etapas') {
    drawingStep(px, w, h, opts.detail, opts.step);
  }
  if (opts.removeWhite && (opts.filter === 'original' || opts.filter === 'gris')) dropWhite(px);
}
