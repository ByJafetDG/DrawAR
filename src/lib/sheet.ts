// Finds and follows a sheet of paper by its outline, so a completely blank page can be tracked
// and the overlay moves with the paper instead of with the table.
import { apply, fromQuad, type Pt } from './homography';

export type Quad = [Pt, Pt, Pt, Pt]; // clockwise on screen, first side is the sheet's "width"
export type Gray = { data: Uint8Array; width: number; height: number };
export type Fit = { quad: Quad; sides: number; support: number };
export type Found = Fit & { paperLevel: number };

const WING = 3; // pixels averaged on each side of a candidate edge
const MIN_CONTRAST = 14;
const LINE_TOLERANCE = 1.3;
const MIN_SIDE_SPAN = 0.22; // share of a side that must be visible for it to count
const INSIDE_MIN_LEVEL = 0.72; // what lies inside an edge must look like paper
const SMALL_WIDTH = 160;
const FRAME_MARGIN = 3;
const MIN_LONG_TO_SHORT = 1.08;
const MAX_LONG_TO_SHORT = 1.75;
const MIN_AREA = 0.06;
const MAX_CUT_CELLS = 2;

const PATCH_W = 240;
const PATCH_H = 310;
const INK_BLUR = 7;
const INK_MARGIN = 12;
const INK_SOFTEN = 2; // map cells: a slightly misplaced sheet must not read as another drawing
const INK_MIN_MATCH = 0.3;
const INK_MIN_LEAD = 0.1; // below this the drawing looks the same both ways round
const INK_MIN_DARKNESS = 4;
const INK_MIN_SHARE = 0.001;

// White paper has all three channels high; wood, skin and most tables do not.
export function toWhiteness(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    data[i] = Math.min(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
  return { data, width, height };
}

function sample(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.width + x0;
  const top = g.data[i] * (1 - fx) + g.data[i + 1] * fx;
  const bottom = g.data[i + g.width] * (1 - fx) + g.data[i + g.width + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

const inFrame = (g: Gray, x: number, y: number) => x >= 1 && y >= 1 && x < g.width - 2 && y < g.height - 2;

// Looks along the outward normal for the bright-to-dark step of a paper edge.
// Returns how far from the base point it is, or null when no such step exists.
function edgeOffset(g: Gray, x: number, y: number, nx: number, ny: number, radius: number, paper: number): number | null {
  const length = (radius + WING) * 2 + 1;
  const profile = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const s = i - radius - WING;
    const px = x + nx * s;
    const py = y + ny * s;
    profile[i] = inFrame(g, px, py) ? sample(g, px, py) : -1;
  }
  const step = (c: number): number | null => {
    let inside = 0;
    let outside = 0;
    for (let k = 1; k <= WING; k++) {
      if (profile[c - k] < 0 || profile[c + k] < 0) return null;
      inside += profile[c - k];
      outside += profile[c + k];
    }
    inside /= WING;
    return inside < paper * INSIDE_MIN_LEVEL ? null : inside - outside / WING;
  };
  let best = MIN_CONTRAST;
  let at = -1;
  for (let c = WING; c < length - WING; c++) {
    const value = step(c);
    if (value !== null && value > best) {
      best = value;
      at = c;
    }
  }
  if (at < 0) return null;
  // A parabola through the peak gives sub-pixel precision, which is what keeps the overlay still.
  const before = step(at - 1) ?? best;
  const after = step(at + 1) ?? best;
  const curve = before - 2 * best + after;
  const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * curve))) : 0;
  return at - radius - WING + shift;
}

type Hit = Pt & { t: number };

function sideHits(g: Gray, a: Pt, b: Pt, radius: number, paper: number): { hits: Hit[]; samples: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = dy / length;
  const ny = -dx / length;
  const samples = Math.max(12, Math.min(48, Math.round(length / 5)));
  const hits: Hit[] = [];
  for (let i = 0; i < samples; i++) {
    const t = 0.04 + (0.92 * (i + 0.5)) / samples;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const offset = edgeOffset(g, x, y, nx, ny, radius, paper);
    if (offset !== null) hits.push({ x: x + nx * offset, y: y + ny * offset, t });
  }
  return { hits, samples };
}

