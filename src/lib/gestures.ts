import type { Overlay } from './overlay';
import type { Pt } from './homography';

// One finger moves, two fingers scale and rotate. Pointers are converted to world
// coordinates first, so dragging behaves the same on a tilted, tracked sheet.
export function attachGestures(stage: HTMLElement, overlay: Overlay, onChange: () => void): {
  setEnabled(enabled: boolean): void;
  destroy(): void;
} {
  const pointers = new Map<number, Pt>();
  let enabled = true;

  const local = (e: PointerEvent | WheelEvent): Pt => {
    const box = stage.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const onDown = (e: PointerEvent) => {
    if (!enabled) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
  };

  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!enabled || !prev) return;
    const next = local(e);
    const p = overlay.placement;
    if (pointers.size === 1) {
      const a = overlay.screenToWorld(prev);
      const b = overlay.screenToWorld(next);
      p.x += b.x - a.x;
      p.y += b.y - a.y;
    } else if (pointers.size === 2) {
      const otherScreen = [...pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const other = overlay.screenToWorld(otherScreen);
      const a = overlay.screenToWorld(prev);
      const b = overlay.screenToWorld(next);
      const before = { x: a.x - other.x, y: a.y - other.y };
      const after = { x: b.x - other.x, y: b.y - other.y };
      const ratio = Math.hypot(after.x, after.y) / Math.max(1, Math.hypot(before.x, before.y));
      const angle = Math.atan2(after.y, after.x) - Math.atan2(before.y, before.x);
      // Rotate and scale around the finger that did not move.
      const dx = p.x - other.x;
      const dy = p.y - other.y;
      const cos = Math.cos(angle) * ratio;
      const sin = Math.sin(angle) * ratio;
      p.x = other.x + dx * cos - dy * sin;
      p.y = other.y + dx * sin + dy * cos;
      p.scale *= ratio;
      p.rot += angle;
    }
    pointers.set(e.pointerId, next);
    overlay.render();
    onChange();
  };

  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    if (!enabled) return;
    e.preventDefault();
    const p = overlay.placement;
    if (e.shiftKey) p.rot += e.deltaY * 0.002;
    else p.scale *= Math.exp(-e.deltaY * 0.001);
    overlay.render();
    onChange();
  };

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('wheel', onWheel, { passive: false });

  return {
    setEnabled(value) {
      enabled = value;
      pointers.clear();
    },
    destroy() {
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      stage.removeEventListener('wheel', onWheel);
    },
  };
}
