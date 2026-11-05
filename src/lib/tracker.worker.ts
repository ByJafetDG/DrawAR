import cvModule from '@techstark/opencv-js';

export type Frame = { width: number; height: number; data: ArrayBuffer };

export type TrackerRequest =
  | ({ type: 'analyze' } & Frame)
  | ({ type: 'reference' } & Frame)
  | ({ type: 'track' } & Frame)
  | ({ type: 'cutout'; rect: { x: number; y: number; width: number; height: number } } & Frame);

export type TrackerResponse =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'cutout'; mask: ArrayBuffer }
  | { type: 'analysis'; features: number; coverage: number }
  | { type: 'reference'; features: number; coverage: number }
  | { type: 'pose'; homography: number[] | null; inliers: number; matches: number; ms: number };

const MAX_FEATURES = 1000;
const RATIO = 0.85;
const MIN_INLIERS = 12;
const COVERAGE_CELLS = 4;
const STABLE_MAX_MOVE = 5; // frame pixels between two analysis frames
const CUTOUT_ROUNDS = 4;
const MIN_INLIER_CELLS = 3;
const MIN_INLIER_AREA = 0.15; // bounding box of the inliers, as a share of the reference

// opencv.js ships without usable types for most of this API.
let cv: any;
let orb: any;
let matcher: any;
let clahe: any;

let previous: { points: Float32Array; descriptors: any } | null = null;
let refPoints: Float32Array | null = null;
let refDescriptors: any = null;
let refSize = { width: 0, height: 0 };

async function loadCv() {
  const mod = cvModule as any;
  if (mod instanceof Promise) return await mod;
  if (mod.Mat) return mod;
  await new Promise<void>((resolve) => {
    mod.onRuntimeInitialized = () => resolve();
  });
  return mod;
}

function grayFrom(frame: Frame) {
  const rgba = new cv.Mat(frame.height, frame.width, cv.CV_8UC4);
  rgba.data.set(new Uint8Array(frame.data));
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  // Blur first: equalization would otherwise turn sensor noise into fake corners.
  const smooth = new cv.Mat();
  cv.GaussianBlur(gray, smooth, new cv.Size(5, 5), 0);
  gray.delete();
  // Pencil marks on paper are low contrast; local equalization gives ORB more corners.
  const boosted = new cv.Mat();
  clahe.apply(smooth, boosted);
  smooth.delete();
  return boosted;
}

function detect(frame: Frame) {
  const gray = grayFrom(frame);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const noMask = new cv.Mat();
  orb.detectAndCompute(gray, noMask, keypoints, descriptors);
  noMask.delete();
  gray.delete();
  const points = new Float32Array(keypoints.size() * 2);
  for (let i = 0; i < keypoints.size(); i++) {
    const { pt } = keypoints.get(i);
    points[i * 2] = pt.x;
    points[i * 2 + 1] = pt.y;
  }
  keypoints.delete();
  return { points, descriptors };
}

// Share of the image that has features. Corners clustered in one spot make a shaky homography.
function coverage(points: Float32Array, frame: Frame): number {
  const cells = new Set<number>();
  for (let i = 0; i < points.length; i += 2) {
    const cx = Math.floor((points[i] / frame.width) * COVERAGE_CELLS);
    const cy = Math.floor((points[i + 1] / frame.height) * COVERAGE_CELLS);
    cells.add(cy * COVERAGE_CELLS + cx);
  }
  return cells.size / (COVERAGE_CELLS * COVERAGE_CELLS);
}

// Keeps the points that reappear in the same place as in the previous frame. Noise does not
// repeat between frames, so this is what tells a marked sheet from a blank one.
function stablePoints(points: Float32Array, descriptors: any): Float32Array {
  if (!previous || descriptors.rows < 2 || previous.descriptors.rows < 2) return new Float32Array();
  const pairs = new cv.DMatchVectorVector();
  matcher.knnMatch(descriptors, previous.descriptors, pairs, 2);
  const stable: number[] = [];
  for (let i = 0; i < pairs.size(); i++) {
    const pair = pairs.get(i);
    if (pair.size() >= 2) {
      const best = pair.get(0);
      const second = pair.get(1);
      const x = points[best.queryIdx * 2];
      const y = points[best.queryIdx * 2 + 1];
      const moved = Math.hypot(x - previous.points[best.trainIdx * 2], y - previous.points[best.trainIdx * 2 + 1]);
      if (best.distance < RATIO * second.distance && moved < STABLE_MAX_MOVE) stable.push(x, y);
    }
    pair.delete();
  }
  pairs.delete();
  return Float32Array.from(stable);
}

function isConvex(q: number[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = [q[i * 2], q[i * 2 + 1]];
    const [bx, by] = [q[((i + 1) % 4) * 2], q[((i + 1) % 4) * 2 + 1]];
    const [cx, cy] = [q[((i + 2) % 4) * 2], q[((i + 2) % 4) * 2 + 1]];
    const cross = Math.sign((bx - ax) * (cy - by) - (by - ay) * (cx - bx));
    if (cross === 0 || (sign !== 0 && cross !== sign)) return false;
    sign = cross;
  }
  return true;
}