// A hand or a shadow adds stray points; the paper edge is the largest straight run.
function straightRun(hits: Hit[]): Hit[] {
  let best: Hit[] = [];
  let seed = 12345;
  const pick = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % hits.length;
  for (let k = 0; k < 48 && hits.length >= 2; k++) {
    const p = hits[pick()];
    const q = hits[pick()];
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length < 4) continue;
    const nx = (q.y - p.y) / length;
    const ny = -(q.x - p.x) / length;
    const inliers = hits.filter((h) => Math.abs((h.x - p.x) * nx + (h.y - p.y) * ny) < LINE_TOLERANCE);
    if (inliers.length > best.length) best = inliers;
  }
  return best;
}

type Row = { side: number; t: number; nx: number; ny: number; d: number };

export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    const div = A[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / div;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / (A[i][i] || 1e-9));
}

// Moves the corners so every side lands on its edge points. A side hidden under an arm has no
// evidence, so two weak terms fill in: the quad keeps its shape under any affine motion
// (translation, rotation, zoom) and corners tend to move together.
function cornerShift(rows: Row[]): number[] {
  const A = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const b = new Array<number>(8).fill(0);
  for (const r of rows) {
    const a = r.side * 2;
    const c = ((r.side + 1) % 4) * 2;
    const idx = [a, a + 1, c, c + 1];
    const coef = [(1 - r.t) * r.nx, (1 - r.t) * r.ny, r.t * r.nx, r.t * r.ny];
    for (let i = 0; i < 4; i++) {
      b[idx[i]] += coef[i] * r.d;
      for (let j = 0; j < 4; j++) A[idx[i]][idx[j]] += coef[i] * coef[j];
    }
  }
  const follow = 0.02;
  const keepShape = 0.5;
  const alternate = [1, -1, 1, -1];
  for (let i = 0; i < 8; i++) {
    A[i][i] += 0.01 + 3 * follow;
    for (let j = 0; j < 8; j++) {
      if (i % 2 !== j % 2) continue;
      if (i !== j) A[i][j] -= follow;
      A[i][j] += keepShape * alternate[i >> 1] * alternate[j >> 1];
    }
  }
  return solve(A, b);
}

export const area = (q: Pt[]) => Math.abs(signedArea(q));

function signedArea(q: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < q.length; i++) {
    const j = (i + 1) % q.length;
    sum += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return sum / 2;
}

function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = Math.sign((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (cross === 0 || (sign !== 0 && cross !== sign)) return false;
    sign = cross;
  }
  return true;
}

// Refines `prior` against the image. Works with as few as two visible sides.
export function fitQuad(g: Gray, prior: Quad, radius: number, paper: number): Fit | null {
  let quad = prior;
  let sides = 0;
  let support = 0;
  for (const search of [radius, 6, 3]) {
    const rows: Row[] = [];
    sides = 0;
    let used = 0;
    let total = 0;
    for (let side = 0; side < 4; side++) {
      const a = quad[side];
      const b = quad[(side + 1) % 4];
      const { hits, samples } = sideHits(g, a, b, search, paper);
      total += samples;
      const run = straightRun(hits);
      if (run.length < Math.max(6, samples * 0.18)) continue;
      const ts = run.map((h) => h.t);
      if (Math.max(...ts) - Math.min(...ts) < MIN_SIDE_SPAN) continue;
      sides++;
      used += run.length;
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = (b.y - a.y) / length;
      const ny = -(b.x - a.x) / length;
      for (const h of run) rows.push({ side, t: h.t, nx, ny, d: (h.x - a.x) * nx + (h.y - a.y) * ny });
    }
    support = used / total;
    if (sides < 2) return null;
    const shift = cornerShift(rows);
    quad = quad.map((p, i) => ({ x: p.x + shift[i * 2], y: p.y + shift[i * 2 + 1] })) as Quad;
    if (!isConvex(quad)) return null;
  }
  const ratio = area(quad) / (area(prior) || 1);
  return ratio > 0.4 && ratio < 2.5 ? { quad, sides, support } : null;
}

