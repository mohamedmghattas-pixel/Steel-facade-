/**
 * Browser-side Rhino (.3dm) commands: pick and read a file into the import
 * dialog's state, apply the import (wireframe lines, a mesh reference model
 * keeping the original file, survey points, panel outlines for the panel
 * layout dialog) as one undo step, and export the model as .3dm. The pure
 * logic is in core/io/rhinoImport.ts, rhinoExport.ts and refMesh.ts; the
 * rhino3dm engine is loaded on first use (core/io/rhinoLoader.ts).
 */
import { create } from 'zustand';
import type { Id, Vec3 } from '../core/model/types';
import { newId } from '../core/model/ops';
import { derived, useStore } from '../state/store';
import { download, getBlob, pickFile, putBlob, safeName } from '../state/storage';
import { loadRhino } from '../core/io/rhinoLoader';
import {
  defaultRhinoLayerSettings,
  importRhinoWireframe,
  rhinoImportPlan,
  rhinoPanelOutlines,
  rhinoReferenceSet,
  rhinoSurveyPoints,
  RHINO_CHORD_TOLERANCE,
  type Rhino3dmRead,
  type RhinoImportOptions,
  type RhinoImportPlan,
  type RhinoLayerSetting,
  type RhinoReadOptions,
} from '../core/io/rhinoLayers';
import type { RhinoExportOptions, RhinoExportStats } from '../core/io/rhinoExport';
import { decodeRefMeshes, encodeRefMeshes, refMeshBlobId, refMeshStats, type RefMeshSet } from '../core/io/refMesh';
import type { PanelOutline } from '../core/io/panelLayout';
import type { SurveyParseResult } from '../core/survey';
import { openWireframeCheck } from './wireframeActions';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);

/** Dialog settings of a pending import (everything but the per-layer table is optional). */
export interface RhinoImportSettings extends Required<Pick<RhinoImportOptions, 'includeHidden' | 'joinTolerance' | 'split' | 'mergeCollinear'>> {
  layers: Record<string, RhinoLayerSetting>;
  offset: Vec3;
  /** Keep the original .3dm with the project (copied to 00-References by the export package). */
  keepOriginal: boolean;
  survey: 'replace' | 'append';
}

export interface RhinoPending {
  name: string;
  bytes: Uint8Array;
  read: Rhino3dmRead;
  readOptions: RhinoReadOptions;
  settings: RhinoImportSettings;
}

interface RhinoState {
  pending: RhinoPending | null;
  busy: string | null;
  /** Panel outlines from the last import, offered as a source in the panel layout dialog. */
  panels: { name: string; outlines: PanelOutline[] } | null;
}

export const useRhino = create<RhinoState>(() => ({ pending: null, busy: null, panels: null }));

export function rhinoOptions(s: RhinoImportSettings): RhinoImportOptions {
  const off = s.offset;
  return { layers: s.layers, includeHidden: s.includeHidden, joinTolerance: s.joinTolerance, split: s.split, mergeCollinear: s.mergeCollinear, ...(off.x || off.y || off.z ? { offset: off } : {}) };
}

function defaultSettings(read: Rhino3dmRead): RhinoImportSettings {
  return { layers: defaultRhinoLayerSettings(read), offset: { x: 0, y: 0, z: 0 }, includeHidden: false, joinTolerance: 2, split: 'junctions', mergeCollinear: true, keepOriginal: true, survey: 'replace' };
}

/** Read .3dm bytes (the engine and the reader are loaded on first use). */
export async function readRhinoBytes(bytes: Uint8Array, o: RhinoReadOptions = {}): Promise<Rhino3dmRead> {
  const [rhino, { readRhino3dm }] = await Promise.all([loadRhino(), import('../core/io/rhinoImport')]);
  return readRhino3dm(rhino, bytes, { chordTolerance: RHINO_CHORD_TOLERANCE, ...o });
}

/** Read a file into the import dialog's state and open the dialog. */
export async function loadRhinoFile(name: string, bytes: Uint8Array, o: RhinoReadOptions = {}): Promise<RhinoPending | null> {
  useRhino.setState({ busy: 'Loading the Rhino engine…' });
  try {
    const read = await readRhinoBytes(bytes, o);
    const pending: RhinoPending = { name, bytes, read, readOptions: o, settings: defaultSettings(read) };
    useRhino.setState({ pending });
    st().set({ dialog: 'rhinoImport' });
    return pending;
  } catch (e) {
    notify(`Could not read ${name}: ${(e as Error).message}`, 'error');
    return null;
  } finally {
    useRhino.setState({ busy: null });
  }
}

