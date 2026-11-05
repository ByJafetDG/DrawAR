// Finds where a drawing lies by its strokes, for a camera too close to see the edges of the sheet.
// The strokes in view are turned, scaled and slid over a reference until they land on its lines.
// The comparison is one-sided on purpose: a drawing in progress covers only part of the image.
import { apply, mul, type Mat3, type Pt } from './homography';
import { solve, type Gray } from './sheet';

export type Layer = { width: number; height: number; distance: Float32Array };
export type Field = { fine: Layer; coarse: Layer };
export type Strokes = { points: Pt[]; lines: Uint8Array };
export type Reference = { field: Field; tolerance: number; minScore: number };
export type Match = { map: Mat3; score: number };

const SURROUND = 9; // pixels: how far around a pixel the paper's brightness is measured
const MIN_PAPER = 110;
const MIN_PAPER_SHARE = 0.72; // of the paper's brightness: anything darker is ink, a hand or the table
const BLOCK = 15; // pixels: dark covering most of a square this size is a hand or the table, not a stroke
const MAX_SHADE = 0.45;
const MIN_DARKNESS = 12;
const CELL = 6; // at most one point per cell, so thick strokes do not outvote thin ones
const MAX_POINTS = 320;
export const MIN_POINTS = 40;

const FAR = 1e6;
const COARSE = 4;
const IMAGE_SURROUND = 6;
const IMAGE_LINE_DARKNESS = 20;
const IMAGE_MIN_EDGE = 120;

const ANGLE_STEPS = 48;
const SCALE_ROUNDS = [[1], [0.9, 1.1], [0.8, 1.25], [0.7, 1.4]]; // the phone may have moved
const MIN_INSIDE = 0.5; // share of the strokes that must fall inside the reference
const FINALISTS = 10;
const MIN_LEAD = 0.08; // a rival pose this close means the strokes do not settle the question

function percentile90(data: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const v of data) histogram[v]++;
  let seen = 0;
  for (let i = 255; i >= 0; i--) {
    seen += histogram[i];
    if (seen >= data.length * 0.1) return i;
  }
  return 0;
}

function boxSum(width: number, height: number, read: (i: number) => number): Float64Array {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += read(y * width + x);
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  return integral;
}

function boxMean(integral: Float64Array, width: number, x: number, y: number, radius: number, height: number): number {
  const stride = width + 1;
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(width, x + radius + 1);
  const y1 = Math.min(height, y + radius + 1);
  const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}

// Keeps only the middle of each dark line. A thick outline would otherwise let a drawing slide
// across its width and still look aligned.
function ridges(darkness: Float32Array, w: number, h: number, min: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const d = darkness[i];
      if (d < min) continue;
      const peak = (a: number, b: number) => d > darkness[i - a] && d >= darkness[i + b];
      if (peak(1, 1) || peak(w, w) || peak(w + 1, w + 1) || peak(w - 1, w - 1)) out[i] = 1;
    }
  }
  return out;
}

// Dark marks on paper. Large dark areas are left out, which drops the table and a hand along with
// its outline, while a thick marker line still counts.
export function strokesIn(g: Gray): Strokes {
  const { data, width: w, height: h } = g;
  const paper = percentile90(data);
  if (paper < MIN_PAPER) return { points: [], lines: new Uint8Array(w * h) };
  const integral = boxSum(w, h, (i) => data[i]);
  const shade = boxSum(w, h, (i) => (data[i] < paper * MIN_PAPER_SHARE ? 1 : 0));
  const darkness = new Float32Array(w * h);
  for (let y = SURROUND; y < h - SURROUND; y++) {
    for (let x = SURROUND; x < w - SURROUND; x++) {
      if (boxMean(shade, w, x, y, BLOCK, h) > MAX_SHADE) continue;
      darkness[y * w + x] = boxMean(integral, w, x, y, SURROUND, h) - data[y * w + x];
    }
  }
  const lines = ridges(darkness, w, h, MIN_DARKNESS);
  const columns = Math.ceil(w / CELL);
  const darkest = new Float32Array(columns * Math.ceil(h / CELL));
  const where = new Int32Array(darkest.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cell = Math.floor(i / w / CELL) * columns + Math.floor((i % w) / CELL);
    if (darkness[i] > darkest[cell]) {
      darkest[cell] = darkness[i];
      where[cell] = i;
    }
  }
  const found = [...where].filter((i) => i >= 0);
  const stride = Math.max(1, found.length / MAX_POINTS);
  const points: Pt[] = [];
  for (let k = 0; k < found.length; k += stride) {
    const i = found[Math.floor(k)];
    points.push({ x: i % w, y: Math.floor(i / w) });
  }
  return { points, lines };
}

