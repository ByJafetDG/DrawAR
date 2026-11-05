import { maxDistance, type Pt } from './homography';

const STILL_PIXELS = 2.5; // frame pixels between readings of a sheet lying on the table
const REST_MS = 700;
const MIN_SHIFT = 5; // frame pixels: anything smaller is reading noise, not a moved sheet

export type Move = { from: Pt[]; to: Pt[] };

// Remembers where the sheet last lay still. When it lies still somewhere else, that is a move to
// follow, however it got there: lifted away and put back, or just bumped.
export class RestWatch {
  private home: Pt[] | null = null;
  private candidate: Pt[] | null = null;
  private since = 0;

  // `whole` is false when part of the outline is hidden: a hand over the sheet makes the reading
  // less exact, and the image must not creep while someone is drawing.
  read(quad: Pt[] | null, whole: boolean, now: number): Move | null {
    if (!quad || !whole) {
      this.candidate = null;
      return null;
    }
    if (!this.candidate || maxDistance(quad, this.candidate) > STILL_PIXELS) {
      this.candidate = quad;
      this.since = now;
      return null;
    }
    if (now - this.since < REST_MS) return null;
    const from = this.home;
    if (from && maxDistance(quad, from) < MIN_SHIFT) return null;
    this.home = quad;
    return from && { from, to: quad };
  }

  // After something else has moved the image, the next resting place is simply the new home.
  forget(): void {
    this.home = null;
    this.candidate = null;
  }
}