/** Import → Rhino (.3dm)… */
export async function openRhinoImport() {
  const f = await pickFile('.3dm');
  if (!f) return;
  notify(`Reading ${f.name}…`);
  await loadRhinoFile(f.name, new Uint8Array(await f.arrayBuffer()));
}

/** Re-read the pending file with other units / tolerances; layer settings are kept. */
export async function rereadRhino(o: RhinoReadOptions) {
  const cur = useRhino.getState().pending;
  if (!cur) return;
  const readOptions = { ...cur.readOptions, ...o };
  useRhino.setState({ busy: 'Reading…' });
  try {
    const read = await readRhinoBytes(cur.bytes, readOptions);
    const layers = { ...defaultRhinoLayerSettings(read), ...cur.settings.layers };
    useRhino.setState({ pending: { ...cur, read, readOptions, settings: { ...cur.settings, layers } } });
  } catch (e) {
    notify(`Could not read ${cur.name}: ${(e as Error).message}`, 'error');
  } finally {
    useRhino.setState({ busy: null });
  }
}

export function updateRhinoSettings(patch: Partial<RhinoImportSettings>) {
  const cur = useRhino.getState().pending;
  if (cur) useRhino.setState({ pending: { ...cur, settings: { ...cur.settings, ...patch } } });
}

export function setRhinoLayer(layer: string, patch: Partial<RhinoLayerSetting>) {
  const cur = useRhino.getState().pending;
  if (!cur) return;
  const s = cur.settings.layers[layer];
  updateRhinoSettings({ layers: { ...cur.settings.layers, [layer]: { ...s, ...patch } } });
}

export function closeRhinoImport() {
  useRhino.setState({ pending: null });
  if (st().dialog === 'rhinoImport') st().set({ dialog: null });
}

export interface RhinoImportResult {
  plan: RhinoImportPlan;
  lines: number;
  referenceId: Id | null;
  survey: number;
  panels: number;
}

/** Apply the pending import as one undo step; opens the wireframe check (or the panel layout dialog) next. */
export async function applyRhinoImport(o: { openNext?: boolean } = {}): Promise<RhinoImportResult | null> {
  const cur = useRhino.getState().pending;
  if (!cur) return null;
  const { read, settings, name } = cur;
  const opts = rhinoOptions(settings);
  const plan = rhinoImportPlan(read, opts);
  const set: RefMeshSet = rhinoReferenceSet(read, opts);
  const stats = refMeshStats(set);
  const withRef = stats.objects > 0 || settings.keepOriginal;
  const refId = withRef ? newId('ref') : null;
  if (refId) {
    try {
      await putBlob(refId, cur.bytes.slice().buffer as ArrayBuffer);
      const mesh = encodeRefMeshes(set);
      await putBlob(refMeshBlobId(refId), mesh.buffer.slice(mesh.byteOffset, mesh.byteOffset + mesh.byteLength) as ArrayBuffer);
    } catch (e) {
      notify(`Could not store ${name} in the browser: ${(e as Error).message}`, 'error');
      return null;
    }
  }
  const survey = plan.survey.points ? rhinoSurveyPoints(read, opts) : [];
  const outlines = plan.panels.outlines ? rhinoPanelOutlines(read, opts) : [];
  let ids: Id[] = [];
  st().apply(`Import ${name}`, (p) => {
    if (plan.wireframe.segments) ids = importRhinoWireframe(p, read, opts);
    if (refId) p.references.push({ id: refId, name, kind: '3dm', visible: stats.objects > 0, opacity: 0.35, offset: { x: 0, y: 0, z: 0 } });
    if (survey.length) {
      p.survey = {
        ...p.survey,
        points: settings.survey === 'append' ? [...p.survey.points, ...survey] : survey,
        source: name,
        importedAt: new Date().toISOString(),
      };
    }
  });
  if (ids.length) {
    st().select({ members: ids });
    st().set({ lastImport: ids });
  }
  useRhino.setState({ pending: null, ...(outlines.length ? { panels: { name, outlines } } : {}) });
  st().set({ dialog: null, zoomRequest: Date.now() });
  const bits = [
    ids.length ? `${ids.length} wireframe line${ids.length === 1 ? '' : 's'}` : '',
    stats.objects ? `a reference model (${stats.objects} object${stats.objects === 1 ? '' : 's'}, ${stats.triangles.toLocaleString()} triangles)` : refId ? 'the original file (00-References)' : '',
    survey.length ? `${survey.length} survey point${survey.length === 1 ? '' : 's'}` : '',
    outlines.length ? `${outlines.length} panel outline${outlines.length === 1 ? '' : 's'} for Panel layout → sub-frame` : '',
  ].filter(Boolean);
  notify(bits.length ? `Imported from ${name}: ${bits.join(', ')}.` : `Nothing imported from ${name} — choose an action for the layers.`);
  if (o.openNext !== false) {
    // The surface orientation takes the exterior side from the reference centre: let the 3D view load it first.
    if (ids.length && refId && stats.objects) await referenceLoaded(refId);
    if (ids.length) openWireframeCheck('import');
    else if (outlines.length) st().set({ dialog: 'panelLayout' });
  }
  return { plan, lines: ids.length, referenceId: refId, survey: survey.length, panels: outlines.length };
}

