/**
 * User-level commands shared by menus, toolbars and keyboard shortcuts.
 */
import type { Project, Underlay, Vec3 } from '../core/model/types';
import {
  addLine,
  copyMembers,
  createProject,
  deleteConnections,
  deleteMembers,
  facadeGrid,
  moveItems,
  newId,
  splitAtIntersections,
  splitLineAtCrossings,
  autoAssign,
  updateMembers,
  addConnection,
  membersAtNode,
} from '../core/model/ops';
import { dist, sub, worldToPlane } from '../core/model/geometry';
import { autoConnect, CONNECTIONS } from '../core/connections/registry';
import type { ConnectionType } from '../core/model/types';
import { derived, useStore, type Tool } from '../state/store';
import { download, migrateProject, pickFile, putBlob, deleteBlob, safeName } from '../state/storage';
import { exportIfc } from '../core/io/ifcExport';
import { exportDstvAll } from '../core/fabrication/dstv';
import { buildBom, bomToXlsx, toCsv } from '../core/reports/bom';
import { zip } from '../core/io/zip';
import { allDrawings, drawingToDxf } from '../core/drawings';
import type { Drawing } from '../core/drawings/types';
import { drawingsToPdf } from './pdf';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);
const fileBase = () => safeName(st().project.info.name);

// ---------------------------------------------------------------------------
// Project files

export function newProject() {
  if (Object.keys(st().project.members).length && !confirm('Start a new project? Unsaved changes are kept only in the undo history of this session.')) return;
  st().replaceProject(createProject());
  st().set({ viewRequest: { name: '3d', n: Date.now() } });
}

export function saveProjectFile() {
  const p = st().project;
  download(`${fileBase()}.facadesteel.json`, JSON.stringify(p, null, 1), 'application/json');
}

export async function openProjectFile() {
  const f = await pickFile('.json,.facadesteel.json,application/json');
  if (!f) return;
  try {
    const p = migrateProject(JSON.parse(await f.text()) as Project);
    if (!p) throw new Error('Not a FacadeSteel project file.');
    st().replaceProject(p);
    st().set({ viewRequest: { name: '3d', n: Date.now() } });
    notify(`Opened ${f.name}`);
  } catch (e) {
    notify(`Could not open the file: ${(e as Error).message}`, 'error');
  }
}

/** A worked example: two-storey curtain-wall support frame with slab brackets and cleats. */
export function loadSample() {
  const p = createProject('Sample facade – Block A east elevation');
  p.info.number = 'FS-001';
  p.info.client = 'Sample client';
  p.info.designer = 'FacadeSteel';
  facadeGrid(p, {
    plane: { kind: 'XZ', offset: 0 },
    u0: 0,
    v0: 0,
    bays: [1500, 1500, 1500, 1500],
    rows: [1100, 2400, 1100, 2400],
    floorLines: [0, 2, 4],
    mullionProfile: 'SHS 100x100x5',
    transomProfile: 'RHS 100x50x4',
    transomDepthNormal: true,
    addLevels: true,
  });
  p.grids = [0, 1, 2, 3, 4].map((i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 1500 }));
  autoConnect(p);
  st().replaceProject(p);
  st().set({ viewRequest: { name: '3d', n: Date.now() } });
  notify('Loaded the sample facade. Open Outputs to see the material list, nesting and drawings.');
}

// ---------------------------------------------------------------------------
// Editing

export function deleteSelection() {
  const { selection } = st();
  if (!selection.members.length && !selection.connections.length) return;
  st().apply('Delete', (p) => {
    deleteConnections(p, selection.connections);
    deleteMembers(p, selection.members);
  });
  st().clearSelection();
}

export function splitSelection() {
  const ids = st().selection.members;
  st().apply('Split at intersections', (p) => splitAtIntersections(p, ids.length ? ids : undefined));
  notify(ids.length ? 'Split selected lines at their crossings.' : 'Split all lines at their crossings.');
}

export function assignActiveProfile() {
  const { selection, activeProfile, activeRole } = st();
  if (!selection.members.length) return notify('Select wireframe lines first.', 'error');
  st().apply('Assign profile', (p) => updateMembers(p, selection.members, { profile: activeProfile, role: activeRole }));
}

export function autoAssignSelection() {
  const { selection, project } = st();
  const ids = selection.members.length ? selection.members : Object.keys(project.members);
  let n = 0;
  st().apply('Auto-assign profiles', (p) => {
    n = autoAssign(p, ids);
  });
  notify(`Assigned profiles to ${n} line${n === 1 ? '' : 's'} using the rules in Project settings.`);
}