function otsu(values: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (const v of values) histogram[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let weight = 0;
  let below = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    weight += histogram[i];
    if (!weight || weight === values.length) continue;
    below += i * histogram[i];
    const meanLow = below / weight;
    const meanHigh = (sum - below) / (values.length - weight);
    const between = weight * (values.length - weight) * (meanLow - meanHigh) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

function percentile(values: Uint8Array, share: number): number {
  const histogram = new Array<number>(256).fill(0);
  for (const v of values) histogram[v]++;
  let seen = 0;
  for (let i = 0; i < 256; i++) {
    seen += histogram[i];
    if (seen >= values.length * share) return i;
  }
  return 255;
}

function largestBlob(values: Uint8Array, w: number, h: number, threshold: number): { pixels: Int32Array; size: number; level: number } | null {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: Int32Array | null = null;
  let bestSize = 0;
  const blob = new Int32Array(w * h);
  for (let start = 0; start < values.length; start++) {
    if (seen[start] || values[start] <= threshold) continue;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      blob[size++] = i;
      const x = i % w;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (n >= 0 && n < values.length && !seen[n] && values[n] > threshold) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = blob.slice(0, size);
    }
  }
  if (!best) return null;
  let total = 0;
  for (const i of best) total += values[i];
  return { pixels: best, size: bestSize, level: total / bestSize };
}

function convexHull(points: Pt[]): Pt[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

// Drops the vertex whose removal loses the least area until only the four real corners remain.
function toFourCorners(hull: Pt[]): Quad | null {
  const pts = [...hull];
  while (pts.length > 4) {
    let least = Infinity;
    let at = 0;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const loss = area([prev, pts[i], next]);
      if (loss < least) {
        least = loss;
        at = i;
      }
    }
    pts.splice(at, 1);
  }
  if (pts.length !== 4) return null;
  if (signedArea(pts) < 0) pts.reverse();
  let first = 0;
  for (let i = 1; i < 4; i++) if (pts[i].x + pts[i].y < pts[first].x + pts[first].y) first = i;
  return [pts[first], pts[(first + 1) % 4], pts[(first + 2) % 4], pts[(first + 3) % 4]];
}

// Width over height of the real sheet, undoing perspective with a typical phone focal length.
export function estimateAspect(q: Quad, width: number, height: number): number {
  const f = Math.max(width, height) * 1.1;
  const ray = (p: Pt) => [p.x - width / 2, p.y - height / 2, f];
  const [m1, m2, m4, m3] = q.map(ray); // top-left, top-right, bottom-right, bottom-left
  const det = (a: number[], b: number[], c: number[]) =>
    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const k2 = det(m1, m4, m3) / det(m2, m4, m3);
  const k3 = det(m1, m4, m2) / det(m3, m4, m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  return Math.hypot(...n2) / Math.hypot(...n3);
}

export function rotateQuad(q: Quad, turns: number): Quad {
  return [q[turns % 4], q[(turns + 1) % 4], q[(turns + 2) % 4], q[(turns + 3) % 4]];
}

// Whole-image search, used before locking and whenever the sheet has been lost.
export function findSheet(g: Gray, minSides: number): Found | null {
  const f = Math.max(1, Math.round(g.width / SMALL_WIDTH));
  const w = Math.floor(g.width / f);
  const h = Math.floor(g.height / f);
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += g.data[(y * f + j) * g.width + x * f + i];
      small[y * w + x] = sum / (f * f);
    }
  }
  const low = otsu(small);
  let best: Found | null = null;
  for (const threshold of [low, (low + percentile(small, 0.97)) / 2]) {
    const blob = largestBlob(small, w, h, threshold);
    if (!blob || blob.size < w * h * MIN_AREA || blob.size > w * h * 0.92) continue;
    const member = new Uint8Array(w * h);
    for (const i of blob.pixels) member[i] = 1;
    const edge: Pt[] = [];
    let cut = 0;
    for (const i of blob.pixels) {
      const x = i % w;
      const y = (i - x) / w;
      const onFrame = !x || !y || x === w - 1 || y === h - 1;
      if (onFrame) cut++;
      if (onFrame || !member[i - 1] || !member[i + 1] || !member[i - w] || !member[i + w]) {
        edge.push({ x: (x + 0.5) * f, y: (y + 0.5) * f });
      }
    }
    // Half an A4 has the proportions of an A4 lying on its side, so a sheet cut by the frame
    // would pass for a whole one turned a quarter.
    if (cut > MAX_CUT_CELLS) continue;
    const corners = toFourCorners(convexHull(edge));
    if (!corners) continue;
    const fit = fitQuad(g, corners, f * 2 + 4, blob.level);
    if (!fit || fit.sides < minSides) continue;
    const inside = fit.quad.every(
      (p) => p.x > FRAME_MARGIN && p.y > FRAME_MARGIN && p.x < g.width - FRAME_MARGIN && p.y < g.height - FRAME_MARGIN,
    );
    const aspect = estimateAspect(fit.quad, g.width, g.height);
    const longToShort = Math.max(aspect, 1 / aspect);
    if (!inside || longToShort < MIN_LONG_TO_SHORT || longToShort > MAX_LONG_TO_SHORT) continue;
    if (!best || fit.support > best.support) best = { ...fit, paperLevel: blob.level };
  }
  return best;
}

