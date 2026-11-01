/**
 * Assistant tools for the member / profile modify operations (core/model/modify.ts):
 * join, split, extend / trim, break, move end, rotate / mirror / offset, section
 * operations, match properties, reverse, measure, and flipping connections to the
 * other side of their member. Every edit goes through store.apply (one undo
 * step); a refusal comes back as an error with the reason. Replies carry what
 * happened to the connections (moved with their member ends, re-pointed,
 * mirrored / re-oriented, copied, removed).
 */
import type { ToolModule, Json } from './types';
import { useStore } from '../../state/store';
import type { Id, MemberRole, Project, Vec3 } from '../../core/model/types';
import { MEMBER_ROLES } from '../../core/model/types';
import { memberDirection } from '../../core/model/ops';
import type { ConnectionSummary } from '../../core/model/connectionFollow';
import {
  MATCH_FIELDS,
  angleBetween,
  breakMember,
  changeProfile,
  collinear,
  cornerJoin,
  deleteSegment,
  extendBy,
  extendToMember,
  extendToPlane,
  flipConnectionSide,
  joinMembers,
  mergeSummaries,
  joinToMember,
  matchProperties,
  measureMember,
  mirrorMembers,
  mirrorSections,
  moveMemberEnd,
  offsetMembers,
  resolvePlane,
  reverseMembers,
  rotateMembers,
  rotateSections,
  setAlignment,
  setLength,
  splitAtCrossingMembers,
  splitAtDistance,
  splitAtLengths,
  splitAtPlane,
  splitAtPoint,
  splitInto,
  stepProfiles,
  trimAtBoundary,
  wireOf,
  type MatchField,
  type ModifyResult,
  connectionSummaryText,
  type PlaneSpec,
  type Plane3,
} from '../../core/model/modify';

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const vec3 = { type: 'array', items: num, minItems: 3, maxItems: 3, description: '[x, y, z] mm' } as const;
const endE = { type: 'string', enum: ['start', 'end'] } as const;
const filter = {
  type: 'object',
  description: 'Which members (AND): ids, or {"selected": true} (default when omitted), {"all": true}, role, profile ("none" = wire lines), direction.',
  properties: {
    ids: { type: 'array', items: str },
    selected: { type: 'boolean' },
    all: { type: 'boolean' },
    role: { type: 'string', enum: MEMBER_ROLES },
    profile: str,
    direction: { type: 'string', enum: ['vertical', 'horizontal', 'inclined'] },
  },
} as const;
const plane = {
  type: 'object',
  description: 'A plane: level (name or z), grid (name), workPlane (the active one), x / y / z = value, points [a, b, c], or point + normal.',
  properties: {
    kind: { type: 'string', enum: ['level', 'grid', 'workPlane', 'x', 'y', 'z', 'points', 'plane'] },
    name: str,
    value: num,
    points: { type: 'array', items: vec3, minItems: 3, maxItems: 3 },
    point: vec3,
    normal: vec3,
  },
  required: ['kind'],
} as const;
const endMode = { type: 'string', enum: ['auto', 'detach', 'node'], description: 'Moved ends: auto (default: move the node when nothing else uses it, else detach), detach (this member only), node (all members on it follow)' } as const;

const st = () => useStore.getState();
const v = (a: unknown, what: string): Vec3 => {
  if (!Array.isArray(a) || a.length !== 3 || a.some((x) => typeof x !== 'number')) throw new Error(`${what} must be [x, y, z].`);
  return { x: a[0], y: a[1], z: a[2] };
};

interface Filter {
  ids?: Id[];
  selected?: boolean;
  all?: boolean;
  role?: MemberRole;
  profile?: string;
  direction?: 'vertical' | 'horizontal' | 'inclined';
}

/** Members matching the filter (omitted: the selection). */
function members(p: Project, f: Filter | undefined): Id[] {
  let list = Object.values(p.members);
  if (f?.ids?.length) list = list.filter((m) => f.ids!.includes(m.id));
  else if (!f || f.selected || (!f.all && !f.role && !f.profile && !f.direction)) {
    const sel = new Set(st().selection.members);
    list = list.filter((m) => sel.has(m.id));
  }
  if (f?.role) list = list.filter((m) => m.role === f.role);
  if (f?.profile) list = list.filter((m) => (f.profile === 'none' ? !m.profile : m.profile === f.profile));
  if (f?.direction) list = list.filter((m) => memberDirection(p, m) === f.direction);
  if (!list.length) throw new Error('No members match: pass ids or a filter, or ask the user to select members.');
  return list.map((m) => m.id);
}