export function addConnectionFromSelection(type: ConnectionType) {
  const { selection, project } = st();
  const def = CONNECTIONS[type];
  const ms = selection.members.map((id) => project.members[id]).filter(Boolean);
  let node: string | null = selection.nodes[0] ?? null;
  let main: string | null = null;
  let secondary: string[] = [];
  if (def.needsMain) {
    if (ms.length < 2) return notify(`${def.label}: select the main member first, then the secondary member (Shift+click).`, 'error');
    const [m, s] = ms;
    main = m.id;
    secondary = [s.id];
    // Shared node: an end of the secondary on (or at the end of) the main member.
    for (const end of [s.start, s.end]) {
      if (membersAtNode(project, end).some((x) => x.member.id === m.id)) node = end;
    }
    if (!node) return notify('The secondary member must end on the main member.', 'error');
  } else {
    if (!ms.length) return notify(`${def.label}: select the supported member (and optionally a node).`, 'error');
    const m = ms[0];
    secondary = [m.id];
    if (!node) {
      const a = project.nodes[m.start].p;
      const b = project.nodes[m.end].p;
      node = a.z <= b.z ? m.start : m.end;
    }
  }
  let id = '';
  st().apply(`Add ${def.label}`, (p) => {
    id = addConnection(p, type, node!, main, secondary);
  });
  st().select({ connections: [id] });
}

export function runAutoConnect(opts: Parameters<typeof autoConnect>[1]) {
  const { selection } = st();
  let n = 0;
  st().apply('Auto-connect', (p) => {
    n = autoConnect(p, opts, selection.members.length ? new Set(selection.members) : undefined).length;
  });
  notify(n ? `Added ${n} connection${n === 1 ? '' : 's'}.` : 'No new connections were needed.');
}

export function setTool(t: Tool) {
  st().setTool(t);
}

/** Called by the viewer when a tool has collected its points. */
export function handleToolPoints(tool: Tool, pts: Vec3[]) {
  const [a, b] = pts;
  const s = st();
  if (tool === 'line' || tool === 'polyline') {
    const props = s.drawWithProfile ? { profile: s.activeProfile, role: s.activeRole } : {};
    s.apply('Draw line', (p) => {
      const id = addLine(p, a, b, props);
      if (id) splitLineAtCrossings(p, id);
    });
  } else if (tool === 'move' || tool === 'copy') {
    const sel = s.selection;
    if (!sel.members.length && !sel.nodes.length) return notify('Select something to move or copy first.', 'error');
    const d = sub(b, a);
    if (tool === 'move') s.apply('Move', (p) => moveItems(p, sel.members, sel.nodes, d));
    else {
      let ids: string[] = [];
      s.apply('Copy', (p) => {
        ids = copyMembers(p, sel.members, d, 1);
      });
      s.select({ members: ids });
    }
  } else if (tool === 'measure') {
    const d = sub(b, a);
    notify(`Distance ${dist(a, b).toFixed(1)} mm  (dx ${d.x.toFixed(1)}, dy ${d.y.toFixed(1)}, dz ${d.z.toFixed(1)})`);
  } else if (tool === 'calibrate') {
    calibrate(a, b);
  }
}

function calibrate(a: Vec3, b: Vec3) {
  const s = st();
  const u = s.project.underlays.find((x) => x.id === s.calibrateTarget);
  if (!u) return notify('Choose an underlay to calibrate in the Model panel.', 'error');
  const pa = worldToPlane(u.plane, a);
  const pb = worldToPlane(u.plane, b);
  const measured = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const real = Number(prompt(`Measured ${measured.toFixed(1)} mm on the underlay. Enter the real distance between the two points (mm):`, measured.toFixed(0)));
  if (!Number.isFinite(real) || real <= 0) return;
  const k = real / measured;
  const where = prompt('Optional: work-plane coordinates of the FIRST point after scaling, as "u,v" (leave empty to keep it in place):', '');
  s.apply('Calibrate underlay', (p) => {
    const t = p.underlays.find((x) => x.id === u.id)!;
    // Scale about the first point so it stays put.
    t.mmPerPx *= k;
    t.origin = { x: pa.x + (t.origin.x - pa.x) * k, y: pa.y + (t.origin.y - pa.y) * k };
    const nums = (where ?? '').split(/[ ,;]+/).filter(Boolean).map(Number);
    if (nums.length === 2 && nums.every(Number.isFinite)) {
      t.origin = { x: t.origin.x + nums[0] - pa.x, y: t.origin.y + nums[1] - pa.y };
    }
  });
  s.set({ tool: 'select', calibrateTarget: null });
  notify(`Underlay scaled ×${k.toFixed(4)}.`);
}

