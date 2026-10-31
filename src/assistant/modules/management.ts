/**
 * Assistant tools for model management: phases / zones / delivery batches,
 * manual marks and mark locking, clash detection, panel layout → sub-frame
 * and IFC steel import.
 */
import type { Id, MemberRole, Project } from '../../core/model/types';
import { MEMBER_ROLES } from '../../core/model/types';
import { derived, useStore } from '../../state/store';
import {
  addBatch,
  addPhase,
  deleteBatch,
  deletePhase,
  memberMatches,
  moveBatch,
  movePhase,
  orderedPhases,
  setGrouping,
  updateBatch,
  updatePhase,
  zonesInUse,
  type ColorBy,
} from '../../core/management/grouping';
import { lockMarks, markLockSummary, setMarkOverride, unlockMarks } from '../../core/management/marks';
import { clashSummary } from '../../core/clash/detect';
import { extractJoints, generateSubframe, panelLayoutFromDxf, previewSubframe } from '../../core/io/panelLayout';
import { applyIfcSteel, readIfcSteelFromBytes, summarizeIfcSteel, type IfcSteelImportOptions } from '../../core/io/ifcImport';
import { getIfcApi } from '../../state/runtime';
import { getBlob } from '../../state/storage';
import { exportBcfFile, runClashDetection, updateIssue } from '../../ui/managementActions';
import type { Json, ToolModule } from './types';

const st = () => useStore.getState();
const str = { type: 'string' } as const;
const num = { type: 'number' } as const;

const members = {
  type: 'object',
  description: 'Which members: ids, {"selected":true}, {"all":true}, or role / profile / phase / zone / batch filters (AND).',
  properties: {
    ids: { type: 'array', items: str },
    selected: { type: 'boolean' },
    all: { type: 'boolean' },
    role: { type: 'string', enum: MEMBER_ROLES },
    profile: str,
    phase: { type: 'string', description: 'Phase id or name; "" = none' },
    zone: { type: 'string', description: '"" = none' },
    batch: { type: 'string', description: 'Batch id or name; "" = none' },
  },
} as const;

interface MemberFilter {
  ids?: string[];
  selected?: boolean;
  all?: boolean;
  role?: MemberRole;
  profile?: string;
  phase?: string;
  zone?: string;
  batch?: string;
}

const phaseId = (p: Project, v: unknown): Id | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const s = String(v);
  const hit = p.phases.find((x) => x.id === s) ?? p.phases.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`No phase "${s}". Phases: ${p.phases.map((x) => x.name).join(', ') || 'none'}`);
  return hit.id;
};
const batchId = (p: Project, v: unknown): Id | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const s = String(v);
  const hit = p.batches.find((x) => x.id === s) ?? p.batches.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`No delivery batch "${s}". Batches: ${p.batches.map((x) => x.name).join(', ') || 'none'}`);
  return hit.id;
};

function resolve(p: Project, f: MemberFilter | undefined): Id[] {
  if (!f) return [];
  let list = Object.values(p.members);
  if (f.ids?.length) list = list.filter((m) => f.ids!.includes(m.id));
  else if (f.selected) {
    const sel = new Set(st().selection.members);
    list = list.filter((m) => sel.has(m.id));
  } else if (!f.all && f.role === undefined && f.profile === undefined && f.phase === undefined && f.zone === undefined && f.batch === undefined) return [];
  if (f.role) list = list.filter((m) => m.role === f.role);
  if (f.profile) list = list.filter((m) => m.profile === f.profile);
  const g = {
    ...(f.phase !== undefined ? { phase: f.phase === '' ? '' : (phaseId(p, f.phase) ?? '') } : {}),
    ...(f.zone !== undefined ? { zone: f.zone } : {}),
    ...(f.batch !== undefined ? { batch: f.batch === '' ? '' : (batchId(p, f.batch) ?? '') } : {}),
  };
  list = list.filter((m) => memberMatches(m, g));
  return list.map((m) => m.id);
}

