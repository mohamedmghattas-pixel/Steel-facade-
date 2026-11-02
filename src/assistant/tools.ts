/**
 * Tools the assistant can call. Every model edit goes through the store's
 * `apply`, so each change is undoable exactly like a button press.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectionType, Finish, Id, Member, MemberRole, ParamValue, PlaneKind, Project } from '../core/model/types';
import { MEMBER_ROLES } from '../core/model/types';
import {
  addLine,
  autoAssign,
  copyMembers,
  deleteConnections,
  deleteMembers,
  facadeGrid,
  memberDirection,
  moveItems,
  newId,
  splitAtIntersections,
  splitLineAtCrossings,
  updateMembers,
} from '../core/model/ops';
import { dist } from '../core/model/geometry';
import { mirrorMembers as mirrorModify } from '../core/model/modify';
import { connectionSummaryText, type ConnectionSummary } from '../core/model/connectionFollow';
import { AUTO_DEFAULTS, CONNECTIONS, applyAutoPlan, applyConnection, paramSpecs, planAutoConnect, type AutoConnectOptions } from '../core/connections/registry';
import { loadAutoStructure } from '../ui/autoConnectActions';
import { getProfile, profileFromDef, searchProfiles } from '../core/library/profiles';
import { MATERIALS } from '../core/library/materials';
import { buildBom } from '../core/reports/bom';
import { nestBars } from '../core/optimize/barNesting';
import { issueDrawings } from '../core/drawings';
import { sampleProject } from '../core/sample';
import { derived, useStore } from '../state/store';
import { currentDrawingSet, requestIndex } from '../ui/drawingJobs';
import {
  exportBom,
  exportDrawingsDxf,
  exportDrawingsPdf,
  exportIfcFile,
  exportNc,
  saveProjectFile,
} from '../ui/actions';
import { codeChecks } from './checks';
import { TOOL_MODULES } from './modules';

type Json = Record<string, unknown>;

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const vec3 = { type: 'array', items: num, minItems: 3, maxItems: 3, description: '[x, y, z] in mm' } as const;
const memberFilter = {
  type: 'object',
  description: 'Which members: explicit ids, or filters combined with AND. Use {"selected": true} for the user\'s current selection, {"all": true} for everything.',
  properties: {
    ids: { type: 'array', items: str },
    selected: { type: 'boolean' },
    all: { type: 'boolean' },
    role: { type: 'string', enum: MEMBER_ROLES },
    profile: { type: 'string', description: 'Exact profile name, or "none" for plain wireframe lines' },
    direction: { type: 'string', enum: ['vertical', 'horizontal', 'inclined'] },
  },
} as const;
const CONN_TYPES = Object.keys(CONNECTIONS) as ConnectionType[];

const BASE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_model_summary',
    description:
      'Snapshot of the project: info, levels, grids, members by role and profile, connections by type, steel mass, warnings, the user\'s current selection, drawing status and key settings. Call this first when you need to know what is in the model.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_members',
    description: 'List members (wireframe lines) matching a filter with id, role, profile, end coordinates, length and assembly mark.',
    input_schema: { type: 'object', properties: { filter: memberFilter, limit: { type: 'integer', description: 'Default 60' } }, required: ['filter'] },
  },
  {
    name: 'select',
    description: 'Highlight members in the 3D view by filter (replaces the selection). Use so the user sees what you are talking about or before they act.',
    input_schema: { type: 'object', properties: { filter: memberFilter }, required: ['filter'] },
  },
  {
    name: 'create_facade_grid',
    description:
      'Generate a facade frame on a vertical plane: mullions on every bay line (split at floor lines) and transoms on horizontal lines. Coordinates in mm. Plane XZ = facade along X at y = offset; YZ = facade along Y at x = offset.',
    input_schema: {
      type: 'object',
      properties: {
        plane: { type: 'string', enum: ['XZ', 'YZ'] },
        offset: num,
        u0: { type: 'number', description: 'Start along the facade' },
        v0: { type: 'number', description: 'Bottom elevation' },
        bays: { type: 'array', items: num, description: 'Bay widths left → right' },
        rows: { type: 'array', items: num, description: 'Heights between horizontal lines, bottom → top' },
        floorLines: { type: 'array', items: { type: 'integer' }, description: 'Indices of horizontal lines that are slab levels (0 = bottom)' },
        mullionProfile: str,
        transomProfile: str,
        floorTransoms: { type: 'boolean', description: 'Also place transoms on floor lines (default false)' },
      },
      required: ['plane', 'bays', 'rows', 'floorLines'],
    },
  },
  {
    name: 'add_lines',
    description: 'Add wireframe lines (each from a to b, mm). With a profile they become members. New lines are split where they cross existing members.',
    input_schema: {
      type: 'object',
      properties: {
        lines: { type: 'array', items: { type: 'object', properties: { a: vec3, b: vec3 }, required: ['a', 'b'] } },
        profile: str,
        role: { type: 'string', enum: MEMBER_ROLES },
      },
      required: ['lines'],
    },
  },
  {
    name: 'set_member_properties',
    description:
      'Change properties of the members matching the filter: profile, role, material, finish, rotation (deg about the axis), alignment (-1/0/1 on the 3×3 grid; alignMode insertion = through the profile insertion point), offsets and end extensions (mm).',
    input_schema: {
      type: 'object',
      properties: {
        filter: memberFilter,
        profile: str,
        role: { type: 'string', enum: MEMBER_ROLES },
        material: { type: 'string', enum: MATERIALS.map((m) => m.name) },
        finish: { type: 'string', enum: ['none', 'hdg', 'paint', 'hdg+paint'] },
        rotation: num,
        alignY: { type: 'integer', enum: [-1, 0, 1] },
        alignZ: { type: 'integer', enum: [-1, 0, 1] },
        alignMode: { type: 'string', enum: ['grid', 'insertion'] },
        offsetY: num,
        offsetZ: num,
        startExt: num,
        endExt: num,
      },
      required: ['filter'],
    },
  },
  {
    name: 'auto_assign_profiles',
    description: 'Assign profiles and roles to members by the project rules (direction / DXF layer).',
    input_schema: { type: 'object', properties: { filter: memberFilter }, required: ['filter'] },
  },
  {
    name: 'edit_geometry',
    description: 'Move, copy (array) or delete members, split lines at their crossings, or mirror (copy) members in a plane (mirrorPoint + mirrorNormal; sections, surface normals and connections are mirrored). Connections go with moved members and are copied with copies.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'copy', 'delete', 'split', 'mirror'] },
        filter: memberFilter,
        delta: vec3,
        mirrorPoint: vec3,
        mirrorNormal: vec3,
        count: { type: 'integer', description: 'Copies for "copy" (each shifted by delta × i)' },
      },
      required: ['action', 'filter'],
    },
  },
  {
    name: 'search_profiles',
    description: 'Search the profile library (EN, BS, AISC and custom). Returns names with mass and section properties.',
    input_schema: { type: 'object', properties: { query: str, standard: str, limit: { type: 'integer' } }, required: ['query'] },
  },
  {
    name: 'add_custom_profiles',
    description:
      'Add custom cross-sections to the project library (e.g. a supplier rail or a non-standard tube). Shape types and fields (mm): I/U {h,b,tw,tf,r}, L {h,b,t,r}, T {h,b,tw,tf,r}, RHS {h,b,t,ro}, CHS {d,t}, RD {d}, FL {h,t}, C/Z (lipped cold-formed) {h,b,c,t}. Mass is computed from the shape unless given (kg/m).',
    input_schema: {
      type: 'object',
      properties: {
        profiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: str, family: str, shape: { type: 'object', description: 'e.g. {"type":"RHS","h":120,"b":60,"t":4,"ro":8}' }, mass: num },
            required: ['name', 'shape'],
          },
        },
      },
      required: ['profiles'],
    },
  },
  {
    name: 'describe_connection_types',
    description: 'List connection types with their parameters and defaults, plus the custom templates and saved presets in the project library.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'apply_connection',
    description:
      'Apply a connection type with parameters to the members matching the filter, at every end where it makes sense (joints where a member meets another; base plates at the lower end; slab brackets by mullion rules; splice plates between collinear members). For a custom template pass params.template = template id.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: CONN_TYPES },
        filter: memberFilter,
        params: { type: 'object', description: 'Parameter values, e.g. {"t": 12, "bolt": "M16"}' },
        replace: { type: 'boolean', description: 'Replace existing connections on those member ends' },
      },
      required: ['type', 'filter'],
    },
  },
  {
    name: 'auto_connect',
    description:
      'Place connections by member roles and topology across the model (or the members matching the filter): transom joints at T-junctions, splices at mullion stack joints (collinear gaps), mullion brackets where each mullion length is nearest the visible IFC / 3dm reference structure, bracket-stub joints, slab brackets at levels for vertical mullions, base plates under posts. dryRun: counts per rule and notes only.',
    input_schema: {
      type: 'object',
      properties: {
        filter: memberFilter,
        joint: { type: 'string', enum: ['angleCleat', 'finPlate', 'endPlate', 'doubleAngle', 'teeCleat', 'welded', 'none'] },
        stackJoint: { type: 'string', enum: ['sleeveSplice', 'splicePlates', 'endPlateSplice', 'none'] },
        structureBracket: { type: 'string', enum: ['slabBracket', 'helpingHand', 'adjustableBracket', 'castInChannel', 'embedPlate', 'none'] },
        structureDistance: { type: 'number', description: 'Largest mullion-to-structure distance, mm (600)' },
        stubEnd: { type: 'string', enum: ['anchorPlate', 'wallAngle', 'baseplate', 'none'] },
        stubJoint: { type: 'string', enum: ['endPlate', 'finPlate', 'angleCleat', 'welded', 'none'] },
        levelBrackets: { type: 'boolean', description: 'Slab brackets at levels / chain ends of vertical mullions (default true)' },
        slabSide: { type: 'integer', enum: [1, -1] },
        standoff: { type: 'number', description: 'Level brackets: wire line to slab face, mm' },
        dryRun: { type: 'boolean' },
      },
    },
  },
  {
    name: 'set_connection_params',
    description: 'Change parameters of existing connections, chosen by ids or by type (optionally only those on the selected members).',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: str },
        type: { type: 'string', enum: CONN_TYPES },
        onSelectedMembers: { type: 'boolean' },
        params: { type: 'object' },
      },
      required: ['params'],
    },
  },
  {
    name: 'delete_connections',
    description: 'Delete connections by ids or by type.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: str }, type: { type: 'string', enum: CONN_TYPES } } },
  },
  {
    name: 'save_custom_template',
    description:
      'Create or replace a custom connection template in the project library. Plates are formulas over template params and the joint variables h_sec, b_sec, h_main, b_main, depth_main, face; functions max, min, round, ceil, floor, abs, ceilto(x, step). Frame: u along the secondary away from the main face, w up (local z), v = w × u (frame "joint", default; "member" = v along local y at both ends). plane "end" = across the member end (width along v, height along w, centred at v,w, contact at u); "side" = width along u from u, height along w centred at w, contact at v; "top" = width along u, height along v centred at v, contact at w. place "centre" puts the mid-plane at the contact value. weldTo: "main" | "secondary" | "none" | another plate key. bolts.through: "main" | "secondary" | "none" | "concrete" (anchors). cut = cut-back of the secondary from the main face.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing template id to replace (omit to create)' },
        name: str,
        description: str,
        needsMain: { type: 'boolean' },
        frame: { type: 'string', enum: ['joint', 'member'] },
        params: { type: 'array', items: { type: 'object', properties: { key: str, label: str, default: num }, required: ['key', 'default'] } },
        cut: str,
        plates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: str,
              name: str,
              plane: { type: 'string', enum: ['end', 'side', 'top'] },
              t: str,
              width: str,
              height: str,
              u: str,
              v: str,
              w: str,
              place: { type: 'string', enum: ['face', 'centre'] },
              weldTo: str,
              bolts: {
                type: 'object',
                properties: {
                  size: str,
                  grade: str,
                  rows: str,
                  cols: str,
                  pitch: str,
                  gauge: str,
                  through: { type: 'string', enum: ['main', 'secondary', 'none', 'concrete'] },
                  slot: str,
                  slotAlong: { type: 'string', enum: ['width', 'height'] },
                  anchorLength: str,
                },
                required: ['size', 'rows', 'cols', 'pitch', 'gauge', 'through'],
              },
            },
            required: ['key', 'name', 'plane', 't', 'width', 'height', 'u', 'v', 'w', 'weldTo'],
          },
        },
      },
      required: ['name', 'needsMain', 'params', 'cut', 'plates'],
    },
  },
  {
    name: 'set_project',
    description: 'Update project info, settings and drawing settings. Only the fields you pass change.',
    input_schema: {
      type: 'object',
      properties: {
        name: str,
        number: str,
        client: str,
        designer: str,
        designCode: { type: 'string', enum: ['auto', 'AISC360', 'EC3'] },
        drawingStandard: { type: 'string', enum: ['ISO', 'ASME'] },
        executionClass: { type: 'string', enum: ['EXC1', 'EXC2', 'EXC3', 'EXC4'] },
        weldSize: num,
        stockLengths: { type: 'array', items: num },
        kerf: num,
        defaultMaterial: str,
        defaultFinish: { type: 'string', enum: ['none', 'hdg', 'paint', 'hdg+paint'] },
        levels: { type: 'array', items: { type: 'object', properties: { name: str, z: num }, required: ['name', 'z'] }, description: 'Replaces all levels' },
        grids: { type: 'array', items: { type: 'object', properties: { name: str, axis: { type: 'string', enum: ['x', 'y'] }, pos: num }, required: ['name', 'axis', 'pos'] }, description: 'Replaces all grids' },
      },
    },
  },
  {
    name: 'run_checks',
    description: 'Run model checks and detailing-code checks (edge distances, spacing, hole sizes, weld sizes, coating) and return the findings with clause references.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'get_reports',
    description: 'Material list totals, profile summary, bolt list and cut-optimisation summary.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'drawings',
    description: 'List drawings with number, revision and status, or issue (revise) them.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'issue'] },
        which: { type: 'string', enum: ['changed', 'all'] },
        description: str,
        status: { type: 'string', enum: ['In approval', 'Released', 'In preparation', 'Withdrawn'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'export',
    description: 'Download an export file for the user.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['ifc', 'bom_xlsx', 'bom_csv', 'nc_dstv', 'drawings_pdf', 'drawings_dxf', 'project_json'] } },
      required: ['kind'],
    },
  },
  {
    name: 'view',
    description: 'Change the 3D view, work plane, display toggles, or open an output panel tab.',
    input_schema: {
      type: 'object',
      properties: {
        camera: { type: 'string', enum: ['3d', 'front', 'plan', 'side', 'fit'] },
        workPlane: { type: 'string', enum: ['XY', 'XZ', 'YZ'] },
        workPlaneOffset: num,
        showMarks: { type: 'boolean' },
        outputs: { type: 'string', enum: ['bom', 'nesting', 'drawings', 'checks', 'close'] },
      },
    },
  },
  {
    name: 'history',
    description: 'Undo or redo the last change(s), or load the sample facade project.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['undo', 'redo', 'load_sample'] }, steps: { type: 'integer' } }, required: ['action'] },
  },
];

/** Every tool: the core set plus the feature modules (see ./modules). */
export const TOOLS: Anthropic.Beta.BetaTool[] = [...BASE_TOOLS, ...TOOL_MODULES.flatMap((m) => m.tools)];

