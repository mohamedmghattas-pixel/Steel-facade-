/**
 * Assistant tools for geometry modelling: end preparations (mitre, fit, saw
 * angles, copes), stiffeners, polygon and bent plates, 3-point work planes,
 * arc members and curved facade grids.
 */
import type { ToolModule, Json } from './types';
import { useStore, derived } from '../../state/store';
import type { EndPrep, Id, MemberRole, Vec3 } from '../../core/model/types';
import { MEMBER_ROLES } from '../../core/model/types';
import {
  addArcMembers,
  addBentPlate,
  addPolygonPlate,
  addStiffeners,
  addWorkPlane,
  curvedFacadeGrid,
  fitEnd,
  mitreMembers,
  planeArc,
  setEndPrep,
  autoCutSettings,
} from '../../core/model/ops';
import { endFitCounts } from '../../core/derive/autoCut';
import { customWorkPlane, dist } from '../../core/model/geometry';
import { arcFrom3Points, arcPoints } from '../../core/geometry/arc';
import { flatLength } from '../../core/geometry/bentPlate';
import { getProfile } from '../../core/library/profiles';

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const vec3 = { type: 'array', items: num, minItems: 3, maxItems: 3, description: '[x, y, z] mm' } as const;
const memberIds = { type: 'array', items: str, description: 'Member ids; omit for the current selection' } as const;
const nums = { type: 'array', items: num } as const;

const st = () => useStore.getState();
const v = (a: unknown, what: string): Vec3 => {
  if (!Array.isArray(a) || a.length !== 3 || a.some((x) => typeof x !== 'number')) throw new Error(`${what} must be [x, y, z].`);
  return { x: a[0], y: a[1], z: a[2] };
};
const pickMembers = (input: Json): Id[] => {
  const ids = (input.members as Id[] | undefined) ?? st().selection.members;
  const p = st().project;
  const ok = ids.filter((id) => p.members[id]);
  if (!ok.length) throw new Error('No members: pass member ids or ask the user to select members.');
  return ok;
};
const ends = (e: unknown): ('start' | 'end')[] => (e === 'start' ? ['start'] : e === 'end' ? ['end'] : ['start', 'end']);

/** Cut lengths and saw angles of members after an edit, for the reply. */
function prepSummary(ids: Id[]) {
  const dm = derived(st().project);
  return ids.map((id) => {
    const pt = dm.partByRef.get(`m:${id}`);
    const e = pt?.ends;
    const a = (c?: { angleWeb: number; angleFlange: number; copes: unknown[] }) => (c ? { web: c.angleWeb, flange: c.angleFlange, copes: c.copes.length } : { web: 0, flange: 0, copes: 0 });
    return { id, mark: pt?.assembly, cutLength: pt ? Math.round(pt.length * 10) / 10 : null, start: a(e?.start), end: a(e?.end) };
  });
}
const prepWarnings = (ids: Id[]) =>
  derived(st().project)
    .warnings.filter((w) => w.memberId && ids.includes(w.memberId) && w.text.startsWith('End preparation'))
    .map((w) => w.text);