function groupsSummary(p: Project) {
  const dm = derived(p);
  const count = (k: 'phase' | 'batch' | 'zone', v: string) => Object.values(p.members).filter((m) => m[k] === v).length;
  const mass = (k: 'phase' | 'batch' | 'zone', v: string) => Math.round(dm.assemblies.filter((a) => a[k] === v).reduce((s, a) => s + a.mass, 0));
  return {
    phases: orderedPhases(p).map((x) => ({ id: x.id, name: x.name, sequence: x.sequence, color: x.color, members: count('phase', x.id), kg: mass('phase', x.id) })),
    batches: p.batches.map((x) => ({ id: x.id, name: x.name, date: x.date, phase: x.phase, members: count('batch', x.id), kg: mass('batch', x.id) })),
    zones: zonesInUse(p).map((z) => ({ zone: z, members: count('zone', z) })),
    unassigned: { phase: Object.values(p.members).filter((m) => !m.phase).length, batch: Object.values(p.members).filter((m) => !m.batch).length },
  };
}

const tools: ToolModule['tools'] = [
  {
    name: 'manage_phases_batches',
    description:
      'List, create, rename/recolour, reorder or delete erection phases and delivery batches. Phases have an erection sequence (move with delta -1/+1); batches have an optional delivery date (YYYY-MM-DD) and phase. Returns the phases, batches and zones with member counts and kg.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add_phase', 'update_phase', 'delete_phase', 'move_phase', 'add_batch', 'update_batch', 'delete_batch', 'move_batch'] },
        id: { type: 'string', description: 'Phase / batch id or name (update, delete, move)' },
        name: str,
        color: { type: 'string', description: 'Phase colour #rrggbb' },
        date: str,
        phase: { type: 'string', description: 'Batch: phase id or name' },
        delta: { type: 'integer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'assign_phase_zone_batch',
    description:
      'Assign erection phase, zone and/or delivery batch to members (their connection parts and assemblies follow). Phase / batch by id or name; "" clears. Optionally colour the 3D view by phase / batch / zone, set or clear the selection filter (only matching members can be picked), or select the matched members.',
    input_schema: {
      type: 'object',
      properties: {
        members,
        phase: { type: 'string', description: 'Phase id or name to assign; "" clears' },
        zone: { type: 'string', description: 'Zone to assign; "" clears' },
        batch: { type: 'string', description: 'Batch id or name to assign; "" clears' },
        colorBy: { type: 'string', enum: ['role', 'phase', 'batch', 'zone'] },
        selectionFilter: { type: 'object', properties: { phase: str, zone: str, batch: str }, description: 'Only members with these values can be selected ("" = without)' },
        clearSelectionFilter: { type: 'boolean' },
        select: { type: 'boolean', description: 'Select the matched members' },
      },
    },
  },
  {
    name: 'assembly_marks',
    description:
      'Mark control. status: lock state and assemblies changed since locking. lock: freeze all current marks (later edits keep them; new/changed assemblies get the next free number). unlock: automatic numbering. override: give the members\' assemblies a manual mark (mark "" clears).',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['status', 'lock', 'unlock', 'override'] }, members, mark: str },
      required: ['action'],
    },
  },
  {
    name: 'clash_detection',
    description:
      'Clash detection of the steel against the loaded IFC reference models (hard clashes and clearance) and against itself. run: (re-)run and summarise (issue status and comments are kept per pair). list: issues. set_status: open / resolved / ignored with an optional comment. export_bcf: download BCF 2.1 of open issues.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'list', 'set_status', 'export_bcf'] },
        clearance: { type: 'number', description: 'Required clearance to the reference, mm' },
        steelSteel: { type: 'boolean' },
        ids: { type: 'array', items: str, description: 'Issue ids for set_status' },
        status: { type: 'string', enum: ['open', 'resolved', 'ignored'] },
        comment: str,
        limit: { type: 'integer', description: 'Issues to return (default 25)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'import_panel_layout',
    description:
      'Generate mullions (vertical joints) and transoms (horizontal joints) from an architect\'s panel layout given as DXF text: closed polylines are panels, lines on joint layers are joints. Joints within the tolerance merge. The steel goes on the facade plane (XZ at y = offset, or YZ at x = offset) shifted behind the panel face by the cavity. Profiles from the auto-assign rules. preview: counts only.',
    input_schema: {
      type: 'object',
      properties: {
        dxf: { type: 'string', description: 'DXF file text' },
        plane: { type: 'string', enum: ['XZ', 'YZ'] },
        offset: { type: 'number', description: 'Panel face position on the plane normal, mm' },
        cavity: { type: 'number', description: 'Panel face → steel centre line, mm (default 120)' },
        tolerance: num,
        includePerimeter: { type: 'boolean' },
        split: { type: 'string', enum: ['transoms', 'all', 'none'] },
        scale: { type: 'number', description: 'mm per drawing unit' },
        jointLayers: { type: 'array', items: str },
        preview: { type: 'boolean' },
      },
      required: ['dxf', 'plane'],
    },
  },
  {
    name: 'ifc_steel_import',
    description:
      'Read steel (IfcBeam / IfcColumn / IfcMember → members, IfcPlate → free plates) from an IFC reference model in the project (referenceId or name; default the first IFC reference) and summarise counts, profile matches (name / dimensions / new custom) and warnings. apply: true imports them as editable members.',
    input_schema: {
      type: 'object',
      properties: {
        referenceId: str,
        apply: { type: 'boolean' },
        plates: { type: 'boolean' },
        skipConnectionParts: { type: 'boolean', description: 'Skip FacadeSteel connection parts (re-importing our own IFC)' },
        ifcText: { type: 'string', description: 'Alternatively the IFC (STEP) text itself' },
      },
    },
  },
];