// ---------------------------------------------------------------------------

const st = () => useStore.getState();
const round = (v: number) => Math.round(v * 10) / 10;

interface Filter {
  ids?: string[];
  selected?: boolean;
  all?: boolean;
  role?: MemberRole;
  profile?: string;
  direction?: 'vertical' | 'horizontal' | 'inclined';
}

function resolveMembers(p: Project, f: Filter | undefined): Id[] {
  if (!f) return [];
  let list = Object.values(p.members);
  if (f.ids?.length) list = list.filter((m) => f.ids!.includes(m.id));
  else if (f.selected) {
    const sel = new Set(st().selection.members);
    list = list.filter((m) => sel.has(m.id));
  } else if (!f.all && !f.role && !f.profile && !f.direction) return [];
  if (f.role) list = list.filter((m) => m.role === f.role);
  if (f.profile) list = list.filter((m) => (f.profile === 'none' ? !m.profile : m.profile === f.profile));
  if (f.direction) list = list.filter((m) => memberDirection(p, m) === f.direction);
  return list.map((m) => m.id);
}

const pt = (v: number[]) => ({ x: v[0], y: v[1], z: v[2] });

function summary(): Json {
  const p = st().project;
  const dm = derived(p);
  const roles: Record<string, { count: number; profiles: Record<string, number> }> = {};
  for (const m of Object.values(p.members)) {
    const r = (roles[m.role] ??= { count: 0, profiles: {} });
    r.count++;
    const k = m.profile ?? 'none (wireframe)';
    r.profiles[k] = (r.profiles[k] ?? 0) + 1;
  }
  const conns: Record<string, number> = {};
  for (const c of Object.values(p.connections)) conns[c.type] = (conns[c.type] ?? 0) + 1;
  const sel = st().selection;
  const ds = safeDrawings();
  return {
    project: p.info,
    levels: p.levels.map((l) => ({ name: l.name, z: l.z })),
    grids: p.grids.map((g) => ({ name: g.name, axis: g.axis, pos: g.pos })),
    members: Object.keys(p.members).length,
    byRole: roles,
    connections: conns,
    steelKg: round(dm.parts.reduce((s, x) => s + x.mass, 0)),
    assemblies: dm.assemblies.length,
    warnings: dm.warnings.length,
    selection: { members: sel.members.length, connections: sel.connections.length, memberIds: sel.members.slice(0, 40) },
    drawings: ds ? { count: ds.length, changed: ds.filter((d) => d.changed === true).length, notCheckedYet: ds.filter((d) => d.changed === undefined).length } : { count: null, note: 'the drawing register of this large model is still being built' },
    settings: {
      designCode: p.settings.designCode,
      drawingStandard: p.drawings.settings.standard,
      executionClass: p.drawings.settings.executionClass,
      stockLengths: p.settings.stockLengths,
      defaultMaterial: p.settings.defaultMaterial,
      defaultFinish: p.settings.defaultFinish,
      workPlane: st().workPlane,
    },
    templates: p.library.templates.map((t) => ({ id: t.id, name: t.name })),
  };
}

