import type { Pt } from './homography';
import {
  area,
  estimateAspect,
  findSheet,
  fitQuad,
  hasInk,
  inkMap,
  readInk,
  rotateQuad,
  toWhiteness,
  type Found,
  type Gray,
  type Quad,
} from './sheet';

export type Frame = { width: number; height: number; data: ArrayBuffer };

export type SheetRequest =
  | ({ type: 'find' } & Frame)
  | ({ type: 'lock' } & Frame)
  | ({ type: 'track' } & Frame)
  | { type: 'resume'; ink: Float32Array; aspect: number }
  | { type: 'snapshot' };

export type SheetResponse =
  | { type: 'found'; quad: Pt[] | null }
  | { type: 'locked'; quad: Pt[] | null; aspect: number; recognized: boolean | null }
  | { type: 'pose'; quad: Pt[] | null; sides: number; returned: boolean; turned: boolean; ms: number }
  | { type: 'snapshot'; ink: Float32Array; aspect: number };

const SEARCH_RADIUS = 30;
const INK_UPDATE_EVERY = 8; // frames
const INK_FOLLOW = 0.15;
const UPSIDE_DOWN_READINGS = 2;
const ASPECT_TOLERANCE = 0.25; // log of the ratio to the remembered proportions
const ASPECT_MARGIN = 0.1; // orientations this close in shape cannot be told apart by shape
const SHAPE_TOLERANCE = 0.35; // a tracked quad this far off is not following the real sheet
const FRAME_MARGIN = 3;
const SETTLE_FRAMES = 4; // a returning sheet must hold still this long before it is believed
const STILL_PIXELS = 6;
const PATIENCE_FRAMES = 30; // how long unreadable ink can delay a sheet that has settled
const MIN_AREA_CHANGE = 0.55; // a sheet half hidden by an arm looks like a smaller one on its side
const MAX_AREA_CHANGE = 1.8;

type Known = { ink: Float32Array; aspect: number };
type Placed = { quad: Quad; turned: boolean };

let quad: Quad | null = null;
let settled: Quad | null = null; // last pose seen with all four sides: says which way is up
let arrival: { quad: Quad; frames: number } | null = null;
let saved: Known | null = null;
let aspect = 1;
let paperLevel = 200;
let memory: Float32Array | null = null;
let lastFound: Found | null = null;
let goodFrames = 0;
let upsideDownReadings = 0;
let lost = false;

function blend(ink: Float32Array) {
  if (!memory) {
    memory = ink;
    return;
  }
  for (let i = 0; i < ink.length; i++) memory[i] += (ink[i] - memory[i]) * INK_FOLLOW;
}

const drawn = () => !!memory && hasInk(memory);

// A half turn barely changes the outline, so the edges alone can miss it. The ink cannot: if it
// reads upside down twice in a row the sheet turns. Only ink that matches is remembered, since a
// hand or a wrong pose would otherwise overwrite the very thing that can correct it.
function reviewInk(g: Gray): boolean {
  const ink = inkMap(g, quad!);
  const reading = memory && readInk(memory, ink);
  if (reading?.upsideDown) {
    if (++upsideDownReadings < UPSIDE_DOWN_READINGS) return false;
    upsideDownReadings = 0;
    quad = settled = rotateQuad(quad!, 2);
    return true;
  }
  upsideDownReadings = 0;
  if (!drawn() || reading?.known) blend(ink);
  return false;
}

function orientations(q: Quad, g: Gray, wanted: number): Quad[] {
  const turns = [0, 1, 2, 3].map((t) => rotateQuad(q, t));
  const off = turns.map((t) => Math.abs(Math.log(estimateAspect(t, g.width, g.height) / wanted)));
  const best = Math.min(...off);
  return best < ASPECT_TOLERANCE ? turns.filter((_, i) => off[i] < best + ASPECT_MARGIN) : [];
}

const heading = (q: Quad) => Math.atan2(q[1].y - q[0].y + q[2].y - q[3].y, q[1].x - q[0].x + q[2].x - q[3].x);

function turnFrom(q: Quad, reference: Quad): number {
  const difference = heading(q) - heading(reference);
  return Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)));
}

const center = (q: Quad): Pt => ({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 });

function holdsStill(previous: Quad, next: Quad): boolean {
  const a = center(previous);
  const b = center(next);
  return Math.hypot(a.x - b.x, a.y - b.y) < STILL_PIXELS && Math.abs(area(next) / area(previous) - 1) < 0.1;
}

