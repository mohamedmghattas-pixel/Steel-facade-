import type { Project } from '../core/model/types';
import { defaultDrawingSet, defaultSettings, defaultWireframeSettings } from '../core/model/ops';

import { zip } from '../core/io/zip';
import { sanitizeProfileAssemblies } from '../core/library/profileAssembly';
import { defaultPackageSettings, exportTemplates, migrateExportTemplates } from '../core/export/template';
import { extensionOf, hostCapability, HOST_SAVE_EXTENSIONS, inClaudeHost, type HostDownloads } from '../platform/claudeHost';

const KEY = 'facadesteel.autosave.v1';
/** Set (to the save time) while the autosave lives in IndexedDB because it did not fit into localStorage. */
const IDB_MARK = 'facadesteel.autosave.idb';
const IDB_KEY = 'autosave:project';

export function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Project) : null;
  } catch {
    return null;
  }
}

/** Where the last autosave went: localStorage, IndexedDB (too large for localStorage), or nowhere. */
export type AutosaveResult = { where: 'local' | 'indexeddb' | 'none'; bytes: number; error?: string };

/**
 * Save the project for the next visit. localStorage holds a few MB only: a larger
 * project goes to IndexedDB instead, and the older copy in localStorage is removed
 * so it is never restored in place of the newer one.
 */
export async function saveAutosave(p: Project): Promise<AutosaveResult> {
  let text: string;
  try {
    text = JSON.stringify(p);
  } catch (e) {
    return { where: 'none', bytes: 0, error: (e as Error).message };
  }
  const bytes = text.length;
  try {
    localStorage.setItem(KEY, text);
    if (localStorage.getItem(IDB_MARK) !== null) {
      localStorage.removeItem(IDB_MARK);
      void deleteValue(IDB_KEY).catch(() => {});
    }
    return { where: 'local', bytes };
  } catch {
    // Full (QuotaExceededError) or blocked: never leave an older copy behind.
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  }
  try {
    await putValue(IDB_KEY, text);
    try {
      localStorage.setItem(IDB_MARK, new Date().toISOString());
    } catch {
      // The marker is a few bytes; without it the IndexedDB copy is still found on load.
    }
    return { where: 'indexeddb', bytes };
  } catch (e) {
    return { where: 'none', bytes, error: (e as Error)?.message ?? String(e) };
  }
}

/** The autosave kept in IndexedDB, when localStorage has none (see saveAutosave). */
export async function loadIdbAutosave(): Promise<Project | null> {
  try {
    if (localStorage.getItem(KEY) !== null) return null;
  } catch {
    // localStorage blocked: IndexedDB may still have one.
  }
  try {
    const text = await getValue<string>(IDB_KEY);
    return typeof text === 'string' ? (JSON.parse(text) as Project) : null;
  } catch {
    return null;
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
    settings: { ...dd.settings, ...(p.drawings?.settings ?? {}), zoning: { ...dd.settings.zoning!, ...(p.drawings?.settings?.zoning ?? {}) } },
    revisions: p.drawings?.revisions ?? {},
  };
  // Unfolded elevation of folded facades (added with the unfolded drawings): on unless switched off.
  if (typeof p.drawings.settings.unfolded !== 'boolean') p.drawings.settings.unfolded = true;
  p.library = { presets: p.library?.presets ?? [], templates: p.library?.templates ?? [], profiles: p.library?.profiles ?? [], profileAssemblies: sanitizeProfileAssemblies(p.library?.profileAssemblies) };
  migrateTemplates(p);
  p.workPlanes ??= [];
  p.plates ??= {};
  p.survey ??= { points: [], matchRadius: 300 };
  p.survey.points ??= [];
  p.survey.matchRadius ??= 300;
  p.phases ??= [];
  p.batches ??= [];
  p.markLocks ??= {};
  p.assemblyGroups = Array.isArray(p.assemblyGroups)
    ? p.assemblyGroups
        .filter((g) => g && typeof g === 'object' && typeof g.id === 'string')
        .map((g) => ({ ...g, members: Array.isArray(g.members) ? g.members : [], plates: Array.isArray(g.plates) ? g.plates : [] }))
    : [];
  p.clashes ??= { clearance: 10, issues: [] };
  p.clashes.issues ??= [];
  p.clashes.clearance ??= 10;
  p.wireframe = {
    approvals: Array.isArray(p.wireframe?.approvals) ? p.wireframe.approvals : [],
    settings: { ...defaultWireframeSettings(), ...(p.wireframe?.settings ?? {}) },
  };
  const gap = p.wireframe.settings.stackJointGap;
  if (!gap || !Number.isFinite(gap.min) || !Number.isFinite(gap.max)) p.wireframe.settings.stackJointGap = defaultWireframeSettings().stackJointGap;
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

/** Like putBlob / getBlob for any cloneable value, but failures are reported (rejected). */
async function putValue(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

async function getValue<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteValue(key: string): Promise<void> {
  const db = await openDb();
  db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
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

/**
 * A file name browsers and file systems accept: at most `max` UTF-8 bytes (255 is the usual
 * limit; a longer name makes Chrome save the file as "download", without its extension),
 * shortened before the extension. Names from long project names with accents or CJK need this.
 */
export function downloadName(name: string, max = 200): string {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(name) <= max) return name;
  const ext = name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? '';
  let out = '';
  let n = bytes(ext);
  for (const ch of name.slice(0, name.length - ext.length)) {
    n += bytes(ch);
    if (n > max) break;
    out += ch;
  }
  return out.replace(/[\s._-]+$/, '') + ext;
}

export function download(name: string, data: string | Uint8Array | Blob, mime = 'application/octet-stream') {
  name = downloadName(name);
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
