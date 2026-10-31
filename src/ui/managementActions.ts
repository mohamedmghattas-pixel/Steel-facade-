/**
 * Browser-side commands for model management: clash detection against the
 * loaded reference models, BCF export, DWG / IFC steel / panel layout imports
 * and mark locking. Pure logic lives in core/clash, core/io and core/management.
 */
import type { ClashIssue, Id } from '../core/model/types';
import { derived, useStore } from '../state/store';
import { download, getBlob, pickFile, safeName } from '../state/storage';
import { clashSummary, detectClashes, mergeClashIssues, type ClashOptions, type RefElement } from '../core/clash/detect';
import { ifcElementsFromBytes } from '../core/clash/ifcElements';
import { exportBcf } from '../core/io/bcf';
import { convertDwg, detectDwg, dwgConverterFor, isBinaryDxf } from '../core/io/dwg';
import { applyIfcSteel, readIfcSteelFromBytes, type IfcSteelImportOptions, type IfcSteelRead } from '../core/io/ifcImport';
import { lockMarks, unlockMarks } from '../core/management/marks';
import { getIfcApi as ifcApi } from '../state/runtime';
import { useManagement } from './managementState';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Reference elements (cached per reference id and offset)

const refCache = new Map<string, RefElement[]>();

/** Triangles of the visible IFC reference models, in world mm. */
export async function referenceElements(): Promise<{ elements: RefElement[]; missing: string[] }> {
  const refs = st().project.references.filter((r) => r.kind === 'ifc' && r.visible);
  const elements: RefElement[] = [];
  const missing: string[] = [];
  if (!refs.length) return { elements, missing };
  const api = await ifcApi();
  for (const r of refs) {
    const key = `${r.id}|${r.offset.x},${r.offset.y},${r.offset.z}`;
    let els = refCache.get(key);
    if (!els) {
      const bytes = await getBlob(r.id);
      if (!bytes) {
        missing.push(r.name);
        continue;
      }
      els = ifcElementsFromBytes(api, new Uint8Array(bytes), { refId: r.id, offset: r.offset });
      refCache.set(key, els);
    }
    elements.push(...els);
  }
  return { elements, missing };
}

// ---------------------------------------------------------------------------
// Clashes

export async function runClashDetection(opts: Partial<ClashOptions> = {}) {
  const m = useManagement;
  if (m.getState().clashBusy) return null;
  try {
    m.setState({ clashBusy: 'Reading reference models…' });
    await tick();
    const { elements, missing } = await referenceElements();
    const p = st().project;
    const dm = derived(p);
    m.setState({ clashBusy: `Checking ${dm.parts.length} parts against ${elements.length} reference elements…` });
    await tick();
    const run = detectClashes(p, dm, elements, { clearance: p.clashes.clearance, ...opts });
    st().apply('Clash detection', (d) => {
      d.clashes.issues = mergeClashIssues(d.id, d.clashes.issues, run.results);
    });
    m.setState({ clashStats: run.stats });
    const s = clashSummary(st().project.clashes.issues);
    notify(
      `${s.open} open clash${s.open === 1 ? '' : 'es'} (${s.hard} hard, ${s.clearance} clearance) · ${run.stats.parts} parts, ${elements.length} reference elements, ${run.stats.ms} ms${missing.length ? ` · not found in browser storage: ${missing.join(', ')}` : ''}`,
      s.open ? 'error' : 'info',
    );
    return { summary: s, stats: run.stats };
  } catch (e) {
    notify(`Clash detection failed: ${(e as Error).message}`, 'error');
    return null;
  } finally {
    m.setState({ clashBusy: null });
  }
}

/** Members / connections behind the steel side of an issue. */
export function issueSelection(issue: ClashIssue): { members: Id[]; connections: Id[] } {
  const members: Id[] = [];
  const connections: Id[] = [];
  for (const ref of [issue.a, issue.b]) {
    if (ref.startsWith('m:')) members.push(ref.slice(2));
    else if (ref.startsWith('c:')) connections.push(ref.split(':')[1]);
  }
  return { members, connections };
}

export function updateIssue(id: string, patch: Partial<Pick<ClashIssue, 'status' | 'comment'>>) {
  st().apply('Clash issue', (d) => {
    const i = d.clashes.issues.find((x) => x.id === id);
    if (!i) return;
    if (patch.status) i.status = patch.status;
    if (patch.comment !== undefined) {
      if (patch.comment) i.comment = patch.comment;
      else delete i.comment;
    }
  });
}

