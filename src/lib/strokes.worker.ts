import { apply, invert, maxDistance, mul, IDENTITY, type Mat3 } from './homography';
import { toWhiteness } from './sheet';
import { MIN_POINTS, fieldOf, imageLines, locate, strokesIn, type Field, type Match, type Strokes } from './strokes';

export type StrokeRequest =
  | { type: 'image'; width: number; height: number; data: ArrayBuffer; bitmapWidth: number }
  | { type: 'frame'; width: number; height: number; data: ArrayBuffer; pose: Mat3 }
  | { type: 'rebase' };

export type StrokeResponse = { type: 'idle' } | { type: 'moved'; transform: Mat3; source: 'trazos' | 'imagen' };

const SMALL_STEP = 8; // pixels of the frame per pixel of the map that detects motion
const MOTION = 2.5;
const STILL_READINGS = 3;
const SAME_PLACE = 3; // pixels
const MIN_OVERLAP = 0.6;
const MIN_SHIFT = 2; // pixels: less than this and the image already lies on the drawing
const MEMORY = { tolerance: 3.5, minScore: 0.7 }; // thick lines shift their middle a little when turned
const IMAGE = { tolerance: 5, minScore: 0.76 }; // a drawing in progress strays from the image

type Rest = { strokes: Strokes; field: Field };

let image: { field: Field; scale: number } | null = null;
let rest: Rest | null = null;
let last: Float32Array | null = null;
let stillReadings = 0;
let failedAt: Mat3 | null = null; // the image's pose when the strokes could not be placed
let rebasing = false;

function thumbnail(data: Uint8Array, width: number, height: number): Float32Array {
  const w = Math.floor(width / SMALL_STEP);
  const h = Math.floor(height / SMALL_STEP);
  const small = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) small[y * w + x] = data[(y * SMALL_STEP + 4) * width + x * SMALL_STEP + 4];
  }
  return small;
}

function moving(small: Float32Array): boolean {
  const before = last;
  last = small;
  if (!before || before.length !== small.length) return true;
  let change = 0;
  for (let i = 0; i < small.length; i++) change += Math.abs(small[i] - before[i]);
  return change / small.length > MOTION;
}

function remember(strokes: Strokes, width: number, height: number): void {
  rest = { strokes, field: fieldOf(strokes.lines, width, height) };
  failedAt = null;
  rebasing = false;
}

function overlap(strokes: Strokes, field: Field): number {
  const { width, distance } = field.fine;
  let near = 0;
  for (const p of strokes.points) if (distance[p.y * width + p.x] <= SAME_PLACE) near++;
  return near / strokes.points.length;
}

// The strokes seen before are the same marks, so they place the sheet exactly and keep any
// distance the user left between image and drawing. The image also covers what was out of view.
function placeAgain(strokes: Strokes, pose: Mat3): { match: Match; start: Mat3; source: 'trazos' | 'imagen' } | null {
  const seen = rest && locate(strokes.points, IDENTITY, { field: rest.field, ...MEMORY });
  if (seen) return { match: seen, start: IDENTITY, source: 'trazos' };
  if (!image) return null;
  const { field, scale } = image;
  const start = mul([scale, 0, 0, 0, scale, 0, 0, 0, 1], invert(pose));
  const placed = locate(strokes.points, start, { field, ...IMAGE });
  return placed && { match: placed, start, source: 'imagen' };
}

function moves(transform: Mat3, width: number, height: number): boolean {
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  return maxDistance(corners, corners.map((p) => apply(transform, p))) > MIN_SHIFT;
}

function onFrame(data: Uint8Array, width: number, height: number, pose: Mat3): StrokeResponse {
  const g = toWhiteness(data, width, height);
  if (moving(thumbnail(g.data, width, height))) {
    stillReadings = 0;
    failedAt = null; // the sheet may come back readable, so it gets another try once it rests
    return { type: 'idle' };
  }
  if (++stillReadings < STILL_READINGS) return { type: 'idle' };
  const strokes = strokesIn(g);
  if (strokes.points.length < MIN_POINTS) return { type: 'idle' };
  const known = !!rest && rest.strokes.points.length >= MIN_POINTS;
  if (rebasing || (known && overlap(strokes, rest!.field) >= MIN_OVERLAP)) {
    remember(strokes, width, height);
    return { type: 'idle' };
  }
  if (failedAt) {
    // The user placed the image by hand after the strokes could not: that placement now counts.
    if (failedAt.some((v, i) => Math.abs(v - pose[i]) > 1e-6)) remember(strokes, width, height);
    return { type: 'idle' };
  }
  const found = placeAgain(strokes, pose);
  if (!found) {
    if (known) failedAt = pose;
    else remember(strokes, width, height);
    return { type: 'idle' };
  }
  remember(strokes, width, height);
  const transform = mul(invert(found.match.map), found.start);
  return moves(transform, width, height) ? { type: 'moved', transform, source: found.source } : { type: 'idle' };
}

self.onmessage = (e: MessageEvent<StrokeRequest>) => {
  const msg = e.data;
  if (msg.type === 'image') {
    const { width, height } = msg;
    image = { field: fieldOf(imageLines(new Uint8ClampedArray(msg.data), width, height), width, height), scale: width / msg.bitmapWidth };
  } else if (msg.type === 'rebase') {
    rebasing = true;
  } else {
    self.postMessage(onFrame(new Uint8Array(msg.data), msg.width, msg.height, msg.pose));
  }
};