function isSaneHomography(h: number[], frame: Frame): boolean {
  const { width: w, height: rh } = refSize;
  const quad: number[] = [];
  for (const [x, y] of [[0, 0], [w, 0], [w, rh], [0, rh]]) {
    const d = h[6] * x + h[7] * y + h[8];
    if (d <= 0) return false;
    quad.push((h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d);
  }
  if (!isConvex(quad)) return false;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += quad[i * 2] * quad[j * 2 + 1] - quad[j * 2] * quad[i * 2 + 1];
  }
  const ratio = Math.abs(area / 2) / (frame.width * frame.height);
  return ratio > 0.03 && ratio < 30;
}

// Inliers packed on one mark fit that mark and extrapolate badly over the rest of the sheet,
// however many there are. They must span several zones of the reference.
function isWellSpread(from: number[], mask: Uint8Array): boolean {
  const cells = new Set<number>();
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = from[i * 2];
    const y = from[i * 2 + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    cells.add(Math.floor((y / refSize.height) * COVERAGE_CELLS) * COVERAGE_CELLS + Math.floor((x / refSize.width) * COVERAGE_CELLS));
  }
  const area = ((maxX - minX) * (maxY - minY)) / (refSize.width * refSize.height);
  return cells.size >= MIN_INLIER_CELLS && area >= MIN_INLIER_AREA;
}

function track(frame: Frame): TrackerResponse {
  const start = performance.now();
  const { points, descriptors } = detect(frame);
  const lost = (matches: number): TrackerResponse => ({
    type: 'pose',
    homography: null,
    inliers: 0,
    matches,
    ms: performance.now() - start,
  });
  if (!refPoints || descriptors.rows < MIN_INLIERS) {
    descriptors.delete();
    return lost(0);
  }

  const pairs = new cv.DMatchVectorVector();
  matcher.knnMatch(refDescriptors, descriptors, pairs, 2);
  descriptors.delete();
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < pairs.size(); i++) {
    const pair = pairs.get(i);
    if (pair.size() >= 2) {
      const best = pair.get(0);
      const second = pair.get(1);
      if (best.distance < RATIO * second.distance) {
        from.push(refPoints[best.queryIdx * 2], refPoints[best.queryIdx * 2 + 1]);
        to.push(points[best.trainIdx * 2], points[best.trainIdx * 2 + 1]);
      }
    }
    pair.delete();
  }
  pairs.delete();

  const matches = from.length / 2;
  if (matches < MIN_INLIERS) return lost(matches);

  const fromMat = cv.matFromArray(matches, 1, cv.CV_32FC2, from);
  const toMat = cv.matFromArray(matches, 1, cv.CV_32FC2, to);
  const mask = new cv.Mat();
  const result = cv.findHomography(fromMat, toMat, cv.RANSAC, 3, mask);
  const inliers = cv.countNonZero(mask);
  const homography: number[] | null = result.rows === 3 ? Array.from(result.data64F as Float64Array) : null;
  const spread = homography ? isWellSpread(from, mask.data as Uint8Array) : false;
  fromMat.delete();
  toMat.delete();
  mask.delete();
  result.delete();

  if (!homography || inliers < MIN_INLIERS || !spread || !isSaneHomography(homography, frame)) return lost(matches);
  return { type: 'pose', homography, inliers, matches, ms: performance.now() - start };
}

// Separates the subject inside `rect` from its background. Returns one byte per pixel.
function cutout(msg: Extract<TrackerRequest, { type: 'cutout' }>): TrackerResponse {
  const rgba = new cv.Mat(msg.height, msg.width, cv.CV_8UC4);
  rgba.data.set(new Uint8Array(msg.data));
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  const mask = new cv.Mat();
  const background = new cv.Mat();
  const foreground = new cv.Mat();
  const { x, y, width, height } = msg.rect;
  cv.grabCut(rgb, mask, new cv.Rect(x, y, width, height), background, foreground, CUTOUT_ROUNDS, cv.GC_INIT_WITH_RECT);
  const out = new Uint8Array(msg.width * msg.height);
  const labels = mask.data as Uint8Array;
  for (let i = 0; i < out.length; i++) out[i] = labels[i] === cv.GC_FGD || labels[i] === cv.GC_PR_FGD ? 255 : 0;
  for (const mat of [rgb, mask, background, foreground]) mat.delete();
  return { type: 'cutout', mask: out.buffer };
}

function handle(msg: TrackerRequest): TrackerResponse {
  if (msg.type === 'track') return track(msg);
  if (msg.type === 'cutout') return cutout(msg);
  const { points, descriptors } = detect(msg);
  const stable = stablePoints(points, descriptors);
  const features = stable.length / 2;
  const share = coverage(stable, msg);
  previous?.descriptors.delete();
  if (msg.type === 'analyze') {
    previous = { points, descriptors };
    return { type: 'analysis', features, coverage: share };
  }
  previous = null;
  refDescriptors?.delete();
  refDescriptors = descriptors;
  refPoints = points;
  refSize = { width: msg.width, height: msg.height };
  return { type: 'reference', features, coverage: share };
}

const post = (msg: TrackerResponse) => self.postMessage(msg);

const ready = loadCv().then((loaded) => {
  cv = loaded;
  // Low FAST threshold and small borders: marks are faint and often sit near the frame edge.
  orb = new cv.ORB(MAX_FEATURES, 1.2, 8, 19, 0, 2, 0, 19, 8);
  matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
  post({ type: 'ready' });
});

self.onmessage = async (e: MessageEvent<TrackerRequest>) => {
  try {
    await ready;
    post(handle(e.data));
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

ready.catch((err) => post({ type: 'error', message: String(err) }));