export function clearResolvedIssues() {
  st().apply('Clear resolved clashes', (d) => {
    d.clashes.issues = d.clashes.issues.filter((x) => x.status !== 'resolved');
  });
}

export function exportBcfFile(statuses: ClashIssue['status'][] = ['open']) {
  const p = st().project;
  const issues = p.clashes.issues.filter((x) => statuses.includes(x.status));
  if (!issues.length) return notify('No clash issues to export — run clash detection first.', 'error');
  const name = safeName(p.info.name);
  download(`${name}-clashes.bcfzip`, exportBcf(p, issues, { ifcFileName: `${name}.ifc` }), 'application/octet-stream');
  notify(`Exported ${issues.length} issue${issues.length === 1 ? '' : 's'} as BCF 2.1. Components refer to the IFC GlobalIds of Export → IFC model.`);
}

// ---------------------------------------------------------------------------
// DXF / DWG

/** File → Import DXF/DWG: DXF opens the import dialog; DWG is converted when a converter is registered, else explained. */
export async function importDrawingFile() {
  const f = await pickFile('.dxf,.dwg');
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const dwg = detectDwg(bytes);
  if (dwg) {
    if (dwgConverterFor(dwg)) {
      try {
        const text = await convertDwg(bytes);
        st().set({ pendingDxf: { name: f.name.replace(/\.dwg$/i, '.dxf'), text }, dialog: 'dxfImport' });
        return;
      } catch (e) {
        notify(`DWG conversion failed: ${(e as Error).message}`, 'error');
      }
    }
    useManagement.setState({ pendingDwg: { name: f.name, info: dwg } });
    st().set({ dialog: 'dwgInfo' });
    return;
  }
  if (isBinaryDxf(bytes)) return notify(`${f.name} is a binary DXF. Save it as ASCII DXF and import again.`, 'error');
  st().set({ pendingDxf: { name: f.name, text: new TextDecoder().decode(bytes) }, dialog: 'dxfImport' });
}

// ---------------------------------------------------------------------------
// IFC steel

export async function openIfcSteelFile() {
  const f = await pickFile('.ifc');
  if (!f) return;
  useManagement.setState({ ifcSteel: { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } });
  st().set({ dialog: 'ifcSteel' });
}

export async function readPendingIfcSteel(opts: IfcSteelImportOptions): Promise<IfcSteelRead> {
  const pending = useManagement.getState().ifcSteel;
  if (!pending) throw new Error('Choose an IFC file first.');
  const api = await ifcApi();
  return readIfcSteelFromBytes(api, pending.bytes, st().project, opts);
}

/** Read and import the steel of an IFC reference model already in the project. */
export async function readReferenceIfcSteel(refId: string, opts: IfcSteelImportOptions): Promise<IfcSteelRead> {
  const r = st().project.references.find((x) => x.id === refId);
  if (!r || r.kind !== 'ifc') throw new Error('No such IFC reference model.');
  const bytes = await getBlob(refId);
  if (!bytes) throw new Error(`${r.name} is not in this browser's storage — import it again.`);
  const api = await ifcApi();
  return readIfcSteelFromBytes(api, new Uint8Array(bytes), st().project, { ...opts, offset: { x: r.offset.x + (opts.offset?.x ?? 0), y: r.offset.y + (opts.offset?.y ?? 0), z: r.offset.z + (opts.offset?.z ?? 0) } });
}

export function applyIfcSteelRead(read: IfcSteelRead, label = 'Import IFC steel'): { members: Id[]; plates: Id[] } {
  let res: { members: Id[]; plates: Id[] } = { members: [], plates: [] };
  st().apply(label, (d) => {
    res = applyIfcSteel(d, read);
  });
  st().select({ members: res.members });
  st().set({ zoomRequest: Date.now() });
  return res;
}

// ---------------------------------------------------------------------------
// Marks

export function lockMarksNow() {
  let n = 0;
  st().apply('Lock marks', (d) => {
    n = lockMarks(d, derived(st().project));
  });
  notify(`Locked the marks of ${n} assemblies. New or changed assemblies get the next free number.`);
}

export function unlockMarksNow() {
  st().apply('Unlock marks', (d) => unlockMarks(d));
  notify('Marks unlocked — numbering is automatic again.');
}