/** Panel outlines of every visible layer of a .3dm file (planar faces, closed planar curves), for the panel layout dialog. */
export async function readRhinoPanels(name: string, bytes: Uint8Array): Promise<{ name: string; outlines: PanelOutline[] }> {
  const read = await readRhinoBytes(bytes);
  const layers = Object.fromEntries(read.layers.map((l) => [l.fullPath, { on: l.visible, action: 'panels' as const }]));
  return { name, outlines: rhinoPanelOutlines(read, { layers }) };
}

/**
 * Survey points from a .3dm file: the Point and PointCloud objects of one layer (or of
 * every visible layer), names from the object names; `offset` is subtracted after units.
 */
export async function readRhinoSurvey(bytes: ArrayBuffer | Uint8Array, o: { layer?: string; offset?: Vec3 } = {}): Promise<SurveyParseResult & { layers: string[] }> {
  const read = await readRhinoBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const layers = Object.fromEntries(read.layers.map((l) => [l.fullPath, { on: o.layer ? l.fullPath === o.layer : l.visible, action: 'survey' as const }]));
  const off = o.offset;
  const points = rhinoSurveyPoints(read, { layers, ...(off && (off.x || off.y || off.z) ? { offset: { x: -off.x, y: -off.y, z: -off.z } } : {}) });
  const hidden = read.points.filter((p) => p.hidden && (!o.layer || p.layer === o.layer)).length;
  return {
    points,
    skipped: [...(hidden ? [`${hidden} hidden point objects`] : []), ...read.skipped.filter((s) => s.reason.includes('block')).map((s) => `${s.count} ${s.type} (${s.reason})`)],
    format: '3dm',
    layers: [...new Set(read.points.map((p) => p.layer))],
  };
}

/** Wait (up to `ms`) until the 3D view has loaded a reference model (or failed to); returns at once without a 3D view. */
async function referenceLoaded(id: Id, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = st().refStatus[id];
    if (s ? s !== 'Loading…' : Date.now() - t0 > 300) return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ---------------------------------------------------------------------------
// Export

export interface RhinoFileExportOptions extends Omit<RhinoExportOptions, 'references'> {
  /** Write the visible Rhino reference models on References layers. */
  references?: boolean;
}

export async function rhinoReferenceSets(): Promise<{ name: string; set: RefMeshSet; offset: Vec3 }[]> {
  const out: { name: string; set: RefMeshSet; offset: Vec3 }[] = [];
  for (const r of st().project.references) {
    if (r.kind !== '3dm' || !r.visible) continue;
    const blob = await getBlob(refMeshBlobId(r.id));
    if (blob) out.push({ name: r.name.replace(/\.3dm$/i, ''), set: decodeRefMeshes(blob), offset: r.offset });
  }
  return out;
}

/** Export → Rhino model (.3dm). */
export async function exportRhinoFile(o: RhinoFileExportOptions = {}): Promise<RhinoExportStats | null> {
  const p = st().project;
  const dm = derived(p);
  if (!dm.parts.length && !Object.keys(p.members).length) {
    notify('The model is empty — there is nothing to export.', 'error');
    return null;
  }
  useRhino.setState({ busy: 'Writing the Rhino model…' });
  try {
    const [rhino, { exportRhino3dm }] = await Promise.all([loadRhino(), import('../core/io/rhinoExport')]);
    const references = o.references ? await rhinoReferenceSets() : [];
    const res = exportRhino3dm(rhino, p, dm, { ...o, references });
    download(`${safeName(p.info.name)}.3dm`, res.bytes, 'application/octet-stream');
    notify(`Exported ${res.stats.parts} parts, ${res.stats.wires} wire lines and ${res.stats.bolts} bolts as Rhino .3dm (millimetres)${res.stats.definitions ? `, ${res.stats.definitions} assembly blocks` : ''}.`);
    return res.stats;
  } catch (e) {
    notify(`Rhino export failed: ${(e as Error).message}`, 'error');
    return null;
  } finally {
    useRhino.setState({ busy: null });
  }
}