// Decides where a sheet seen by the full search really is. One that was lost has to be whole and
// hold still first. Its drawing then says which way round it is; if there is none it stays the
// way it was, and if the drawing cannot be read yet it gets more time before that same guess.
function settle(found: Found, g: Gray): Placed | null {
  const frames = arrival && holdsStill(arrival.quad, found.quad) ? arrival.frames + 1 : 1;
  arrival = { quad: found.quad, frames };
  if (lost && frames < SETTLE_FRAMES) return null;
  const reference = settled ?? quad!;
  const change = area(found.quad) / area(reference);
  if (lost && frames < PATIENCE_FRAMES && (change < MIN_AREA_CHANGE || change > MAX_AREA_CHANGE)) return null;
  const fits = orientations(found.quad, g, aspect);
  if (!fits.length) return null;
  const nearest = fits.reduce((a, b) => (turnFrom(b, reference) < turnFrom(a, reference) ? b : a));
  if (!drawn()) return { quad: nearest, turned: false };
  const reading = readInk(memory!, inkMap(g, nearest));
  if (reading?.known) return reading.upsideDown ? { quad: rotateQuad(nearest, 2), turned: true } : { quad: nearest, turned: false };
  return frames < PATIENCE_FRAMES ? null : { quad: nearest, turned: false };
}

const isWhole = (q: Quad, g: Gray) =>
  q.every((p) => p.x > FRAME_MARGIN && p.y > FRAME_MARGIN && p.x < g.width - FRAME_MARGIN && p.y < g.height - FRAME_MARGIN);

function keepsShape(q: Quad, g: Gray): boolean {
  return !isWhole(q, g) || Math.abs(Math.log(estimateAspect(q, g.width, g.height) / aspect)) < SHAPE_TOLERANCE;
}

function track(g: Gray): SheetResponse {
  const start = performance.now();
  const answer = (sides: number, returned: boolean, turned: boolean): SheetResponse => ({
    type: 'pose',
    quad: sides ? quad : null,
    sides,
    returned,
    turned,
    ms: performance.now() - start,
  });
  const fit = lost ? null : fitQuad(g, quad!, SEARCH_RADIUS, paperLevel);
  if (fit && fit.sides >= 3 && keepsShape(fit.quad, g)) {
    quad = fit.quad;
    arrival = null;
    if (fit.sides === 4) settled = quad;
    const turned = ++goodFrames % INK_UPDATE_EVERY === 0 && reviewInk(g);
    return answer(fit.sides, turned, turned);
  }
  // Two sides may be a heavily covered sheet or a sheet that jumped: a full search tells them apart.
  const found = findSheet(g, 3);
  const placed = found && settle(found, g);
  if (!found || !placed) {
    if (fit) {
      quad = fit.quad;
      return answer(fit.sides, false, false);
    }
    lost = true;
    return answer(0, false, false);
  }
  const wasLost = lost;
  lost = false;
  arrival = null;
  quad = settled = placed.quad;
  paperLevel = found.paperLevel;
  return answer(found.sides, wasLost, placed.turned);
}

// Locking onto a sheet already known, after a rescan or on another day. The saved ink says which
// way round it is, so the image lands where it was instead of following the camera angle.
function relock(found: Found, g: Gray, known: Known): { quad: Quad; recognized: boolean | null } | null {
  const fits = orientations(found.quad, g, known.aspect);
  if (!fits.length) return null;
  const reading = readInk(known.ink, inkMap(g, fits[0]));
  if (!reading?.known) return { quad: fits[0], recognized: hasInk(known.ink) ? false : null };
  return { quad: reading.upsideDown ? rotateQuad(fits[0], 2) : fits[0], recognized: true };
}

function lock(g: Gray, found: Found | null): SheetResponse {
  const chosen = found ?? lastFound;
  if (!chosen) return { type: 'locked', quad: null, aspect: 1, recognized: null };
  const known = saved ?? (memory ? { ink: memory, aspect } : null);
  const placed = known && relock(chosen, g, known);
  quad = settled = placed ? placed.quad : chosen.quad;
  paperLevel = chosen.paperLevel;
  lost = false;
  goodFrames = 0;
  arrival = null;
  saved = null;
  if (placed) {
    // A different drawing means a different sheet, and this pose is the one that counts now.
    memory = placed.recognized === false ? null : known.ink;
    aspect = known.aspect;
  } else {
    aspect = estimateAspect(quad, g.width, g.height);
    memory = null;
  }
  blend(inkMap(g, quad));
  return { type: 'locked', quad, aspect, recognized: placed ? placed.recognized : null };
}

function handle(msg: Exclude<SheetRequest, { type: 'resume' | 'snapshot' }>): SheetResponse {
  const g = toWhiteness(new Uint8Array(msg.data), msg.width, msg.height);
  if (msg.type === 'track') return track(g);
  const found = findSheet(g, 4);
  if (msg.type === 'lock') return lock(g, found);
  lastFound = found ?? lastFound;
  return { type: 'found', quad: found?.quad ?? null };
}

self.onmessage = (e: MessageEvent<SheetRequest>) => {
  const msg = e.data;
  if (msg.type === 'resume') {
    saved = { ink: msg.ink, aspect: msg.aspect };
  } else if (msg.type === 'snapshot') {
    if (memory) self.postMessage({ type: 'snapshot', ink: memory.slice(), aspect } satisfies SheetResponse);
  } else {
    self.postMessage(handle(msg));
  }
};
