import { icon } from './icons';
import { createMarksWorker } from './lib/tracker';
import type { TrackerResponse } from './lib/tracker.worker';

type Rect = { x: number; y: number; width: number; height: number };

const CUTOUT_SIDE = 520; // GrabCut time grows with area; the mask is scaled back up afterwards
const CUTOUT_INSET = 0.02; // the subject must not touch the rectangle GrabCut is given
const MIN_CROP = 40;
const EDITOR_MARGIN = 20;
const HANDLES = ['nw', 'ne', 'se', 'sw'];

const copyOf = (source: HTMLCanvasElement) => {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(source, 0, 0);
  return canvas;
};

export type EditResult = { canvas: HTMLCanvasElement; cut: boolean };

// Crop and background removal. Runs before drawing, so filters and tracking see the final image.
export function openEditor(root: HTMLElement, source: HTMLCanvasElement, onDone: (result: EditResult | null) => void): () => void {
  root.className = 'editor';
  root.innerHTML = `
    <header class="editor-top">
      <button class="round" data-action="cancel" aria-label="Volver">${icon('back')}</button>
      <strong>Editar imagen</strong>
      <button class="done" data-action="done">${icon('check')}Listo</button>
    </header>
    <div class="editor-stage" data-role="area">
      <div class="editor-frame" data-role="frame">
        <canvas data-role="view"></canvas>
        <div class="crop" data-role="crop">${HANDLES.map((h) => `<span class="handle ${h}" data-handle="${h}"></span>`).join('')}</div>
      </div>
    </div>
    <p class="editor-note" data-role="note">Arrastra las esquinas para recortar.</p>
    <footer class="editor-tools">
      <button class="tool" data-action="cutout">${icon('scissors')}<span>Quitar fondo</span></button>
      <button class="tool" data-action="restore">${icon('restore')}<span>Restaurar</span></button>
    </footer>
  `;

  const $ = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!;
  const view = $<HTMLCanvasElement>('view');
  const frame = $('frame');
  const crop = $('crop');
  const note = $('note');

  let working = copyOf(source);
  let cut = false;
  let rect: Rect = { x: 0, y: 0, width: source.width, height: source.height };
  let scale = 1;
  let worker: Worker | null = null;
  let closed = false;

  const showRect = () => {
    Object.assign(crop.style, {
      left: `${rect.x * scale}px`,
      top: `${rect.y * scale}px`,
      width: `${rect.width * scale}px`,
      height: `${rect.height * scale}px`,
    });
  };

  const layout = () => {
    const area = $('area');
    const room = EDITOR_MARGIN * 2; // the handles stick out of the image
    scale = Math.min((area.clientWidth - room) / source.width, (area.clientHeight - room) / source.height);
    frame.style.width = `${source.width * scale}px`;
    frame.style.height = `${source.height * scale}px`;
    view.width = source.width;
    view.height = source.height;
    view.getContext('2d')!.drawImage(working, 0, 0);
    showRect();
  };

  let drag: { handle: string | undefined; x: number; y: number; start: Rect } | null = null;

  crop.addEventListener('pointerdown', (e) => {
    crop.setPointerCapture(e.pointerId);
    drag = { handle: (e.target as HTMLElement).dataset.handle, x: e.clientX, y: e.clientY, start: { ...rect } };
  });

  crop.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / scale;
    const dy = (e.clientY - drag.y) / scale;
    const { start, handle } = drag;
    if (!handle) {
      rect.x = Math.max(0, Math.min(source.width - start.width, start.x + dx));
      rect.y = Math.max(0, Math.min(source.height - start.height, start.y + dy));
    } else {
      let left = start.x;
      let top = start.y;
      let right = start.x + start.width;
      let bottom = start.y + start.height;
      if (handle.includes('w')) left = Math.max(0, Math.min(right - MIN_CROP, left + dx));
      if (handle.includes('e')) right = Math.min(source.width, Math.max(left + MIN_CROP, right + dx));
      if (handle.includes('n')) top = Math.max(0, Math.min(bottom - MIN_CROP, top + dy));
      if (handle.includes('s')) bottom = Math.min(source.height, Math.max(top + MIN_CROP, bottom + dy));
      rect = { x: left, y: top, width: right - left, height: bottom - top };
    }
    showRect();
  });

  crop.addEventListener('pointerup', () => (drag = null));
  crop.addEventListener('pointercancel', () => (drag = null));

  const setBusy = (busy: boolean, text: string) => {
    root.classList.toggle('busy', busy);
    note.textContent = text;
    root.querySelectorAll<HTMLButtonElement>('.editor-tools button, [data-action="done"]').forEach((b) => (b.disabled = busy));
  };

  const applyMask = (mask: Uint8Array, width: number, height: number, area: Rect) => {
    const small = document.createElement('canvas');
    small.width = width;
    small.height = height;
    const pixels = new ImageData(width, height);
    for (let i = 0; i < mask.length; i++) pixels.data[i * 4 + 3] = mask[i];
    small.getContext('2d')!.putImageData(pixels, 0, 0);

    // Scaling the mask up with smoothing gives soft edges instead of stairs.
    const output = document.createElement('canvas');
    output.width = source.width;
    output.height = source.height;
    const ctx = output.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, area.x, area.y, area.width, area.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(working, 0, 0);
    working = output;
    cut = true;
    layout();
  };

  const cutout = () => {
    const area = { ...rect };
    const factor = Math.min(1, CUTOUT_SIDE / Math.max(area.width, area.height));
    const width = Math.max(8, Math.round(area.width * factor));
    const height = Math.max(8, Math.round(area.height * factor));
    const small = document.createElement('canvas');
    small.width = width;
    small.height = height;
    const ctx = small.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(working, area.x, area.y, area.width, area.height, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data.buffer;
    const insetX = Math.round(width * CUTOUT_INSET);
    const insetY = Math.round(height * CUTOUT_INSET);
    const inner = { x: insetX, y: insetY, width: width - insetX * 2, height: height - insetY * 2 };

    setBusy(true, 'Preparando el recorte. La primera vez tarda unos segundos…');
    worker ??= createMarksWorker();
    worker.onmessage = (e: MessageEvent<TrackerResponse>) => {
      if (closed) return;
      const msg = e.data;
      if (msg.type === 'ready') {
        note.textContent = 'Separando el sujeto del fondo…';
      } else if (msg.type === 'error') {
        setBusy(false, 'No pude quitar el fondo de esta imagen.');
      } else if (msg.type === 'cutout') {
        applyMask(new Uint8Array(msg.mask), width, height, area);
        setBusy(false, 'Listo. Si quitó de más, usa Restaurar y recorta más cerca del sujeto.');
      }
    };
    worker.onerror = () => setBusy(false, 'No pude quitar el fondo de esta imagen.');
    worker.postMessage({ type: 'cutout', width, height, data, rect: inner }, [data]);
  };

  const finish = () => {
    const output = document.createElement('canvas');
    output.width = Math.round(rect.width);
    output.height = Math.round(rect.height);
    output.getContext('2d')!.drawImage(working, -rect.x, -rect.y);
    onDone({ canvas: output, cut });
  };

  const onClick = (e: Event) => {
    const name = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (name === 'cancel') onDone(null);
    else if (name === 'done') finish();
    else if (name === 'cutout') cutout();
    else if (name === 'restore') {
      working = copyOf(source);
      cut = false;
      rect = { x: 0, y: 0, width: source.width, height: source.height };
      note.textContent = 'Arrastra las esquinas para recortar.';
      layout();
    }
  };

  root.addEventListener('click', onClick);
  window.addEventListener('resize', layout);
  layout();

  return () => {
    closed = true;
    root.removeEventListener('click', onClick);
    window.removeEventListener('resize', layout);
    worker?.terminate();
    root.innerHTML = '';
  };
}
