import '@fontsource-variable/bricolage-grotesque';
import { openEditor, type EditResult } from './editor';
import { icon } from './icons';
import { deliverFile, exportProject, importProject } from './lib/backup';
import { blobToCanvas, prepareCanvas, prepareImage } from './lib/image';
import { deleteProject, listImages, listProjects, saveImage, saveProject, type Project } from './lib/store';
import { TimeLapse } from './lib/timelapse';
import { SAMPLES, sampleBlob, sampleUrl } from './samples';
import { openWorkspace, type Mode } from './workspace';

const ART = {
  camera: `<path d="M8 50h48l-6-14H14z"/><rect x="24" y="8" width="16" height="26" rx="3"/><path d="M32 34v8"/><path d="M20 44l8-3 6 3 8-3"/>`,
  ar: `<path d="M6 48l14-20h34l-10 20z" transform="rotate(-4 32 38)"/><path d="M22 34l8 8 14-14"/><path d="M6 12V6h6M58 12V6h-6"/>`,
  screen: `<rect x="16" y="6" width="32" height="50" rx="4"/><path d="M12 22l34-6 6 32-34 6z"/><path d="M24 36c5-6 9 2 14-4"/>`,
};

const MODES: { id: Mode; title: string; tag: string; text: string }[] = [
  { id: 'camera', title: 'Draw with Camera', tag: 'Celular fijo', text: 'Pon el celular en un soporte y calca viendo la pantalla.' },
  { id: 'ar', title: 'Draw with AR', tag: 'Sigue la hoja', text: 'La imagen se queda pegada al papel, aunque lo muevas o lo quites.' },
  { id: 'screen', title: 'Draw with Screen', tag: 'Caja de luz', text: 'Pon la hoja sobre la pantalla iluminada y traza lo que transparenta.' },
];

type Selected = { url: string; canvas: HTMLCanvasElement; blob: Blob; thumb: Blob; project?: Project };
type InstallPrompt = Event & { prompt(): Promise<void> };

const app = document.querySelector<HTMLDivElement>('#app')!;
const timelapses = new Map<number, TimeLapse>();
let selected: Selected | null = null;
let closeView: (() => void) | null = null;
let installPrompt: InstallPrompt | null = null;

const $ = <T extends HTMLElement>(role: string) => app.querySelector<T>(`[data-role="${role}"]`)!;

function showPreview(url: string | null, busy = false) {
  const preview = $('preview');
  preview.classList.toggle('busy', busy);
  preview.classList.toggle('empty', !url);
  $<HTMLImageElement>('preview-image').hidden = !url;
  $('edit').hidden = !url || busy;
  if (url) $<HTMLImageElement>('preview-image').src = url;
}

function showHint(text: string, warn = false) {
  const hint = $('hint');
  hint.textContent = text;
  hint.classList.toggle('warn', warn);
}

function pressThumb(thumb: Element | null) {
  app.querySelectorAll('.thumb').forEach((t) => t.setAttribute('aria-pressed', String(t === thumb)));
}

async function choose(load: () => Promise<Selected>, thumb: Element | null, previewUrl: string) {
  pressThumb(thumb);
  showPreview(previewUrl, true);
  try {
    selected = await load();
    showPreview(selected.url);
    showHint('Listo. Elige cómo quieres dibujar.');
  } catch {
    selected = null;
    showPreview(null);
    pressThumb(null);
    showHint('No pude abrir esa imagen. Prueba con un JPG o PNG.', true);
  }
}

function addThumb(list: HTMLElement, url: string, label: string, load: () => Promise<Selected>) {
  const btn = document.createElement('button');
  btn.className = 'thumb';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-pressed', 'false');
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = url;
  btn.append(img);
  btn.addEventListener('click', () => void choose(load, btn, url));
  list.append(btn);
  return btn;
}

async function onUpload(file: File, thumbs: HTMLElement) {
  await choose(
    async () => {
      const { blob, thumb, canvas } = await prepareImage(file);
      await saveImage(blob, thumb);
      const url = URL.createObjectURL(blob);
      const result: Selected = { url, canvas, blob, thumb };
      const btn = addThumb(thumbs, URL.createObjectURL(thumb), 'Imagen subida', async () => result);
      thumbs.prepend(btn);
      pressThumb(btn);
      return result;
    },
    null,
    URL.createObjectURL(file),
  );
}

function timeAgo(when: number): string {
  const minutes = Math.round((Date.now() - when) / 60000);
  const format = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  if (minutes < 60 * 24) return format.format(-Math.round(minutes / 60), 'hour');
  return format.format(-Math.round(minutes / (60 * 24)), 'day');
}

async function openProject(project: Project) {
  const canvas = await blobToCanvas(project.image);
  selected = { url: URL.createObjectURL(project.image), canvas, blob: project.image, thumb: project.thumb, project };
  location.hash = `#/${project.mode}`;
}

async function renderProjects() {
  const projects = await listProjects();
  const list = $('projects');
  $('continue').hidden = !projects.length;
  list.replaceChildren();
  for (const project of projects) {
    const card = document.createElement('div');
    card.className = 'project';
    const name = MODES.find((m) => m.id === project.mode)!.title.replace('Draw with ', '');
    card.innerHTML = `
      <button class="project-open" aria-label="Continuar dibujo de ${name}">
        <img alt="" src="${URL.createObjectURL(project.thumb)}" />
        <span><strong>${name}</strong><small>${timeAgo(project.updated)}</small></span>
      </button>
      <div class="project-actions">
        <button aria-label="Exportar proyecto" data-do="export">${icon('share')}</button>
        <button aria-label="Borrar proyecto" data-do="delete">${icon('trash')}</button>
      </div>`;
    card.querySelector<HTMLElement>('.project-open')!.onclick = () => void openProject(project);
    card.querySelector<HTMLElement>('[data-do="export"]')!.onclick = async () => deliverFile(await exportProject(project));
    card.querySelector<HTMLElement>('[data-do="delete"]')!.onclick = async () => {
      if (!confirm('¿Borrar este proyecto? Esto no se puede deshacer.')) return;
      await deleteProject(project.id);
      await renderProjects();
    };
    list.append(card);
  }
}

function showInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
  const button = app.querySelector<HTMLElement>('[data-role="install"]');
  const hint = app.querySelector<HTMLElement>('[data-role="install-hint"]');
  if (!button || !hint || standalone) return;
  button.hidden = !installPrompt;
  hint.hidden = !/iPad|iPhone|iPod/.test(navigator.userAgent);
}

async function renderHome() {
  closeView?.();
  closeView = null;
  app.className = 'home';
  app.innerHTML = `
    <header class="brand">
      <h1>DrawAR</h1>
      <p>Pon cualquier imagen sobre papel real y cálcala con tu mano.</p>
    </header>
    <section class="continue" data-role="continue" hidden>
      <h2>Continuar</h2>
      <div class="projects" data-role="projects"></div>
    </section>
    <section class="picker">
      <div class="preview empty" data-role="preview">
        <img data-role="preview-image" alt="Imagen elegida" hidden />
        <button class="edit" data-role="edit" hidden>${icon('crop')}Editar</button>
        <label class="upload">
          ${icon('upload')}<span>Elegir imagen</span>
          <input type="file" accept="image/*" data-role="file" />
        </label>
      </div>
      <div class="thumbs" data-role="thumbs"></div>
    </section>
    <section>
      <p class="hint" data-role="hint">Elige una imagen o prueba con un ejemplo.</p>
      <div class="modes">
        ${MODES.map((m) => `
          <button class="mode" data-mode="${m.id}">
            <svg viewBox="0 0 64 64" aria-hidden="true">${ART[m.id]}</svg>
            <span class="mode-text">
              <em>${m.tag}</em>
              <strong>${m.title}</strong>
              <span>${m.text}</span>
            </span>
          </button>`).join('')}
      </div>
    </section>
    <footer class="home-foot">
      <button class="foot" data-role="install" hidden>${icon('download')}Instalar app</button>
      <label class="foot">${icon('upload')}Importar proyecto<input type="file" data-role="import" /></label>
      <p class="install-hint" data-role="install-hint" hidden>Para instalarla en iPhone: Compartir y luego Agregar a inicio.</p>
    </footer>`;

  const thumbs = $('thumbs');
  if (selected) {
    showPreview(selected.url);
    showHint('Listo. Elige cómo quieres dibujar.');
  }
  showInstall();

  $('edit').onclick = () => (location.hash = '#/editar');
  $('install').onclick = async () => {
    await installPrompt?.prompt();
    installPrompt = null;
    showInstall();
  };

  $<HTMLInputElement>('file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void onUpload(file, thumbs);
  });

  $<HTMLInputElement>('import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      await saveProject(await importProject(file));
      await renderProjects();
      showHint('Proyecto importado. Ya aparece en Continuar.');
    } catch {
      showHint('Ese archivo no es un proyecto de DrawAR.', true);
    }
  });

  app.querySelectorAll<HTMLButtonElement>('.mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (selected) {
        location.hash = `#/${btn.dataset.mode}`;
        return;
      }
      showHint('Primero elige una imagen.', true);
      $('preview').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }], 260);
      app.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  for (const sample of SAMPLES) {
    const url = sampleUrl(sample.svg);
    addThumb(thumbs, url, sample.name, async () => ({ url, ...(await prepareImage(await sampleBlob(sample.svg))) }));
  }
  const recents = await listImages();
  for (const image of [...recents].reverse()) {
    const url = URL.createObjectURL(image.blob);
    const thumb = image.thumb ?? image.blob;
    const btn = addThumb(thumbs, URL.createObjectURL(thumb), 'Imagen reciente', async () => ({
      url,
      canvas: await blobToCanvas(image.blob),
      blob: image.blob,
      thumb,
    }));
    thumbs.prepend(btn);
  }
  await renderProjects();
}

async function onEdited(result: EditResult | null) {
  if (result && selected) {
    const keepsAlpha = result.cut || selected.blob.type === 'image/png';
    const { blob, thumb, canvas } = await prepareCanvas(result.canvas, keepsAlpha);
    await saveImage(blob, thumb);
    selected = { url: URL.createObjectURL(blob), canvas, blob, thumb };
  }
  history.back();
}

function sessionFor(mode: Mode, current: Selected) {
  if (current.project?.mode !== mode) {
    const id = Date.now();
    current.project = { id, updated: id, mode, image: current.blob, thumb: current.thumb, state: null };
  }
  const { project } = current;
  if (!timelapses.has(project.id)) timelapses.set(project.id, new TimeLapse());
  return { canvas: current.canvas, project, timelapse: timelapses.get(project.id)! };
}

// The hash drives navigation, so the phone's back button leaves a mode.
function route() {
  const page = location.hash.replace('#/', '');
  closeView?.();
  closeView = null;
  if (selected && MODES.some((m) => m.id === page)) {
    closeView = openWorkspace(app, page as Mode, sessionFor(page as Mode, selected), () => history.back());
  } else if (selected && page === 'editar') {
    closeView = openEditor(app, selected.canvas, (result) => void onEdited(result));
  } else {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    void renderHome();
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
  showInstall();
});

window.addEventListener('hashchange', route);
route();

if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