// ---------------------------------------------------------------------------
// Imports

export async function importDxf() {
  const f = await pickFile('.dxf');
  if (!f) return;
  st().set({ pendingDxf: { name: f.name, text: await f.text() }, dialog: 'dxfImport' });
}

export async function importIfcReference() {
  const f = await pickFile('.ifc');
  if (!f) return;
  const bytes = await f.arrayBuffer();
  const id = newId('ref');
  await putBlob(id, bytes);
  st().apply('Import IFC reference', (p) => {
    p.references.push({ id, name: f.name, kind: 'ifc', visible: true, opacity: 0.35, offset: { x: 0, y: 0, z: 0 } });
  });
  notify(`Loading ${f.name}…`);
}

export async function importUnderlay() {
  const f = await pickFile('.pdf,.png,.jpg,.jpeg,.webp');
  if (!f) return;
  const bytes = await f.arrayBuffer();
  const id = newId('ul');
  await putBlob(id, bytes);
  const kind: Underlay['kind'] = f.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image';
  const wp = st().workPlane;
  st().apply('Add underlay', (p) => {
    p.underlays.push({ id, name: f.name, kind, page: 1, plane: { ...wp }, origin: { x: 0, y: 0 }, mmPerPx: 5, rotation: 0, opacity: 0.6, visible: true });
  });
  st().set({ sidePanel: 'model' });
  notify('Underlay added. Use Calibrate in the Model panel to set its scale from two known points.');
}

export function removeReference(id: string) {
  st().apply('Remove reference', (p) => {
    p.references = p.references.filter((r) => r.id !== id);
    p.underlays = p.underlays.filter((u) => u.id !== id);
  });
  void deleteBlob(id);
}

// ---------------------------------------------------------------------------
// Exports

function guardModel(): boolean {
  const dm = derived(st().project);
  if (!dm.parts.length) {
    notify('Assign profiles to the wireframe first — there are no steel parts yet.', 'error');
    return false;
  }
  return true;
}

export function exportIfcFile() {
  if (!guardModel()) return;
  const p = st().project;
  download(`${fileBase()}.ifc`, exportIfc(p, derived(p)), 'application/x-step');
}

export function exportBom(kind: 'csv' | 'xlsx') {
  if (!guardModel()) return;
  const p = st().project;
  const bom = buildBom(p, derived(p));
  if (kind === 'xlsx') {
    download(`${fileBase()}-material-list.xlsx`, bomToXlsx(bom, p), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return;
  }
  const files = [
    { name: 'parts.csv', data: toCsv(bom.parts) },
    { name: 'assemblies.csv', data: toCsv(bom.assemblies) },
    { name: 'profiles.csv', data: toCsv(bom.profiles) },
    { name: 'bolts.csv', data: toCsv(bom.bolts) },
  ];
  download(`${fileBase()}-material-list-csv.zip`, zip(files), 'application/zip');
}

export function exportNc() {
  if (!guardModel()) return;
  const p = st().project;
  const files = exportDstvAll(p, derived(p)).map((f) => ({ name: f.name, data: f.content }));
  download(`${fileBase()}-nc-dstv.zip`, zip(files), 'application/zip');
  notify(`Exported ${files.length} DSTV NC1 file${files.length === 1 ? '' : 's'}.`);
}

export function drawingsFor(kind?: Drawing['kind']): Drawing[] {
  const p = st().project;
  const all = allDrawings(p, derived(p));
  return kind ? all.filter((d) => d.kind === kind) : all;
}

export function exportDrawingsDxf(list?: Drawing[]) {
  if (!guardModel()) return;
  const ds = list ?? drawingsFor();
  const files = ds.map((d) => ({ name: `${safeName(`${d.kind}-${d.mark || d.title}`)}.dxf`, data: drawingToDxf(d) }));
  download(`${fileBase()}-drawings-dxf.zip`, zip(files), 'application/zip');
}

export async function exportDrawingsPdf(list?: Drawing[]) {
  if (!guardModel()) return;
  const ds = list ?? drawingsFor();
  notify(`Creating PDF with ${ds.length} sheet${ds.length === 1 ? '' : 's'}…`);
  try {
    const blob = await drawingsToPdf(ds);
    download(`${fileBase()}-drawings.pdf`, blob, 'application/pdf');
  } catch (e) {
    notify(`PDF export failed: ${(e as Error).message}`, 'error');
  }
}