function distanceMap(lines: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = lines[i] ? 0 : FAR;
  const relax = (i: number, j: number, step: number) => {
    if (d[j] + step < d[i]) d[i] = d[j] + step;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x) relax(i, i - 1, 1);
      if (y) relax(i, i - w, 1);
      if (x && y) relax(i, i - w - 1, Math.SQRT2);
      if (y && x < w - 1) relax(i, i - w + 1, Math.SQRT2);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, 1);
      if (y < h - 1) relax(i, i + w, 1);
      if (x < w - 1 && y < h - 1) relax(i, i + w + 1, Math.SQRT2);
      if (x && y < h - 1) relax(i, i + w - 1, Math.SQRT2);
    }
  }
  return d;
}

export function fieldOf(lines: Uint8Array, width: number, height: number): Field {
  const w = Math.ceil(width / COARSE);
  const h = Math.ceil(height / COARSE);
  const small = new Uint8Array(w * h);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (lines[y * width + x]) small[Math.floor(y / COARSE) * w + Math.floor(x / COARSE)] = 1;
    }
  }
  return {
    fine: { width, height, distance: distanceMap(lines, width, height) },
    coarse: { width: w, height: h, distance: distanceMap(small, w, h) },
  };
}

// The lines someone would trace: thin dark lines, plus the borders between areas of color.
export function imageLines(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const light = new Float32Array(width * height);
  for (let i = 0; i < light.length; i++) {
    const p = i * 4;
    const alpha = rgba[p + 3] / 255;
    light[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * alpha + 255 * (1 - alpha);
  }
  const integral = boxSum(width, height, (i) => light[i]);
  const darkness = new Float32Array(width * height);
  const strength = new Float32Array(width * height);
  const gxs = new Float32Array(width * height);
  const gys = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      darkness[i] = boxMean(integral, width, x, y, IMAGE_SURROUND, height) - light[i];
      gxs[i] = light[i + 1 - width] + 2 * light[i + 1] + light[i + 1 + width] - light[i - 1 - width] - 2 * light[i - 1] - light[i - 1 + width];
      gys[i] = light[i + width - 1] + 2 * light[i + width] + light[i + width + 1] - light[i - width - 1] - 2 * light[i - width] - light[i - width + 1];
      strength[i] = Math.abs(gxs[i]) + Math.abs(gys[i]);
    }
  }
  const lines = ridges(darkness, width, height, IMAGE_LINE_DARKNESS);
  // Borders between colors, thinned to their sharpest pixel. The sides of a dark line are skipped:
  // the line's middle already stands for it.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const m = strength[i];
      if (m < IMAGE_MIN_EDGE || darkness[i] > IMAGE_LINE_DARKNESS / 2) continue;
      const gx = Math.abs(gxs[i]);
      const gy = Math.abs(gys[i]);
      const step = gx > 2.4 * gy ? 1 : gy > 2.4 * gx ? width : gxs[i] * gys[i] > 0 ? width + 1 : width - 1;
      if (m >= strength[i - step] && m > strength[i + step]) lines[i] = 1;
    }
  }
  return lines;
}