const one = (input: Json, key = 'member'): Id => {
  const id = input[key];
  if (typeof id !== 'string' || !st().project.members[id]) throw new Error(`${key}: pass an existing member id.`);
  return id;
};

function planeOf(p: Project, x: unknown): Plane3 {
  const o = (x ?? {}) as { kind?: string; name?: string; value?: number; points?: unknown[]; point?: unknown; normal?: unknown };
  let spec: PlaneSpec;
  switch (o.kind) {
    case 'level':
      spec = { kind: 'level', name: o.name, z: o.value };
      break;
    case 'grid':
      spec = { kind: 'grid', name: o.name };
      break;
    case 'workPlane':
      spec = { kind: 'workPlane', plane: st().workPlane };
      break;
    case 'x':
    case 'y':
    case 'z':
      if (typeof o.value !== 'number') throw new Error('plane.value is needed.');
      spec = { kind: o.kind, value: o.value };
      break;
    case 'points':
      if (!o.points || o.points.length !== 3) throw new Error('plane.points needs three points.');
      spec = { kind: 'points', a: v(o.points[0], 'point'), b: v(o.points[1], 'point'), c: v(o.points[2], 'point') };
      break;
    case 'plane':
      spec = { kind: 'plane', point: v(o.point, 'plane.point'), normal: v(o.normal, 'plane.normal') };
      break;
    default:
      throw new Error('plane.kind must be level, grid, workPlane, x, y, z, points or plane.');
  }
  return resolvePlane(p, spec);
}

/** What happened to the connections, for the reply (ids and counts). */
function connectionReport(s: ConnectionSummary | undefined): Json | undefined {
  if (!s) return undefined;
  const n = s.moved.length + s.repointed.length + s.transformed.length + s.copied.length + s.removed.length;
  if (!n) return undefined;
  return {
    summary: connectionSummaryText(s),
    moved: s.moved,
    repointed: s.repointed,
    transformed: s.transformed,
    copied: s.copied,
    removed: s.removed.map((r) => ({ id: r.id, type: r.label })),
  };
}

/** Run an operation as one undo step; select its result; return the report. */
function run(label: string, op: (d: Project) => ModifyResult): Json {
  let r: ModifyResult | null = null;
  st().apply(label, (d) => {
    r = op(d);
  });
  const res = r as unknown as ModifyResult;
  if (res.members.length) st().select({ members: res.members.filter((id) => st().project.members[id]) });
  const connections = connectionReport(res.connections);
  return { message: res.message, members: res.members, removed: res.removed, warnings: res.warnings, ...(connections ? { connections } : {}) };
}

