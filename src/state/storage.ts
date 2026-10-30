import type { Project } from '../core/model/types';
import { defaultSettings } from '../core/model/ops';

const KEY = 'facadesteel.autosave.v1';

export function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Project) : null;
  } catch {
    return null;
  }
}

export function saveAutosave(p: Project) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage full or blocked: the project can still be saved as a file.
  }
}

/** Fill in fields added after a project file was written. */
export function migrateProject(p: Project | null): Project | null {
  if (!p || typeof p !== 'object' || !p.nodes || !p.members) return null;
  const d = defaultSettings();
  p.settings = { ...d, ...(p.settings ?? {}), assemblyPrefix: { ...d.assemblyPrefix, ...(p.settings?.assemblyPrefix ?? {}) } };
  p.connections ??= {};
  p.grids ??= [];
  p.levels ??= [];
  p.references ??= [];
  p.underlays ??= [];
  p.info ??= { name: 'Project', number: '', client: '', designer: '' };
  return p;
}

// ---------------------------------------------------------------------------
// Binary blobs (reference models, underlay PDFs/images) live in IndexedDB.

const DB = 'facadesteel';
const STORE = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBlob(key: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Without IndexedDB the file only lives for this session.
  }
}

export async function getBlob(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function deleteBlob(key: string): Promise<void> {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------

export function download(name: string, data: string | Uint8Array | Blob, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
}