type Candidate = { score: number; scale: number; angle: number; x: number; y: number };

function keep(top: Candidate[], c: Candidate): void {
  const close = top.findIndex(
    (t) => t.scale === c.scale && Math.abs(t.angle - c.angle) < 0.2 && Math.hypot(t.x - c.x, t.y - c.y) < 4,
  );
  if (close >= 0) {
    if (top[close].score < c.score) top[close] = c;
  } else if (top.length < FINALISTS) {
    top.push(c);
  } else {
    const worst = top.reduce((a, t, i) => (t.score < top[a].score ? i : a), 0);
    if (top[worst].score < c.score) top[worst] = c;
  }
}

// Scores every position at one angle and scale on the coarse map. Positions that start badly are
// dropped after a quarter of the points, which is what makes the full sweep affordable.
function sweep(xs: Float32Array, ys: Float32Array, layer: Layer, reach: number, scale: number, angle: number, top: Candidate[]): void {
  const { width: w, height: h, distance } = layer;
  const n = xs.length;
  const cos = (Math.cos(angle) * scale) / COARSE;
  const sin = (Math.sin(angle) * scale) / COARSE;
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    qx[i] = Math.round(cos * xs[i] - sin * ys[i]);
    qy[i] = Math.round(sin * xs[i] + cos * ys[i]);
  }
  const check = n >> 2;
  const margin = Math.round(Math.max(w, h) * 0.2);
  for (let ty = -margin; ty < h + margin; ty += 2) {
    const floor = top.length === FINALISTS ? Math.min(...top.map((t) => t.score)) - 0.25 : 0;
    for (let tx = -margin; tx < w + margin; tx += 2) {
      let sum = 0;
      let inside = 0;
      let i = 0;
      for (; i < n; i++) {
        const x = qx[i] + tx;
        const y = qy[i] + ty;
        if (x >= 0 && y >= 0 && x < w && y < h) {
          inside++;
          const d = distance[y * w + x];
          if (d < reach) sum += 1 - d / reach;
        }
        if (i === check && sum < floor * check) break;
      }
      if (i === n && inside >= n * MIN_INSIDE) keep(top, { score: sum / inside, scale, angle, x: tx * COARSE, y: ty * COARSE });
    }
  }
}

function fit(points: Pt[], layer: Layer, map: Mat3, tolerance: number): number {
  const { width: w, height: h, distance } = layer;
  let sum = 0;
  let inside = 0;
  for (const p of points) {
    const q = apply(map, p);
    const x = Math.round(q.x);
    const y = Math.round(q.y);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    inside++;
    sum += Math.max(0, 1 - distance[y * w + x] / tolerance);
  }
  return inside >= points.length * MIN_INSIDE ? sum / inside : 0;
}

// Pulls each point toward its nearest line, with a shrinking reach so far-off lines let go.
function polish(points: Pt[], layer: Layer, start: Mat3, tolerance: number, from: number): Mat3 {
  const { width: w, height: h, distance } = layer;
  let map = start;
  for (const reach of [Math.max(from, tolerance * 4), tolerance * 2.5, tolerance * 1.5]) {
    for (let round = 0; round < 4; round++) {
      const A = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
      const b = new Array<number>(4).fill(0);
      const mapped = points.map((p) => apply(map, p));
      const cx = mapped.reduce((s, q) => s + q.x, 0) / mapped.length;
      const cy = mapped.reduce((s, q) => s + q.y, 0) / mapped.length;
      for (const q of mapped) {
        const x = Math.round(q.x);
        const y = Math.round(q.y);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const i = y * w + x;
        const d = distance[i];
        if (d === 0 || d > reach) continue;
        const gx = distance[i + 1] - distance[i - 1];
        const gy = distance[i + w] - distance[i - w];
        const norm = Math.hypot(gx, gy) || 1;
        const nx = gx / norm;
        const ny = gy / norm;
        const X = q.x - cx;
        const Y = q.y - cy;
        const row = [nx, ny, nx * X + ny * Y, ny * X - nx * Y];
        for (let r = 0; r < 4; r++) {
          b[r] -= row[r] * d;
          for (let c = 0; c < 4; c++) A[r][c] += row[r] * row[c];
        }
      }
      for (let r = 0; r < 4; r++) A[r][r] += r < 2 ? 1 : 1000;
      const [tx, ty, grow, turn] = solve(A, b);
      const step: Mat3 = [1 + grow, -turn, tx + cx - (1 + grow) * cx + turn * cy, turn, 1 + grow, ty + cy - turn * cx - (1 + grow) * cy, 0, 0, 1];
      map = mul(step, map);
    }
  }
  return map;
}