// Thin dark strokes on the sheet, in sheet coordinates. Large dark areas such as a hand only
// leave an outline here, and that outline fades out of the running average.
export function inkMap(g: Gray, quad: Quad): Float32Array {
  const H = fromQuad(
    [{ x: 0, y: 0 }, { x: PATCH_W, y: 0 }, { x: PATCH_W, y: PATCH_H }, { x: 0, y: PATCH_H }],
    quad,
  );
  const stride = PATCH_W + 1;
  const integral = new Float64Array(stride * (PATCH_H + 1));
  const patch = new Float32Array(PATCH_W * PATCH_H);
  for (let y = 0; y < PATCH_H; y++) {
    let row = 0;
    for (let x = 0; x < PATCH_W; x++) {
      const p = apply(H, { x: x + 0.5, y: y + 0.5 });
      const value = inFrame(g, p.x, p.y) ? sample(g, p.x, p.y) : 0;
      patch[y * PATCH_W + x] = value;
      row += value;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const out = new Float32Array((PATCH_W >> 1) * (PATCH_H >> 1));
  // The margin keeps the table, just past the edge of the sheet, from reading as ink.
  for (let y = INK_MARGIN; y < PATCH_H - INK_MARGIN; y++) {
    const y0 = Math.max(0, y - INK_BLUR);
    const y1 = Math.min(PATCH_H, y + INK_BLUR + 1);
    for (let x = INK_MARGIN; x < PATCH_W - INK_MARGIN; x++) {
      const x0 = Math.max(0, x - INK_BLUR);
      const x1 = Math.min(PATCH_W, x + INK_BLUR + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      const dark = sum / ((x1 - x0) * (y1 - y0)) - patch[y * PATCH_W + x] - INK_MIN_DARKNESS;
      if (dark > 0) out[(y >> 1) * (PATCH_W >> 1) + (x >> 1)] += dark;
    }
  }
  return out;
}

export function hasInk(map: Float32Array): boolean {
  let marked = 0;
  for (const v of map) if (v > INK_MIN_DARKNESS * 4) marked++;
  return marked > map.length * INK_MIN_SHARE;
}

function soften(map: Float32Array): Float32Array {
  const w = PATCH_W >> 1;
  const h = PATCH_H >> 1;
  const out = new Float32Array(map.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - INK_SOFTEN);
    const y1 = Math.min(h - 1, y + INK_SOFTEN);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - INK_SOFTEN);
      const x1 = Math.min(w - 1, x + INK_SOFTEN);
      let sum = 0;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) sum += map[j * w + i];
      out[y * w + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

function correlation(a: Float32Array, b: Float32Array, reverse: boolean): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[reverse ? n - 1 - i : i] - meanB;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return ab / (Math.sqrt(aa * bb) || 1);
}

export type InkReading = { known: boolean; upsideDown: boolean | null };

// Null when either map is blank. `known` says the drawing is the remembered one, either way
// round; `upsideDown` stays null when that drawing cannot tell which way round it is.
export function readInk(memory: Float32Array, current: Float32Array): InkReading | null {
  if (!hasInk(memory) || !hasInk(current)) return null;
  const remembered = soften(memory);
  const seen = soften(current);
  const same = correlation(remembered, seen, false);
  const flipped = correlation(remembered, seen, true);
  const known = Math.max(same, flipped) >= INK_MIN_MATCH;
  return { known, upsideDown: known && Math.abs(same - flipped) >= INK_MIN_LEAD ? flipped > same : null };
}