/** The drawing index (register) when it is known without blocking the page for long. */
function safeDrawings() {
  try {
    const set = currentDrawingSet();
    const idx = set.ready ?? (set.dm.parts.length < 20000 ? set.index() : null);
    if (!idx) return null;
    for (const e of idx.entries) if (e.changed === undefined) set.refresh(e, false);
    return idx.entries;
  } catch {
    return [];
  }
}

function memberRow(p: Project, m: Member, marks: Map<string, string>): Json {
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  return {
    id: m.id,
    role: m.role,
    profile: m.profile,
    a: [round(a.x), round(a.y), round(a.z)],
    b: [round(b.x), round(b.y), round(b.z)],
    length: round(dist(a, b)),
    mark: marks.get(m.id) ?? null,
  };
}

/** Execute a tool; returns a JSON string for the tool_result. Throws on invalid use. */
export async function runTool(name: string, input: Json): Promise<string> {
  const s = st();
  const p = s.project;
  const out = (v: unknown) => JSON.stringify(v);
  switch (name) {
    case 'get_model_summary':
      return out(summary());

    case 'list_members': {
      const ids = resolveMembers(p, input.filter as Filter);
      const dm = derived(p);
      const marks = new Map(dm.parts.filter((x) => x.memberId).map((x) => [x.memberId!, x.assembly]));
      const limit = Number(input.limit ?? 60);
      return out({ total: ids.length, members: ids.slice(0, limit).map((id) => memberRow(p, p.members[id], marks)) });
    }

    case 'select': {
      const ids = resolveMembers(p, input.filter as Filter);
      s.select({ members: ids });
      return out({ selected: ids.length });
    }

    case 'create_facade_grid': {
      const plane = (input.plane as PlaneKind) ?? 'XZ';
      for (const k of ['mullionProfile', 'transomProfile'] as const) {
        if (input[k] && !getProfile(input[k] as string)) throw new Error(`Unknown profile "${input[k]}". Use search_profiles.`);
      }
      let ids: Id[] = [];
      s.apply('Assistant: facade grid', (d) => {
        ids = facadeGrid(d, {
          plane: { kind: plane, offset: Number(input.offset ?? 0) },
          u0: Number(input.u0 ?? 0),
          v0: Number(input.v0 ?? 0),
          bays: input.bays as number[],
          rows: input.rows as number[],
          floorLines: input.floorLines as number[],
          mullionProfile: (input.mullionProfile as string) ?? null,
          transomProfile: (input.transomProfile as string) ?? null,
          transomDepthNormal: true,
          addLevels: true,
          floorTransoms: Boolean(input.floorTransoms),
        });
      });
      s.select({ members: ids });
      s.set({ zoomRequest: Date.now() });
      return out({ created: ids.length });
    }

    case 'add_lines': {
      const profile = input.profile as string | undefined;
      if (profile && !getProfile(profile)) throw new Error(`Unknown profile "${profile}".`);
      const created: Id[] = [];
      s.apply('Assistant: add lines', (d) => {
        for (const l of input.lines as { a: number[]; b: number[] }[]) {
          const id = addLine(d, pt(l.a), pt(l.b), profile ? { profile, role: (input.role as MemberRole) ?? 'other' } : input.role ? { role: input.role as MemberRole } : {});
          if (id) created.push(...splitLineAtCrossings(d, id));
        }
      });
      s.select({ members: created });
      return out({ created: created.length, ids: created.slice(0, 50) });
    }

    case 'set_member_properties': {
      const ids = resolveMembers(p, input.filter as Filter);
      if (!ids.length) throw new Error('No members match the filter.');
      if (input.profile && !getProfile(input.profile as string)) throw new Error(`Unknown profile "${input.profile}". Use search_profiles.`);
      const patch: Partial<Member> = {};
      for (const k of ['profile', 'role', 'material', 'finish', 'rotation', 'alignY', 'alignZ', 'alignMode', 'offsetY', 'offsetZ', 'startExt', 'endExt'] as const) {
        if (input[k] !== undefined) (patch as Json)[k] = input[k];
      }
      if (patch.finish) patch.finish = patch.finish as Finish;
      s.apply('Assistant: member properties', (d) => updateMembers(d, ids, patch));
      return out({ updated: ids.length, patch });
    }

    case 'auto_assign_profiles': {
      const ids = resolveMembers(p, input.filter as Filter);
      let n = 0;
      s.apply('Assistant: auto-assign', (d) => {
        n = autoAssign(d, ids);
      });
      return out({ assigned: n, rules: p.settings.autoRules });
    }

    case 'edit_geometry': {
      const ids = resolveMembers(p, input.filter as Filter);
      const action = input.action as string;
      if (!ids.length && action !== 'split') throw new Error('No members match the filter.');
      const delta = input.delta ? pt(input.delta as number[]) : { x: 0, y: 0, z: 0 };
      let created: Id[] = [];
      let conns: ConnectionSummary | undefined;
      s.apply(`Assistant: ${action}`, (d) => {
        if (action === 'move') conns = moveItems(d, ids, [], delta);
        else if (action === 'copy') created = copyMembers(d, ids, delta, Math.max(1, Number(input.count ?? 1)), (x) => (conns = x));
        else if (action === 'delete') deleteMembers(d, ids);
        else if (action === 'split') splitAtIntersections(d, ids.length ? ids : undefined);
        else if (action === 'mirror') {
          if (!input.mirrorNormal) throw new Error('mirror needs mirrorNormal (and mirrorPoint, default the origin).');
          // Mirrored copies with their sections and connections mirrored (modify toolkit).
          const r = mirrorModify(d, ids, { point: input.mirrorPoint ? pt(input.mirrorPoint as number[]) : { x: 0, y: 0, z: 0 }, normal: pt(input.mirrorNormal as number[]) }, { copy: true });
          created = r.members;
          conns = r.connections;
        }
      });
      if (created.length) s.select({ members: created });
      const cs = conns ? connectionSummaryText(conns) : '';
      return out({ action, members: ids.length, created: created.length, ...(cs ? { connections: cs, connectionWarnings: conns!.warnings } : {}) });
    }

    case 'search_profiles': {
      const list = searchProfiles(String(input.query ?? ''), (input.standard as never) || undefined).slice(0, Number(input.limit ?? 25));
      return out(
        list.map((x) => ({ name: x.name, standard: x.standard, family: x.family, kgPerM: round(x.mass), h: round(x.h), b: round(x.b), Iy_cm4: round(x.Iy / 1e4), Wy_cm3: round(x.Wy / 1e3) })),
      );
    }

    case 'add_custom_profiles': {
      const defs: Record<string, unknown>[] = (input.profiles as Record<string, unknown>[]).map((d) => ({ standard: 'Custom', ...d }));
      const bad: string[] = [];
      for (const d of defs) {
        try {
          profileFromDef(d as never);
        } catch (e) {
          bad.push(`${d.name}: ${(e as Error).message}`);
        }
      }
      if (bad.length) throw new Error(`Invalid profile(s): ${bad.join('; ')}`);
      s.apply('Assistant: custom profiles', (d) => {
        const names = new Set(defs.map((x) => String(x.name)));
        d.library.profiles = [...d.library.profiles.filter((x) => !names.has(String(x.name))), ...defs];
      });
      return out({ added: defs.map((d) => ({ name: d.name, kgPerM: round(getProfile(String(d.name))?.mass ?? 0) })) });
    }

    case 'describe_connection_types':
      return out({
        types: Object.values(CONNECTIONS).map((d) => ({
          type: d.type,
          label: d.label,
          description: d.description,
          needsMain: d.needsMain,
          params: d.params.map((x) => ({ key: x.key, label: x.label, default: x.default, options: x.options })),
        })),
        templates: p.library.templates.map((t) => ({ id: t.id, name: t.name, needsMain: t.needsMain, params: t.params })),
        presets: p.library.presets,
      });

    case 'apply_connection': {
      const ids = resolveMembers(p, input.filter as Filter);
      if (!ids.length) throw new Error('No members match the filter.');
      const type = input.type as ConnectionType;
      let created: Id[] = [];
      s.apply(`Assistant: ${type}`, (d) => {
        created = applyConnection(d, ids, { type, params: (input.params as Record<string, ParamValue>) ?? {}, replace: Boolean(input.replace) });
      });
      const dm = derived(st().project);
      const warnings = dm.warnings.filter((w) => w.connectionId && created.includes(w.connectionId)).map((w) => w.text);
      return out({ created: created.length, warnings: warnings.slice(0, 20) });
    }

    case 'auto_connect': {
      const ids = input.filter ? new Set(resolveMembers(p, input.filter as Filter)) : undefined;
      const o: AutoConnectOptions = {
        ...AUTO_DEFAULTS,
        joint: (input.joint as AutoConnectOptions['joint']) ?? AUTO_DEFAULTS.joint,
        stackJoint: (input.stackJoint as AutoConnectOptions['stackJoint']) ?? AUTO_DEFAULTS.stackJoint,
        structureBracket: (input.structureBracket as AutoConnectOptions['structureBracket']) ?? AUTO_DEFAULTS.structureBracket,
        structureDistance: Number(input.structureDistance ?? AUTO_DEFAULTS.structureDistance),
        stubEnd: (input.stubEnd as AutoConnectOptions['stubEnd']) ?? AUTO_DEFAULTS.stubEnd,
        stubJoint: (input.stubJoint as AutoConnectOptions['stubJoint']) ?? AUTO_DEFAULTS.stubJoint,
        mullionBrackets: input.levelBrackets !== false,
        slabSide: input.slabSide === -1 ? -1 : 1,
        standoff: Number(input.standoff ?? AUTO_DEFAULTS.standoff),
      };
      const structure = o.structureBracket !== 'none' ? (await loadAutoStructure()).elements : [];
      const plan = planAutoConnect(p, o, ids, structure);
      const counts = Object.fromEntries(Object.entries(plan.counts).filter(([, n]) => n > 0));
      if (input.dryRun) return out({ dryRun: true, counts, byType: plan.byType, stats: plan.stats, notes: plan.notes });
      let created: Id[] = [];
      s.apply('Assistant: auto-connect', (d) => {
        created = applyAutoPlan(d, planAutoConnect(d, o, ids, structure));
      });
      return out({ created: created.length, counts, byType: plan.byType, stats: plan.stats, notes: plan.notes });
    }

    case 'set_connection_params': {
      const sel = new Set(st().selection.members);
      let list = Object.values(p.connections);
      if ((input.ids as string[] | undefined)?.length) list = list.filter((c) => (input.ids as string[]).includes(c.id));
      if (input.type) list = list.filter((c) => c.type === input.type);
      if (input.onSelectedMembers) list = list.filter((c) => c.secondary.some((m) => sel.has(m)) || (c.main && sel.has(c.main)));
      if (!list.length) throw new Error('No connections match.');
      const params = input.params as Record<string, ParamValue>;
      const known = new Set(list.flatMap((c) => paramSpecs(c, p).map((x) => x.key)));
      const unknown = Object.keys(params).filter((k) => !known.has(k));
      s.apply('Assistant: connection parameters', (d) => {
        for (const c of list) d.connections[c.id].params = { ...d.connections[c.id].params, ...params };
      });
      return out({ updated: list.length, unknownKeys: unknown });
    }

    case 'delete_connections': {
      let list = Object.values(p.connections);
      if ((input.ids as string[] | undefined)?.length) list = list.filter((c) => (input.ids as string[]).includes(c.id));
      else if (input.type) list = list.filter((c) => c.type === input.type);
      else throw new Error('Pass ids or type.');
      s.apply('Assistant: delete connections', (d) => deleteConnections(d, list.map((c) => c.id)));
      return out({ deleted: list.length });
    }

    case 'save_custom_template': {
      const id = (input.id as string) || newId('tpl');
      const tpl = { frame: 'joint', ...(input as object), id, description: String(input.description ?? '') } as Project['library']['templates'][number];
      s.apply('Assistant: custom template', (d) => {
        d.library.templates = [...d.library.templates.filter((t) => t.id !== id), tpl];
      });
      return out({ id, name: tpl.name, hint: 'Apply it with apply_connection type "custom" and params.template = id.' });
    }

    case 'set_project': {
      s.apply('Assistant: project settings', (d) => {
        for (const k of ['name', 'number', 'client', 'designer'] as const) if (input[k] !== undefined) d.info[k] = String(input[k]);
        if (input.designCode) d.settings.designCode = input.designCode as Project['settings']['designCode'];
        if (input.drawingStandard) d.drawings.settings.standard = input.drawingStandard as 'ISO' | 'ASME';
        if (input.executionClass) d.drawings.settings.executionClass = String(input.executionClass);
        if (input.weldSize) d.drawings.settings.weldSize = Number(input.weldSize);
        if (input.stockLengths) d.settings.stockLengths = input.stockLengths as number[];
        if (input.kerf !== undefined) d.settings.kerf = Number(input.kerf);
        if (input.defaultMaterial) d.settings.defaultMaterial = String(input.defaultMaterial);
        if (input.defaultFinish) d.settings.defaultFinish = input.defaultFinish as Finish;
        if (input.levels) d.levels = (input.levels as { name: string; z: number }[]).map((l) => ({ id: newId('lv'), ...l })).sort((a, b) => a.z - b.z);
        if (input.grids) d.grids = (input.grids as { name: string; axis: 'x' | 'y'; pos: number }[]).map((g) => ({ id: newId('g'), ...g }));
      });
      return out({ ok: true });
    }

    case 'run_checks': {
      const dm = derived(p);
      const limit = Number(input.limit ?? 40);
      const code = codeChecks(p, dm);
      return out({
        modelWarnings: dm.warnings.slice(0, limit).map((w) => w.text),
        codeChecks: code.slice(0, limit),
        totals: { modelWarnings: dm.warnings.length, codeChecks: code.length },
      });
    }

    case 'get_reports': {
      const dm = derived(p);
      const bom = buildBom(p, dm);
      const bars = nestBars(p, dm);
      return out({
        totals: bom.totals,
        profiles: bom.profiles.slice(0, 40),
        bolts: bom.bolts.slice(0, 30),
        nesting: bars.map((g) => ({ profile: g.profile, material: g.material, efficiency: round(g.efficiency * 100), purchase: g.purchase, unplaced: g.unplaced.length })),
      });
    }

    case 'drawings': {
      // The register; issuing makes the sheets whose fingerprints are not known yet (one at a time).
      const set = currentDrawingSet();
      const ds = (await requestIndex(set)).entries;
      if (input.action === 'issue') {
        for (const e of ds) if (input.which !== 'all' && e.changed === undefined) set.ensureMeta(e.id);
        for (const e of ds) set.refresh(e, false);
        const list = input.which === 'all' ? ds : ds.filter((d) => d.changed);
        let n = 0;
        const prints = list.map((x) => ({ id: x.id, fingerprint: set.ensureMeta(x.id)!.fingerprint }));
        s.apply('Assistant: issue drawings', (d) => {
          n = issueDrawings(
            d,
            prints,
            {
              description: String(input.description ?? 'Issued for approval'),
              status: (input.status as never) ?? 'In approval',
              date: new Date().toISOString().slice(0, 10),
              drawn: p.info.designer,
              checked: p.drawings.settings.checkedBy,
              approved: p.drawings.settings.approvedBy,
            },
          );
        });
        return out({ issued: n });
      }
      for (const e of ds) set.refresh(e, false);
      return out(ds.map((d) => ({ number: d.number, title: d.title, rev: d.rev, status: d.status ?? null, changed: d.changed ?? null, scale: d.scale ?? null })));
    }

    case 'export': {
      const kind = input.kind as string;
      if (kind === 'ifc') exportIfcFile();
      else if (kind === 'bom_xlsx') exportBom('xlsx');
      else if (kind === 'bom_csv') exportBom('csv');
      else if (kind === 'nc_dstv') exportNc();
      else if (kind === 'drawings_pdf') await exportDrawingsPdf();
      else if (kind === 'drawings_dxf') exportDrawingsDxf();
      else if (kind === 'project_json') saveProjectFile();
      return out({ downloaded: kind });
    }

    case 'view': {
      if (input.camera === 'fit') s.set({ zoomRequest: Date.now() });
      else if (input.camera) s.set({ viewRequest: { name: input.camera as never, n: Date.now() } });
      if (input.workPlane) s.setWorkPlane(input.workPlane as PlaneKind, input.workPlaneOffset !== undefined ? Number(input.workPlaneOffset) : undefined);
      if (input.showMarks !== undefined) s.set({ display: { ...s.display, labels: Boolean(input.showMarks) } });
      if (input.outputs === 'close') s.set({ outputs: { ...s.outputs, open: false } });
      else if (input.outputs) s.set({ outputs: { open: true, tab: input.outputs as never } });
      return out({ ok: true });
    }

    case 'history': {
      const n = Math.max(1, Number(input.steps ?? 1));
      if (input.action === 'load_sample') {
        s.replaceProject(sampleProject());
        s.set({ viewRequest: { name: '3d', n: Date.now() } });
        return out({ loaded: 'sample' });
      }
      for (let i = 0; i < n; i++) (input.action === 'undo' ? st().undo : st().redo)();
      return out({ [String(input.action)]: n });
    }
  }
  for (const m of TOOL_MODULES) {
    const handler = m.run[name];
    if (handler) return out(await handler(input));
  }
  throw new Error(`Unknown tool ${name}`);
}
