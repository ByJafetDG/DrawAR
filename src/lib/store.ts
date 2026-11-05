import type { Mat3 } from './homography';
import type { ProcessOptions } from './image';
import type { Placement } from './overlay';

// Recent images and projects live in IndexedDB so they survive restarting the dev server.
export type StoredImage = { id: number; blob: Blob; thumb?: Blob };

export type SheetMemory = { ink: Float32Array; aspect: number; sizeIndex: number };

export type ProjectState = {
  opts: ProcessOptions;
  opacity: number;
  placement: Placement;
  copies: Placement[];
  stage: { width: number; height: number };
  sheet: SheetMemory | null;
  world?: Mat3; // Draw with Camera: where following the sheet has moved the image to
};

export type Project = {
  id: number;
  updated: number;
  mode: 'camera' | 'screen' | 'ar';
  image: Blob;
  thumb: Blob;
  state: ProjectState | null;
};

const MAX_IMAGES = 12;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('drawar', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readAll<T>(store: string): Promise<T[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function listImages(): Promise<StoredImage[]> {
  try {
    return (await readAll<StoredImage>('images')).sort((a, b) => b.id - a.id);
  } catch {
    return [];
  }
}

export async function saveImage(blob: Blob, thumb: Blob): Promise<void> {
  try {
    const stale = (await listImages()).slice(MAX_IMAGES - 1);
    const db = await open();
    const tx = db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    store.put({ id: Date.now(), blob, thumb });
    stale.forEach((img) => store.delete(img.id));
  } catch {
    // Private windows may block IndexedDB; the current session still works.
  }
}

export async function listProjects(): Promise<Project[]> {
  try {
    return (await readAll<Project>('projects')).sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function saveProject(project: Project): Promise<boolean> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({ ...project, updated: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    void navigator.storage?.persist?.(); // asks the browser not to evict saved drawings
    return true;
  } catch {
    return false;
  }
}

export async function deleteProject(id: number): Promise<void> {
  try {
    const db = await open();
    db.transaction('projects', 'readwrite').objectStore('projects').delete(id);
  } catch {
    // Nothing to clean up if storage is blocked.
  }
}