export const modifyModule: ToolModule = {
  tools: [
    {
      name: 'modify_join',
      description:
        'Join members. Collinear members sharing a node, or with a small gap / overlap (maxGap, default 100 mm), become one member (the longest keeps its id; connections of the pieces on the joint, e.g. a splice, are removed and reported; refused when properties differ unless keep = "first"). Two non-collinear members: mode corner (default) extends / trims both to where their axes meet (3D, within tol, default 50 mm) and merges the ends; mode tee extends the first member\'s end onto the second\'s axis (splitB also splits the second there).',
      input_schema: {
        type: 'object',
        properties: {
          members: { type: 'array', items: str, minItems: 2 },
          mode: { type: 'string', enum: ['auto', 'collinear', 'corner', 'tee'] },
          keep: { type: 'string', enum: ['longest', 'first'] },
          maxGap: num,
          tol: num,
          splitB: { type: 'boolean' },
        },
        required: ['members'],
      },
    },
    {
      name: 'modify_split',
      description:
        'Split members: at a point (nearest point on the axis), at a distance from the start or end, into `parts` equal parts, into pieces of `length` (stock length, remainder at the other end), at a plane, or at crossings (only these members are cut where others cross or end on them; mullionTransomOnly = only mullion–transom junctions). Give exactly one of point, distance, parts, length, plane, crossings.',
      input_schema: {
        type: 'object',
        properties: {
          filter,
          point: vec3,
          distance: num,
          from: endE,
          parts: { type: 'integer', minimum: 2 },
          length: num,
          plane,
          crossings: { type: 'boolean' },
          mullionTransomOnly: { type: 'boolean' },
        },
      },
    },
    {
      name: 'modify_extend',
      description:
        'Extend or shorten members along their own axis: by `distance` (negative shortens) at end start / end / both; to an exact `length` (anchor start, end or centre kept); to another member `toMember` (to: axis, or face = its true outer face, plus gap); or to a plane (level, grid line, work plane …; the nearer end unless `end`). Connections on a moved end go with it; face on an end with a joint keeps the wire on the axis and sets the joint gap.',
      input_schema: {
        type: 'object',
        properties: {
          filter,
          distance: num,
          end: { type: 'string', enum: ['start', 'end', 'both', 'auto'] },
          length: num,
          anchor: { type: 'string', enum: ['start', 'end', 'centre'] },
          toMember: str,
          to: { type: 'string', enum: ['axis', 'face'] },
          gap: num,
          plane,
          mode: endMode,
        },
      },
    },
    {
      name: 'modify_trim',
      description:
        'Trim a member. With `boundary`: cut it where the boundary member crosses it and keep the side `keep` (start, end, or a point [x, y, z] on the side to keep); the other piece is deleted with its connections. Without boundary: delete the segment between the two crossings either side of `at` (a point on the member) — AutoCAD-style.',
      input_schema: {
        type: 'object',
        properties: { member: str, boundary: str, keep: { description: '"start", "end" or [x, y, z]' }, at: vec3, tol: num },
        required: ['member'],
      },
    },
    {
      name: 'modify_break',
      description:
        'Break a member at `distance` from its start (or the point `at`) and open a gap (default 30 mm, e.g. a stack or movement joint): symmetric about the point (side both) or towards the start / end. Refused when a connection sits in the gap. Close a gap again with modify_join (collinear, maxGap ≥ the gap).',
      input_schema: {
        type: 'object',
        properties: { member: str, distance: num, at: vec3, gap: num, side: { type: 'string', enum: ['both', 'start', 'end'] } },
        required: ['member'],
      },
    },
    {
      name: 'modify_move_end',
      description: 'Stretch: move one end of a member to `to` (absolute) or `by` (relative). mode detach = only this member\'s end gets its own node; node = the shared node moves and every member on it follows; auto (default).',
      input_schema: { type: 'object', properties: { member: str, end: endE, to: vec3, by: vec3, mode: endMode }, required: ['member', 'end'] },
    },
    {
      name: 'modify_transform',
      description:
        'Rotate, mirror or offset members (copy: true keeps the originals). rotate: about an axis through axisPoint along axisDir (or the axis of axisMember) by angle degrees. mirror: about plane (sections are mirrored too: asymmetric profiles get mirrorSection). offset: by distance along each member\'s local y or z, its surface normal, or a vector [x, y, z] (copies unless copy = false).',
      input_schema: {
        type: 'object',
        properties: {
          filter,
          op: { type: 'string', enum: ['rotate', 'mirror', 'offset'] },
          copy: { type: 'boolean' },
          angle: num,
          axisPoint: vec3,
          axisDir: vec3,
          axisMember: str,
          plane,
          distance: num,
          direction: { description: '"y", "z", "normal" or [x, y, z]' },
        },
        required: ['op'],
      },
    },
    {
      name: 'modify_section',
      description:
        'Section operations on members: rotate (degrees added to the rotation, e.g. 90 / -90), flip (180°), mirror (true / false: mirror the outline about the wire line\'s local z — channels, angles, Z, custom outlines open the other way; omit to leave), profile (change, wire position kept), step next / previous size in the same family ordered by mass (stepMode mass, wall = same outer size, size = same wall), alignY / alignZ (-1, 0, 1) or alignMode insertion.',
      input_schema: {
        type: 'object',
        properties: {
          filter,
          rotate: num,
          flip: { type: 'boolean' },
          mirror: { type: 'boolean' },
          profile: str,
          step: { type: 'string', enum: ['next', 'previous'] },
          stepMode: { type: 'string', enum: ['mass', 'wall', 'size'] },
          alignY: { type: 'integer', enum: [-1, 0, 1] },
          alignZ: { type: 'integer', enum: [-1, 0, 1] },
          alignMode: { type: 'string', enum: ['grid', 'insertion'] },
        },
      },
    },
    {
      name: 'modify_match',
      description: 'Match properties ("format painter"): copy the chosen fields of member `source` to the members matching the filter. Fields default to all; end preparations copy saw cuts and copes (mitres / fits are skipped).',
      input_schema: {
        type: 'object',
        properties: { source: str, filter, fields: { type: 'array', items: { type: 'string', enum: [...MATCH_FIELDS] } } },
        required: ['source'],
      },
    },
    {
      name: 'modify_reverse',
      description: 'Reverse members (swap start and end) keeping the section, end preparations, extensions and connection parts physically where they are.',
      input_schema: { type: 'object', properties: { filter } },
    },
    {
      name: 'connection_flip_side',
      description:
        'Flip connections to the other side of their supported member, the member unchanged: axis y = the other face across the member (fin plate / cleat side, bracket fin side, bolt head side …), z = the other side in depth (bracket concrete side …). The parts become the mirror image through the member\'s local xz (y) or xy (z) plane. Refused when nothing changes (symmetric). Connections by ids, else the selected ones.',
      input_schema: {
        type: 'object',
        properties: { connections: { type: 'array', items: str }, axis: { type: 'string', enum: ['y', 'z'] } },
      },
    },
    {
      name: 'modify_measure',
      description: 'Measure members: length, angle to horizontal / vertical and plan bearing of each; with two members also the 3D angle between their axes, the included angle at a shared node and their gap. Changes nothing.',
      input_schema: { type: 'object', properties: { members: { type: 'array', items: str, minItems: 1 } }, required: ['members'] },
    },
  ],
  run: {
    modify_join: (input) => {
      const ids = ((input.members as Id[]) ?? []).filter((id) => st().project.members[id]);
      if (ids.length < 2) throw new Error('Pass two or more existing member ids.');
      const p = st().project;
      const mode = (input.mode as string) ?? 'auto';
      const isCollinear = ids.every((id) => collinear(p, p.members[ids[0]], p.members[id], (input.tol as number) ?? 2));
      if (mode === 'collinear' || (mode === 'auto' && isCollinear))
        return run('Join', (d) => joinMembers(d, ids, { maxGap: input.maxGap as number | undefined, keep: input.keep as 'first' | undefined }));
      if (ids.length !== 2) throw new Error('Corner and tee joins take two members.');
      if (mode === 'tee') return run('Join to member', (d) => joinToMember(d, ids[0], ids[1], { splitB: !!input.splitB, tol: input.tol as number | undefined }));
      return run('Corner join', (d) => cornerJoin(d, ids[0], ids[1], { tol: input.tol as number | undefined }));
    },
    modify_split: (input) => {
      const p = st().project;
      const ids = members(p, input.filter as Filter);
      if (input.crossings) return run('Split at crossings', (d) => splitAtCrossingMembers(d, ids, { mullionTransomOnly: !!input.mullionTransomOnly }));
      if (input.plane) {
        const pl = planeOf(p, input.plane);
        return run('Split at plane', (d) => splitAtPlane(d, ids, pl));
      }
      const each = (label: string, op: (d: Project, id: Id) => ModifyResult) =>
        run(label, (d) => {
          const out: ModifyResult = { members: [], removed: [], message: '', warnings: [] };
          for (const id of ids) {
            const r = op(d, id);
            out.members.push(...r.members);
            out.warnings.push(...r.warnings);
            out.connections = mergeSummaries(out.connections, r.connections);
            out.message = ids.length === 1 ? r.message : `${label}: ${ids.length} members into ${out.members.length} pieces.`;
          }
          return out;
        });
      if (input.point) {
        const q = v(input.point, 'point');
        return each('Split', (d, id) => splitAtPoint(d, id, q));
      }
      if (typeof input.distance === 'number') return each('Split', (d, id) => splitAtDistance(d, id, input.distance as number, (input.from as 'start' | 'end') ?? 'start'));
      if (typeof input.parts === 'number') return each('Split', (d, id) => splitInto(d, id, input.parts as number));
      if (typeof input.length === 'number') return each('Split at lengths', (d, id) => splitAtLengths(d, id, input.length as number, (input.from as 'start' | 'end') ?? 'start'));
      throw new Error('Give one of point, distance, parts, length, plane or crossings.');
    },
    modify_extend: (input) => {
      const p = st().project;
      const ids = members(p, input.filter as Filter);
      const mode = (input.mode as 'auto' | 'detach' | 'node') ?? 'auto';
      const end = input.end as 'start' | 'end' | 'both' | 'auto' | undefined;
      const each = (label: string, op: (d: Project, id: Id) => ModifyResult) =>
        run(label, (d) => {
          const rs = ids.map((id) => op(d, id));
          return {
            members: ids,
            removed: [],
            message: rs.length === 1 ? rs[0].message : `${label}: ${rs.length} members.`,
            warnings: rs.flatMap((r) => r.warnings),
            connections: mergeSummaries(...rs.map((r) => r.connections)),
          };
        });
      if (typeof input.length === 'number') return each('Set length', (d, id) => setLength(d, id, input.length as number, (input.anchor as 'start' | 'end' | 'centre') ?? 'start', mode));
      if (typeof input.toMember === 'string') {
        const to = one(input, 'toMember');
        return each('Extend to member', (d, id) =>
          extendToMember(d, id, to, { to: (input.to as 'axis' | 'face') ?? 'axis', gap: input.gap as number | undefined, end: end === 'both' ? 'auto' : end, mode }),
        );
      }
      if (input.plane) {
        const pl = planeOf(p, input.plane);
        return each('Extend to plane', (d, id) => extendToPlane(d, id, pl, { end: end === 'both' ? 'auto' : end, mode }));
      }
      if (typeof input.distance === 'number') return each('Extend', (d, id) => extendBy(d, id, input.distance as number, end === 'auto' || !end ? 'end' : end, mode));
      throw new Error('Give one of distance, length, toMember or plane.');
    },
    modify_trim: (input) => {
      const id = one(input);
      if (typeof input.boundary === 'string') {
        const b = one(input, 'boundary');
        const k = input.keep;
        const keep = k === 'start' || k === 'end' ? k : Array.isArray(k) ? v(k, 'keep') : 'start';
        return run('Trim', (d) => trimAtBoundary(d, id, b, keep, { tol: input.tol as number | undefined }));
      }
      if (!input.at) throw new Error('Give a boundary member, or `at` (a point on the segment to delete).');
      const at = v(input.at, 'at');
      return run('Delete segment', (d) => deleteSegment(d, id, at, { tol: input.tol as number | undefined }));
    },
    modify_break: (input) => {
      const id = one(input);
      const at = input.at ? v(input.at, 'at') : typeof input.distance === 'number' ? (input.distance as number) : wireOf(st().project, st().project.members[id]).L / 2;
      return run('Break', (d) => breakMember(d, id, at, (input.gap as number) ?? 30, (input.side as 'both' | 'start' | 'end') ?? 'both'));
    },
    modify_move_end: (input) => {
      const id = one(input);
      const end = input.end as 'start' | 'end';
      const m = st().project.members[id];
      const cur = st().project.nodes[end === 'start' ? m.start : m.end].p;
      const to = input.to ? v(input.to, 'to') : input.by ? (([b]) => ({ x: cur.x + b.x, y: cur.y + b.y, z: cur.z + b.z }))([v(input.by, 'by')]) : null;
      if (!to) throw new Error('Give `to` or `by`.');
      return run('Move end', (d) => moveMemberEnd(d, id, end, to, (input.mode as 'auto' | 'detach' | 'node') ?? 'auto'));
    },
    modify_transform: (input) => {
      const p = st().project;
      const ids = members(p, input.filter as Filter);
      const copy = input.copy as boolean | undefined;
      if (input.op === 'rotate') {
        if (typeof input.angle !== 'number') throw new Error('rotate needs angle (degrees).');
        let point: Vec3;
        let dir: Vec3;
        if (typeof input.axisMember === 'string') {
          const w = wireOf(p, p.members[one(input, 'axisMember')]);
          point = w.a;
          dir = w.d;
        } else {
          point = input.axisPoint ? v(input.axisPoint, 'axisPoint') : { x: 0, y: 0, z: 0 };
          dir = input.axisDir ? v(input.axisDir, 'axisDir') : { x: 0, y: 0, z: 1 };
        }
        return run('Rotate', (d) => rotateMembers(d, ids, point, dir, input.angle as number, { copy }));
      }
      if (input.op === 'mirror') {
        const pl = planeOf(p, input.plane ?? { kind: 'workPlane' });
        return run('Mirror', (d) => mirrorMembers(d, ids, pl, { copy: copy ?? true }));
      }
      if (input.op === 'offset') {
        if (typeof input.distance !== 'number') throw new Error('offset needs distance (mm).');
        const dirIn = input.direction ?? 'z';
        const dir = Array.isArray(dirIn) ? v(dirIn, 'direction') : (dirIn as 'y' | 'z' | 'normal');
        return run('Offset', (d) => offsetMembers(d, ids, input.distance as number, dir, { copy }));
      }
      throw new Error('op must be rotate, mirror or offset.');
    },
    modify_section: (input) => {
      const p = st().project;
      const ids = members(p, input.filter as Filter);
      return run('Section', (d) => {
        const msgs: string[] = [];
        const warnings: string[] = [];
        const take = (r: ModifyResult) => (msgs.push(r.message), warnings.push(...r.warnings));
        if (typeof input.profile === 'string') take(changeProfile(d, ids, input.profile || null));
        if (input.step) take(stepProfiles(d, ids, input.step === 'previous' ? -1 : 1, (input.stepMode as 'mass' | 'wall' | 'size') ?? 'mass'));
        if (typeof input.rotate === 'number') take(rotateSections(d, ids, input.rotate));
        if (input.flip) take(rotateSections(d, ids, 180));
        if (typeof input.mirror === 'boolean') take(mirrorSections(d, ids, input.mirror));
        if (input.alignY !== undefined || input.alignZ !== undefined || input.alignMode)
          take(setAlignment(d, ids, { alignY: input.alignY as -1 | 0 | 1 | undefined, alignZ: input.alignZ as -1 | 0 | 1 | undefined, mode: input.alignMode as 'grid' | 'insertion' | undefined }));
        if (!msgs.length) throw new Error('Give rotate, flip, mirror, profile, step or an alignment.');
        return { members: ids, removed: [], message: msgs.join(' '), warnings };
      });
    },
    modify_match: (input) => {
      const src = one(input, 'source');
      const ids = members(st().project, input.filter as Filter).filter((id) => id !== src);
      const fields = (input.fields as MatchField[] | undefined) ?? [...MATCH_FIELDS];
      return run('Match properties', (d) => matchProperties(d, src, ids, fields));
    },
    modify_reverse: (input) => {
      const ids = members(st().project, input.filter as Filter);
      return run('Reverse', (d) => reverseMembers(d, ids));
    },
    connection_flip_side: (input) => {
      const p = st().project;
      const given = (input.connections as Id[] | undefined) ?? st().selection.connections;
      const ids = given.filter((id) => p.connections[id]);
      if (!ids.length) throw new Error('No connections: pass connection ids or ask the user to select connections.');
      const axis = (input.axis as 'y' | 'z' | undefined) ?? 'y';
      let r: ModifyResult | null = null;
      st().apply(`Flip connection side (${axis})`, (d) => {
        r = flipConnectionSide(d, ids, axis);
      });
      const res = r as unknown as ModifyResult;
      st().select({ members: [], nodes: [], connections: ids });
      return { message: res.message, warnings: res.warnings, flipped: res.connections?.transformed ?? [] };
    },
    modify_measure: (input) => {
      const p = st().project;
      const ids = ((input.members as Id[]) ?? []).filter((id) => p.members[id]);
      if (!ids.length) throw new Error('Pass member ids.');
      const r1 = (x: number) => Math.round(x * 10) / 10;
      const each = ids.map((id) => {
        const m = measureMember(p, id);
        return { id, length: r1(m.length), toHorizontal: r1(m.toHorizontal), toVertical: r1(m.toVertical), bearing: m.bearing === undefined ? null : r1(m.bearing) };
      });
      const pair = ids.length >= 2 ? angleBetween(p, ids[0], ids[1]) : null;
      return { members: each, ...(pair ? { angle: r1(pair.angle), included: pair.included === undefined ? null : r1(pair.included), gap: r1(pair.gap) } : {}) };
    },
  },
};