function separation(points: Pt[], a: Mat3, b: Mat3): number {
  let sum = 0;
  for (const p of points) {
    const q = apply(a, p);
    const r = apply(b, p);
    sum += Math.hypot(q.x - r.x, q.y - r.y);
  }
  return sum / points.length;
}

// `start` takes frame pixels to the reference as things stood, and supplies the likely scale and
// any mirroring. Returns the new map, or null unless one pose clearly beats every other.
export function locate(points: Pt[], start: Mat3, reference: Reference): Match | null {
  const { field, tolerance, minScore } = reference;
  // Spread the sampling order so the early exit in `sweep` sees all of the drawing.
  const order = points.map((_, i) => (i * 7919) % points.length);
  const shuffled = [...new Set(order)].map((i) => points[i]);
  const cx = shuffled.reduce((s, p) => s + p.x, 0) / shuffled.length;
  const cy = shuffled.reduce((s, p) => s + p.y, 0) / shuffled.length;
  const xs = new Float32Array(shuffled.length);
  const ys = new Float32Array(shuffled.length);
  shuffled.forEach((p, i) => {
    xs[i] = start[0] * (p.x - cx) + start[1] * (p.y - cy);
    ys[i] = start[3] * (p.x - cx) + start[4] * (p.y - cy);
  });
  // Angles are tried in steps, so the far end of a large drawing can miss its line by up to half
  // a step. The coarse search must forgive that much, and the polish must start from there.
  let spread = 0;
  for (let i = 0; i < xs.length; i++) spread += xs[i] * xs[i] + ys[i] * ys[i];
  const halfStep = (Math.sqrt(spread / xs.length) * Math.PI) / ANGLE_STEPS;
  const reach = Math.max(2, (tolerance * 2) / COARSE, halfStep / COARSE);
  const angles = Array.from({ length: ANGLE_STEPS }, (_, i) => {
    const turn = Math.ceil(i / 2) * (i % 2 ? 1 : -1); // nearest to the current angle first
    return (turn * 2 * Math.PI) / ANGLE_STEPS;
  });
  const top: Candidate[] = [];
  for (const scales of SCALE_ROUNDS) {
    for (const scale of scales) for (const angle of angles) sweep(xs, ys, field.coarse, reach, scale, angle, top);
    const finalists = top.map((c) => {
      const cos = Math.cos(c.angle) * c.scale;
      const sin = Math.sin(c.angle) * c.scale;
      const placed = mul([cos, -sin, c.x, sin, cos, c.y, 0, 0, 1], [start[0], start[1], -start[0] * cx - start[1] * cy, start[3], start[4], -start[3] * cx - start[4] * cy, 0, 0, 1]);
      const map = polish(points, field.fine, placed, tolerance, halfStep * 1.5);
      return { map, score: fit(points, field.fine, map, tolerance) };
    });
    finalists.sort((a, b) => b.score - a.score);
    const best = finalists[0];
    const rival = best && finalists.find((m) => separation(points, m.map, best.map) > tolerance * 3);
    if (!best || best.score < minScore) continue;
    if (!rival || best.score - rival.score >= MIN_LEAD) return best;
  }
  return null;
}