export const modellingModule: ToolModule = {
  tools: [
    {
      name: 'set_end_prep',
      description:
        'Set member end preparations: square, bevel (DSTV saw angles from square: angleWeb seen in the side/web view, + shortens the top edge; angleFlange seen from above, + shortens the +y edge) or cope (notch a flange: depth from the outer face, length from the end, corner radius, side). Use mitre_members / fit_member_end for mitres and fits. Returns cut lengths and saw angles.',
      input_schema: {
        type: 'object',
        properties: {
          members: memberIds,
          end: { type: 'string', enum: ['start', 'end', 'both'] },
          kind: { type: 'string', enum: ['square', 'bevel', 'cope'] },
          angleWeb: num,
          angleFlange: num,
          copeDepth: num,
          copeLength: num,
          copeRadius: { type: 'number', description: 'Default 15 mm' },
          copeSide: { type: 'string', enum: ['top', 'bottom', 'both'] },
        },
        required: ['end', 'kind'],
      },
    },
    {
      name: 'mitre_members',
      description: 'Mitre two members at their shared end node: both ends are cut on the plane bisecting their axes (saw angle 90° − included/2). Optional total gap between the cut faces (mm).',
      input_schema: { type: 'object', properties: { a: str, b: str, gap: num }, required: ['a', 'b'] },
    },
    {
      name: 'fit_member_end',
      description:
        'Cut a member end to the facing side of another member (web face of I/U sections, else the section envelope), leaving a gap (mm, default 10), in any direction: a transom to a mullion, a mullion to a sill / head / beam, on sloped, raking or folded geometry (saw angles follow). end: start, end or auto (the end nearer the other member). cope: also cope flanges that would clash with an I/U member\'s flanges.',
      input_schema: {
        type: 'object',
        properties: { member: str, to: str, end: { type: 'string', enum: ['start', 'end', 'auto'] }, gap: num, cope: { type: 'boolean' } },
        required: ['member', 'to'],
      },
    },
    {
      name: 'set_end_fitting',
      description:
        "Project end fitting. autoCut: member ends meeting another member's side with no connection there and no end preparation or extension (transoms / rails / braces on mullions or posts, a mullion end on a member passing through) are cut to that member's face less gap (mm, default 10); new projects on, older ones off. connections: connection cut-backs follow the main member's face on skewed, raking, sloped or folded joints (square joints unchanged). A Fit / Mitre / Bevel on an end wins. Omit a value to keep it. Returns the settings and how many ends each cuts.",
      input_schema: { type: 'object', properties: { autoCut: { type: 'boolean' }, gap: num, connections: { type: 'boolean' } } },
    },
    {
      name: 'add_stiffeners',
      description:
        'Add full-depth web stiffener plates to I/H (both sides) or channel (open side) members, welded to them: clear depth between flanges, outstand to the flange tip less inset, corner snips ≥ root radius. Positions: distances from the start node, or `spaces` equal spaces (interior points).',
      input_schema: {
        type: 'object',
        properties: {
          members: memberIds,
          distances: nums,
          spaces: { type: 'integer' },
          t: { type: 'number', description: 'Thickness, default 10 mm' },
          sides: { type: 'string', enum: ['both', 'pos', 'neg'] },
          inset: num,
          snip: num,
        },
      },
    },
    {
      name: 'add_plate',
      description:
        'Add a flat polygon plate from 3+ world corner points in one plane (mm). Holes are on the flat plate in its own x/y (x along the first edge from the first point). Optionally shop-weld it to a member (joins that assembly); loose plates form their own assembly.',
      input_schema: {
        type: 'object',
        properties: {
          points: { type: 'array', items: vec3, minItems: 3 },
          t: num,
          material: str,
          name: str,
          weldedTo: str,
          holes: { type: 'array', items: { type: 'object', properties: { x: num, y: num, d: num, slot: num, angle: num }, required: ['x', 'y', 'd'] } },
        },
        required: ['points', 't'],
      },
    },
    {
      name: 'add_bent_plate',
      description:
        'Add a bent strip (angle, channel or Z bracket) from outside leg dimensions. The first leg starts at origin along xAxis, the width runs along yAxis, positive bend angles fold towards xAxis × yAxis. Flat pattern from the bend allowance θ·(r + K·t), K default 0.33. Returns the flat length.',
      input_schema: {
        type: 'object',
        properties: {
          origin: vec3,
          xAxis: vec3,
          yAxis: vec3,
          legs: { type: 'array', items: num, minItems: 2 },
          angles: { type: 'array', items: num, minItems: 1 },
          radius: { type: 'number', description: 'Inner bend radius, mm' },
          t: num,
          width: num,
          k: num,
          weldedTo: str,
        },
        required: ['origin', 'legs', 'angles', 't', 'width'],
      },
    },
    {
      name: 'define_work_plane',
      description: 'Define a named work plane from three points: origin, a point on its x axis and a third point in the plane (+y side). Activates it for drawing unless activate is false.',
      input_schema: { type: 'object', properties: { name: str, origin: vec3, xPoint: vec3, planePoint: vec3, activate: { type: 'boolean' } }, required: ['origin', 'xPoint', 'planePoint'] },
    },
    {
      name: 'create_arc_members',
      description:
        'Create straight members along a circular arc: either start/end/through points (3D), or centre [u, v] + radius + start/end angles (deg from u towards v) on the plane XY, XZ, YZ or the current work plane. Segments: count, or enough for maxDeviation (chord sagitta, default 5 mm).',
      input_schema: {
        type: 'object',
        properties: {
          start: vec3,
          end: vec3,
          through: vec3,
          centre: { type: 'array', items: num, minItems: 2, maxItems: 2 },
          radius: num,
          startAngle: num,
          endAngle: num,
          plane: { type: 'string', enum: ['XY', 'XZ', 'YZ', 'current'] },
          planeOffset: num,
          segments: { type: 'integer' },
          maxDeviation: num,
          profile: str,
          role: { type: 'string', enum: MEMBER_ROLES },
        },
      },
    },
    {
      name: 'create_curved_facade_grid',
      description:
        'Generate a facade on a plan arc: vertical mullions at bay points (bay widths measured along the arc, or bayCount equal bays between the angles), split at floor lines, depth along the local facade normal; transoms as straight chords within maxDeviation. Angles in degrees counter-clockwise from +X.',
      input_schema: {
        type: 'object',
        properties: {
          centre: { type: 'array', items: num, minItems: 2, maxItems: 2, description: '[x, y] mm' },
          radius: num,
          startAngle: num,
          endAngle: num,
          bays: nums,
          bayCount: { type: 'integer' },
          z0: num,
          rows: { type: 'array', items: num, description: 'Heights between horizontal lines, bottom → top' },
          floorLines: { type: 'array', items: { type: 'integer' } },
          mullionProfile: str,
          transomProfile: str,
          transomDepthNormal: { type: 'boolean' },
          floorTransoms: { type: 'boolean' },
          maxDeviation: num,
        },
        required: ['centre', 'radius', 'startAngle', 'endAngle', 'rows', 'floorLines'],
      },
    },
    {
      name: 'get_modelling_info',
      description: 'End preparations (kind, saw angles, cut length, face fits by connections or the auto-cut) of the given or selected members, the project end fitting, plus every free / bent plate and stiffener and the named work planes.',
      input_schema: { type: 'object', properties: { members: memberIds } },
    },
  ],
  run: {
    set_end_prep: (input) => {
      const ids = pickMembers(input);
      const kind = String(input.kind) as 'square' | 'bevel' | 'cope';
      st().apply(`End preparation (${kind})`, (p) => {
        for (const id of ids) {
          for (const e of ends(input.end)) {
            let prep: EndPrep | undefined;
            if (kind === 'bevel') {
              const aw = Number(input.angleWeb ?? 0);
              const af = Number(input.angleFlange ?? 0);
              if (Math.abs(aw) >= 85 || Math.abs(af) >= 85) throw new Error('Saw angles must be within ±85°.');
              prep = { kind: 'bevel', angleWeb: aw, angleFlange: af };
            } else if (kind === 'cope') {
              if (!(Number(input.copeDepth) > 0 && Number(input.copeLength) > 0)) throw new Error('A cope needs copeDepth and copeLength > 0.');
              prep = {
                kind: 'cope',
                copeDepth: Number(input.copeDepth),
                copeLength: Number(input.copeLength),
                copeSide: (input.copeSide as EndPrep['copeSide']) ?? 'top',
                copeRadius: input.copeRadius === undefined ? undefined : Number(input.copeRadius),
              };
            }
            setEndPrep(p, id, e, prep);
          }
        }
      });
      return { updated: ids.length, members: prepSummary(ids), warnings: prepWarnings(ids) };
    },
    mitre_members: (input) => {
      let r = { node: '', angle: 0, included: 0 };
      st().apply('Mitre', (p) => {
        r = mitreMembers(p, String(input.a), String(input.b), Number(input.gap ?? 0));
      });
      const ids = [String(input.a), String(input.b)];
      return { sawAngle: Math.round(r.angle * 100) / 100, includedAngle: Math.round(r.included * 100) / 100, members: prepSummary(ids), warnings: prepWarnings(ids) };
    },
    fit_member_end: (input) => {
      let r: ReturnType<typeof fitEnd> = { end: 'start' };
      st().apply('Fit to member', (p) => {
        r = fitEnd(p, String(input.member), (input.end as 'start' | 'end' | 'auto') ?? 'auto', String(input.to), Number(input.gap ?? 10), Boolean(input.cope));
      });
      return { end: r.end, cope: r.cope ?? null, members: prepSummary([String(input.member)]), warnings: prepWarnings([String(input.member)]) };
    },
    set_end_fitting: (input) => {
      st().apply('End fitting', (p) => {
        const a = autoCutSettings(p);
        if (typeof input.autoCut === 'boolean') a.enabled = input.autoCut;
        if (input.gap !== undefined) {
          const g = Number(input.gap);
          if (!Number.isFinite(g) || g < 0) throw new Error('gap must be a number ≥ 0 (mm).');
          a.gap = g;
        }
        if (typeof input.connections === 'boolean') a.connections = input.connections;
        p.settings.autoCut = a;
      });
      const p = st().project;
      const n = endFitCounts(derived(p));
      return { ...autoCutSettings(p), autoCutEnds: n.auto, autoCutAtAngle: n.autoAngled, connectionEndsAtAngle: n.connection };
    },
    add_stiffeners: (input) => {
      const ids = pickMembers(input);
      const created: Id[] = [];
      st().apply('Add stiffeners', (p) => {
        for (const id of ids) {
          const m = p.members[id];
          const L = dist(p.nodes[m.start].p, p.nodes[m.end].p);
          let ds = (input.distances as number[] | undefined) ?? [];
          if (!ds.length) {
            const n = Math.max(1, Number(input.spaces ?? 2));
            ds = Array.from({ length: n - 1 }, (_, i) => (L * (i + 1)) / n);
          }
          created.push(
            ...addStiffeners(p, id, ds, {
              t: Number(input.t ?? 10),
              sides: (input.sides as 'both' | 'pos' | 'neg') ?? 'both',
              inset: input.inset === undefined ? undefined : Number(input.inset),
              snip: input.snip === undefined ? undefined : Number(input.snip),
            }),
          );
        }
      });
      st().select({ plates: created });
      return { created: created.length, plates: created };
    },
    add_plate: (input) => {
      const pts = (input.points as unknown[]).map((q, i) => v(q, `points[${i}]`));
      let id = '';
      st().apply('Add plate', (p) => {
        id = addPolygonPlate(p, pts, { t: Number(input.t), material: input.material as string | undefined, name: input.name as string | undefined, weldedTo: input.weldedTo as string | undefined });
        if (Array.isArray(input.holes)) p.plates[id].holes = (input.holes as { x: number; y: number; d: number; slot?: number; angle?: number }[]).map((h) => ({ ...h }));
      });
      st().select({ plates: [id] });
      const pt = derived(st().project).partByRef.get(`p:${id}`);
      return { id, mark: pt?.mark, assembly: pt?.assembly, mass: pt ? Math.round(pt.mass * 100) / 100 : null };
    },
    add_bent_plate: (input) => {
      const legs = input.legs as number[];
      const angles = input.angles as number[];
      if (angles.length !== legs.length - 1) throw new Error('Give one bend angle fewer than legs.');
      const radius = Number(input.radius ?? input.t);
      const bends = angles.map((a) => ({ angle: a, radius }));
      let id = '';
      st().apply('Add bent plate', (p) => {
        id = addBentPlate(p, {
          origin: v(input.origin, 'origin'),
          xAxis: input.xAxis ? v(input.xAxis, 'xAxis') : { x: 1, y: 0, z: 0 },
          yAxis: input.yAxis ? v(input.yAxis, 'yAxis') : { x: 0, y: 1, z: 0 },
          width: Number(input.width),
          legs,
          bends,
          t: Number(input.t),
          k: input.k === undefined ? undefined : Number(input.k),
          weldedTo: input.weldedTo as string | undefined,
        });
      });
      st().select({ plates: [id] });
      const pt = derived(st().project).partByRef.get(`p:${id}`);
      return { id, mark: pt?.mark, flatLength: Math.round(flatLength(legs, bends, Number(input.t), input.k === undefined ? undefined : Number(input.k)) * 10) / 10, mass: pt ? Math.round(pt.mass * 100) / 100 : null };
    },
    define_work_plane: (input) => {
      let id = '';
      st().apply('Add work plane', (p) => {
        id = addWorkPlane(p, String(input.name ?? ''), v(input.origin, 'origin'), v(input.xPoint, 'xPoint'), v(input.planePoint, 'planePoint'));
      });
      const np = st().project.workPlanes.find((w) => w.id === id)!;
      if (input.activate !== false) st().set({ workPlane: customWorkPlane(np) });
      return { id, name: np.name, xAxis: np.xAxis, yAxis: np.yAxis, active: input.activate !== false };
    },
    create_arc_members: (input) => {
      let pts: Vec3[];
      const opts = input.segments ? { segments: Number(input.segments) } : { maxDeviation: Number(input.maxDeviation ?? 5) };
      let radius = 0;
      if (input.start && input.end && input.through) {
        const arc = arcFrom3Points(v(input.start, 'start'), v(input.end, 'end'), v(input.through, 'through'));
        if (!arc) throw new Error('The three points are collinear.');
        radius = arc.radius;
        pts = arcPoints(arc, opts);
      } else {
        const c = input.centre as number[] | undefined;
        if (!c || !(Number(input.radius) > 0)) throw new Error('Give start/end/through, or centre + radius + startAngle + endAngle.');
        const wp = !input.plane || input.plane === 'current' ? st().workPlane : { kind: input.plane as 'XY' | 'XZ' | 'YZ', offset: Number(input.planeOffset ?? 0) };
        radius = Number(input.radius);
        pts = arcPoints(planeArc(wp, c[0], c[1], radius, Number(input.startAngle ?? 0), Number(input.endAngle ?? 90)), opts);
      }
      const profile = (input.profile as string | undefined) ?? null;
      if (profile && !getProfile(profile)) throw new Error(`Unknown profile ${profile}.`);
      let ids: Id[] = [];
      st().apply('Arc members', (p) => {
        ids = addArcMembers(p, pts, { profile, role: (input.role as MemberRole) ?? (profile ? 'rail' : 'other') });
      });
      st().select({ members: ids });
      return { created: ids.length, radius: Math.round(radius * 10) / 10, segments: pts.length - 1 };
    },
    create_curved_facade_grid: (input) => {
      const c = input.centre as number[];
      let ids: Id[] = [];
      st().apply('Curved facade grid', (p) => {
        ids = curvedFacadeGrid(p, {
          centre: { x: c[0], y: c[1] },
          radius: Number(input.radius),
          startAngle: Number(input.startAngle),
          endAngle: Number(input.endAngle),
          bays: (input.bays as number[] | undefined) ?? [],
          bayCount: input.bayCount === undefined ? undefined : Number(input.bayCount),
          z0: Number(input.z0 ?? 0),
          rows: input.rows as number[],
          floorLines: input.floorLines as number[],
          mullionProfile: (input.mullionProfile as string | undefined) ?? null,
          transomProfile: (input.transomProfile as string | undefined) ?? null,
          transomDepthNormal: input.transomDepthNormal !== false,
          addLevels: true,
          floorTransoms: Boolean(input.floorTransoms),
          maxDeviation: input.maxDeviation === undefined ? undefined : Number(input.maxDeviation),
        });
      });
      st().select({ members: ids });
      const p = st().project;
      return {
        created: ids.length,
        mullions: ids.filter((id) => p.members[id]?.role === 'mullion').length,
        transoms: ids.filter((id) => p.members[id]?.role === 'transom').length,
      };
    },
    get_modelling_info: (input) => {
      const p = st().project;
      const dm = derived(p);
      const ids = (input.members as Id[] | undefined) ?? st().selection.members;
      return {
        members: ids
          .filter((id) => p.members[id])
          .map((id) => {
            const f = dm.geoms.get(id)?.fits;
            const fit = (e?: { to: Id; by: string; auto?: true; plane?: unknown }) => (e ? { to: e.to, by: e.by, angled: !!e.plane } : null);
            return { ...prepSummary([id])[0], startPrep: p.members[id].startPrep ?? { kind: 'square' }, endPrep: p.members[id].endPrep ?? { kind: 'square' }, faceFit: { start: fit(f?.start), end: fit(f?.end) } };
          }),
        endFitting: { ...autoCutSettings(p), ...endFitCounts(dm) },
        plates: Object.values(p.plates ?? {}).map((pl) => {
          const pt = dm.partByRef.get(`p:${pl.id}`);
          return { id: pl.id, name: pl.name, kind: pl.kind, t: pl.t, mark: pt?.mark, assembly: pt?.assembly, weldedTo: pl.weldedTo ?? null, mass: pt ? Math.round(pt.mass * 100) / 100 : null, bends: pl.bends.length, holes: pl.holes.length };
        }),
        workPlanes: (p.workPlanes ?? []).map((w) => ({ id: w.id, name: w.name })),
      };
    },
  },
};

