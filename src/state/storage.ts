import type { Project } from '../core/model/types';
import { defaultDrawingSet, defaultSettings, defaultWireframeSettings } from '../core/model/ops';

import { zip } from '../core/io/zip';
import { defaultPackageSettings, exportTemplates, migrateExportTemplates } from '../core/export/template';
import { extensionOf, hostCapability, HOST_SAVE_EXTENSIONS, inClaudeHost, type HostDownloads } from '../platform/claudeHost';

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
  p.settings = {
    ...d,
    ...(p.settings ?? {}),
    assemblyPrefix: { ...d.assemblyPrefix, ...(p.settings?.assemblyPrefix ?? {}) },
    movement: { ...d.movement, ...(p.settings?.movement ?? {}) },
    galvBath: { ...d.galvBath, ...(p.settings?.galvBath ?? {}) },
  };
  p.connections ??= {};
  p.grids ??= [];
  p.levels ??= [];
  p.references ??= [];
  p.underlays ??= [];
  p.info ??= { name: 'Project', number: '', client: '', designer: '' };
  const dd = defaultDrawingSet();
  p.drawings = {
    ...dd,
    ...(p.drawings ?? {}),
    settings: { ...dd.settings, ...(p.drawings?.settings ?? {}) },
    revisions: p.drawings?.revisions ?? {},
  };
  p.library = { presets: p.library?.presets ?? [], templates: p.library?.templates ?? [], profiles: p.library?.profiles ?? [] };
  migrateTemplates(p);
  p.workPlanes ??= [];
  p.plates ??= {};
  p.survey ??= { points: [], matchRadius: 300 };
  p.survey.points ??= [];
  p.survey.matchRadius ??= 300;
  p.phases ??= [];
  p.batches ??= [];
  p.markLocks ??= {};
  p.clashes ??= { clearance: 10, issues: [] };
  p.clashes.issues ??= [];
  p.clashes.clearance ??= 10;
  p.wireframe = {
    approvals: Array.isArray(p.wireframe?.approvals) ? p.wireframe.approvals : [],
    settings: { ...defaultWireframeSettings(), ...(p.wireframe?.settings ?? {}) },
  };
  p.exportTemplates = migrateExportTemplates(p.exportTemplates);
  if (p.activeExportTemplate && !exportTemplates(p).some((t) => t.id === p.activeExportTemplate)) delete p.activeExportTemplate;
  if (p.exportPackage && typeof p.exportPackage === 'object') p.exportPackage = { ...defaultPackageSettings(), ...p.exportPackage };
  else delete p.exportPackage;
  return p;
}

/**
 * Custom templates saved before the joint frame and the plate placement option
 * existed. Their v values were written against the member-local frame, so they
 * keep it (`frame: 'member'`) and their geometry is unchanged. One exception:
 * the stiffener of the starter template "Bolted end plate with stiffener"
 * (v = -ts/2, meant to be centred under the secondary but 8 mm off-centre) is
 * centred on the axis — the only geometry change on load.
 */
function migrateTemplates(p: Project) {
  for (const t of p.library.templates) {
    if (!t || typeof t !== 'object') continue;
    t.frame ??= 'member';
    if (t.name !== 'Bolted end plate with stiffener') continue;
    for (const pl of t.plates ?? []) {
      if (pl.key === 'st' && pl.plane === 'side' && pl.place === undefined && pl.t.replace(/\s/g, '') === 'ts' && pl.v.replace(/\s/g, '') === '-ts/2') {
        pl.v = '0';
        pl.place = 'centre';
      }
    }
  }
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
  if (inClaudeHost()) {
    void hostDownload(name, data, mime);
    return;
  }
  browserDownload(name, data, mime);
}

function browserDownload(name: string, data: string | Uint8Array | Blob, mime: string) {
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

/**
 * Inside a claude.ai artifact the frame cannot start downloads; the host's
 * `downloads` capability saves the file after the viewer confirms. Formats the
 * host does not accept (IFC, DXF, NC…) are delivered inside a .zip.
 */
async function hostDownload(name: string, data: string | Uint8Array | Blob, mime: string) {
  const notify = async (text: string, kind: 'info' | 'error') => (await import('./store')).useStore.getState().notify(text, kind);
  const host = await hostCapability<HostDownloads>('downloads');
  if (!host) {
    browserDownload(name, data, mime);
    return;
  }
  let filename = name;
  let payload: string | Blob | Uint8Array = data;
  if (!HOST_SAVE_EXTENSIONS.has(extensionOf(name))) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    payload = zip([{ name, data: bytes }]);
    filename = `${name}.zip`;
  }
  try {
    const r = await host.save({ filename, data: payload });
    if (r.status === 'saved' && filename !== name) void notify(`Saved ${filename} — unzip it to get ${name}.`, 'info');
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'declined') return;
    const why = code === 'rate_limited' ? 'another save is still waiting for your answer' : code === 'too_large' ? 'the file is too large for this view' : 'saving files is not available in this view';
    void notify(`Could not save ${filename}: ${why}.`, 'error');
  }
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
