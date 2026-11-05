import { IDENTITY, apply, invert, mul, toCss, type Mat3, type Pt } from './homography';

// Where an image sits in world coordinates. World is screen pixels, except in AR mode
// where it is the reference photo, so a placement stays glued to the paper.
export type Placement = { x: number; y: number; scale: number; rot: number; flip: boolean };

type Layer = { el: HTMLCanvasElement; placement: Placement };

const GLIDE_MS = 400; // keep in step with .gliding in style.css

function placementMatrix(p: Placement, w: number, h: number): Mat3 {
  const cos = Math.cos(p.rot) * p.scale;
  const sin = Math.sin(p.rot) * p.scale;
  const fx = p.flip ? -1 : 1;
  // local (u,v) -> centered -> flipped -> rotated+scaled -> world
  const cx = (w / 2) * fx;
  const cy = h / 2;
  return [cos * fx, -sin, p.x - cos * cx + sin * cy, sin * fx, cos, p.y - sin * cx - cos * cy, 0, 0, 1];
}

export class Overlay {
  private readonly active: Layer;
  private readonly copies: Layer[] = [];
  private world: Mat3 = IDENTITY;
  private bitmap: HTMLCanvasElement | null = null;
  private opacity = 0.5;
  private glideTimer = 0;

  constructor(private readonly root: HTMLElement) {
    this.active = { el: this.makeCanvas(), placement: { x: 0, y: 0, scale: 1, rot: 0, flip: false } };
  }

  private makeCanvas(): HTMLCanvasElement {
    const el = document.createElement('canvas');
    el.className = 'layer';
    this.root.append(el);
    return el;
  }

  private paint(el: HTMLCanvasElement): void {
    if (!this.bitmap) return;
    el.width = this.bitmap.width;
    el.height = this.bitmap.height;
    el.getContext('2d')!.drawImage(this.bitmap, 0, 0);
  }

  get placement(): Placement {
    return this.active.placement;
  }

  get copyCount(): number {
    return this.copies.length;
  }

  setBitmap(bitmap: HTMLCanvasElement): void {
    this.bitmap = bitmap;
    this.paint(this.active.el);
    this.copies.forEach((c) => this.paint(c.el));
    this.render();
  }

  // Centers the image at `center`, scaled so it fits inside a box of that size.
  reset(center: Pt, boxW: number, boxH: number): void {
    const { width, height } = this.bitmap!;
    const scale = Math.min(boxW / width, boxH / height);
    Object.assign(this.active.placement, { x: center.x, y: center.y, scale, rot: 0 });
    this.render();
  }

  setOpacity(value: number): void {
    this.opacity = value;
    for (const l of [this.active, ...this.copies]) l.el.style.opacity = String(value);
  }

  setVisible(visible: boolean): void {
    for (const l of [this.active, ...this.copies]) l.el.hidden = !visible;
  }

  // Shown while the sheet is missing, so the frozen image does not pass for a live one.
  setDimmed(dimmed: boolean): void {
    this.root.classList.toggle('dimmed', dimmed);
  }

  // Compare: shows the real drawing alone, without touching the placement.
  setHidden(hidden: boolean): void {
    this.root.classList.toggle('compare', hidden);
  }

  get copyPlacements(): Placement[] {
    return this.copies.map((c) => ({ ...c.placement }));
  }

  restore(placement: Placement, copies: Placement[]): void {
    Object.assign(this.active.placement, placement);
    for (const copy of copies) {
      this.addCopy();
      Object.assign(this.copies[this.copies.length - 1].placement, copy);
    }
    this.render();
  }

  get worldMatrix(): Mat3 {
    return this.world;
  }

  // Takes pixels of the image to stage pixels.
  get imageToStage(): Mat3 {
    if (!this.bitmap) return this.world;
    return mul(this.world, placementMatrix(this.active.placement, this.bitmap.width, this.bitmap.height));
  }

  setWorld(world: Mat3): void {
    this.world = world;
    this.render();
  }

  // For changes nobody asked for at that moment: a visible glide reads as the image moving, not
  // as a glitch.
  glideWorld(world: Mat3): void {
    this.root.classList.add('gliding');
    this.setWorld(world);
    clearTimeout(this.glideTimer);
    this.glideTimer = window.setTimeout(() => this.root.classList.remove('gliding'), GLIDE_MS);
  }

  screenToWorld(p: Pt): Pt {
    return apply(invert(this.world), p);
  }

  addCopy(): void {
    const el = this.makeCanvas();
    this.paint(el);
    el.style.opacity = String(this.opacity);
    // The moving layer stays on top of the stamped ones.
    this.root.append(this.active.el);
    this.copies.push({ el, placement: { ...this.active.placement } });
    this.render();
  }

  removeCopy(): void {
    this.copies.pop()?.el.remove();
  }

  render(): void {
    if (!this.bitmap) return;
    const { width, height } = this.bitmap;
    for (const l of [this.active, ...this.copies]) {
      l.el.style.transform = toCss(mul(this.world, placementMatrix(l.placement, width, height)));
    }
  }

  destroy(): void {
    clearTimeout(this.glideTimer);
    for (const l of [this.active, ...this.copies]) l.el.remove();
  }
}