const run: ToolModule['run'] = {
  manage_phases_batches(input: Json) {
    const action = String(input.action);
    const p = st().project;
    const findPhase = () => phaseId(p, input.id) ?? (() => {
      throw new Error('id (phase id or name) is required');
    })();
    const findBatch = () => batchId(p, input.id) ?? (() => {
      throw new Error('id (batch id or name) is required');
    })();
    let created: Id | undefined;
    switch (action) {
      case 'list':
        break;
      case 'add_phase':
        st().apply('Add phase', (d) => void (created = addPhase(d, input.name as string | undefined, input.color as string | undefined)));
        break;
      case 'update_phase': {
        const id = findPhase();
        st().apply('Update phase', (d) => updatePhase(d, id, { ...(input.name ? { name: String(input.name) } : {}), ...(input.color ? { color: String(input.color) } : {}) }));
        break;
      }
      case 'delete_phase': {
        const id = findPhase();
        st().apply('Delete phase', (d) => deletePhase(d, id));
        break;
      }
      case 'move_phase': {
        const id = findPhase();
        st().apply('Reorder phases', (d) => movePhase(d, id, Number(input.delta ?? 1)));
        break;
      }
      case 'add_batch': {
        const ph = phaseId(p, input.phase) ?? undefined;
        st().apply('Add batch', (d) => void (created = addBatch(d, input.name as string | undefined, { ...(input.date ? { date: String(input.date) } : {}), ...(ph ? { phase: ph } : {}) })));
        break;
      }
      case 'update_batch': {
        const id = findBatch();
        const ph = phaseId(p, input.phase);
        st().apply('Update batch', (d) =>
          updateBatch(d, id, { ...(input.name ? { name: String(input.name) } : {}), ...(input.date !== undefined ? { date: String(input.date) || undefined } : {}), ...(ph !== undefined ? { phase: ph ?? undefined } : {}) }),
        );
        break;
      }
      case 'delete_batch': {
        const id = findBatch();
        st().apply('Delete batch', (d) => deleteBatch(d, id));
        break;
      }
      case 'move_batch': {
        const id = findBatch();
        st().apply('Reorder batches', (d) => moveBatch(d, id, Number(input.delta ?? 1)));
        break;
      }
      default:
        throw new Error(`Unknown action ${action}`);
    }
    return { ...(created ? { created } : {}), ...groupsSummary(st().project) };
  },

  assign_phase_zone_batch(input: Json) {
    const p = st().project;
    const ids = resolve(p, input.members as MemberFilter | undefined);
    const patch = {
      phase: phaseId(p, input.phase),
      batch: batchId(p, input.batch),
      zone: input.zone === undefined ? undefined : String(input.zone) || null,
    };
    let changed = 0;
    if (ids.length && (patch.phase !== undefined || patch.batch !== undefined || patch.zone !== undefined)) {
      st().apply('Assign phase / zone / batch', (d) => void (changed = setGrouping(d, ids, patch)));
    }
    if (input.colorBy) st().set({ display: { ...st().display, colorBy: input.colorBy as ColorBy } });
    if (input.clearSelectionFilter) st().set({ selectFilter: null });
    if (input.selectionFilter) {
      const f = input.selectionFilter as { phase?: string; zone?: string; batch?: string };
      st().set({
        selectFilter: {
          ...(f.phase !== undefined ? { phase: f.phase === '' ? '' : (phaseId(p, f.phase) as string) } : {}),
          ...(f.zone !== undefined ? { zone: f.zone } : {}),
          ...(f.batch !== undefined ? { batch: f.batch === '' ? '' : (batchId(p, f.batch) as string) } : {}),
        },
      });
    }
    if (input.select) st().select({ members: ids });
    return { matched: ids.length, changed, ...groupsSummary(st().project) };
  },

  assembly_marks(input: Json) {
    const action = String(input.action);
    if (action === 'lock') st().apply('Lock marks', (d) => void lockMarks(d, derived(st().project)));
    else if (action === 'unlock') st().apply('Unlock marks', (d) => unlockMarks(d));
    else if (action === 'override') {
      const ids = resolve(st().project, input.members as MemberFilter | undefined);
      if (!ids.length) throw new Error('No members matched — pass members (e.g. {"selected": true}).');
      st().apply('Manual mark', (d) => void setMarkOverride(d, ids, (input.mark as string) || null));
    } else if (action !== 'status') throw new Error(`Unknown action ${action}`);
    const p = st().project;
    const dm = derived(p);
    const sum = markLockSummary(p, dm);
    const ids = input.members ? resolve(p, input.members as MemberFilter) : [];
    return {
      ...sum,
      changed: sum.changed.slice(0, 30),
      members: ids.slice(0, 30).map((id) => ({ id, mark: dm.partByRef.get(`m:${id}`)?.assembly ?? null, manual: p.members[id]?.markOverride ?? null })),
    };
  },

  async clash_detection(input: Json) {
    const action = String(input.action);
    const limit = Number(input.limit ?? 25);
    if (action === 'run') {
      if (typeof input.clearance === 'number') {
        const c = input.clearance;
        st().apply('Clash clearance', (d) => void (d.clashes.clearance = Math.max(0, c)));
      }
      if (typeof input.steelSteel === 'boolean') {
        const v = input.steelSteel;
        st().apply('Clash settings', (d) => void (d.clashes.steelSteel = v));
      }
      const c = st().project.clashes;
      const res = await runClashDetection({ steelSteel: c.steelSteel !== false, touchTolerance: c.touchTolerance ?? 1 });
      if (!res) throw new Error('Clash detection did not run (already running or failed).');
      st().set({ outputs: { open: true, tab: 'clashes' } });
    } else if (action === 'set_status') {
      const ids = (input.ids as string[] | undefined) ?? [];
      if (!ids.length || !input.status) throw new Error('ids and status are required');
      for (const id of ids) updateIssue(id, { status: input.status as 'open' | 'resolved' | 'ignored', ...(input.comment !== undefined ? { comment: String(input.comment) } : {}) });
    } else if (action === 'export_bcf') exportBcfFile(['open']);
    else if (action !== 'list') throw new Error(`Unknown action ${action}`);
    const c = st().project.clashes;
    return {
      clearance: c.clearance,
      summary: clashSummary(c.issues),
      issues: c.issues.slice(0, limit).map((x) => ({ id: x.id, kind: x.kind, status: x.status, title: x.title, mm: x.distance, at: [Math.round(x.pos.x), Math.round(x.pos.y), Math.round(x.pos.z)], comment: x.comment })),
    };
  },

  import_panel_layout(input: Json) {
    const plane = { kind: input.plane === 'YZ' ? 'YZ' : 'XZ', offset: Number(input.offset ?? 0) } as const;
    const layout = panelLayoutFromDxf(String(input.dxf ?? ''), {
      ...(input.scale ? { scale: Number(input.scale) } : {}),
      ...(Array.isArray(input.jointLayers) ? { jointLayers: input.jointLayers as string[] } : {}),
    });
    const joints = extractJoints(layout, { tolerance: Number(input.tolerance ?? 30), includePerimeter: input.includePerimeter !== false });
    const preview = previewSubframe(layout, joints);
    if (input.preview) return { preview, warnings: layout.warnings, layers: layout.layers };
    let ids: Id[] = [];
    st().apply('Sub-frame from panel layout', (d) => {
      ids = generateSubframe(d, joints, { plane, cavity: Number(input.cavity ?? 120), split: (input.split as 'transoms' | 'all' | 'none') ?? 'transoms' });
    });
    st().select({ members: ids });
    const p = st().project;
    const by: Record<string, number> = {};
    for (const id of ids) by[p.members[id].role] = (by[p.members[id].role] ?? 0) + 1;
    return { preview, created: ids.length, byRole: by, warnings: layout.warnings };
  },

  async ifc_steel_import(input: Json) {
    const p = st().project;
    const opts: IfcSteelImportOptions = { plates: input.plates !== false, skipConnectionParts: !!input.skipConnectionParts };
    let bytes: Uint8Array;
    if (typeof input.ifcText === 'string' && input.ifcText.trim()) bytes = new TextEncoder().encode(input.ifcText);
    else {
      const refs = p.references.filter((r) => r.kind === 'ifc');
      const want = input.referenceId ? String(input.referenceId) : '';
      const r = want ? refs.find((x) => x.id === want || x.name === want) : refs[0];
      if (!r) throw new Error(refs.length ? `No IFC reference "${want}". References: ${refs.map((x) => x.name).join(', ')}` : 'No IFC reference model in the project — ask the user to use Import → IFC steel → editable members.');
      const buf = await getBlob(r.id);
      if (!buf) throw new Error(`${r.name} is not in this browser's storage — it must be imported again.`);
      bytes = new Uint8Array(buf);
      opts.offset = r.offset;
    }
    const api = await getIfcApi();
    const read = readIfcSteelFromBytes(api, bytes, p, opts);
    const summary = summarizeIfcSteel(read);
    let imported: { members: number; plates: number } | undefined;
    if (input.apply) {
      let res = { members: [] as Id[], plates: [] as Id[] };
      st().apply('Import IFC steel', (d) => void (res = applyIfcSteel(d, read)));
      st().select({ members: res.members });
      imported = { members: res.members.length, plates: res.plates.length };
    }
    return { ...summary, profiles: summary.profiles.slice(0, 30), warnings: summary.warnings.slice(0, 15), ...(imported ? { imported } : {}) };
  },
};

export const managementModule: ToolModule = { tools, run };
