/**
 * Assistant tools for custom profiles: create an outline or thin-wall profile
 * with an insertion point, import profiles from DXF text, list the project's
 * custom profiles and set / apply profiles by member role (mullions vs
 * transoms). Every edit goes through store.apply (undoable).
 */
import type { ToolModule, Json } from './types';
import { useStore } from '../../state/store';
import type { AlignMode, Id, MemberRole, Vec2 } from '../../core/model/types';
import { MEMBER_ROLES } from '../../core/model/types';
import { getProfile, profileFromDef, profileMassIn, type ProfileDef } from '../../core/library/profiles';
import { findMaterial } from '../../core/library/materials';
import { INSERTION_PRESETS, insertionPreset, loopId, sketchToDef, type InsertionPreset, type Sketch, type SketchVertex } from '../../core/library/sketch';
import { parseProfileDxf } from '../../core/library/profileDxf';
import { assignProfilesByRole, roleCounts, setRoleProfile } from '../../core/model/roleProfiles';

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const pt = { type: 'array', items: num, minItems: 2, maxItems: 3, description: '[x, y] mm, optional 3rd value = bulge (tan of a quarter of the arc angle, + counter-clockwise) of the segment to the next point' } as const;
const loop = { type: 'array', items: pt, minItems: 2 } as const;
const PRESETS = INSERTION_PRESETS.map((p) => p.id);

const st = () => useStore.getState();
const r2 = (v: number) => Math.round(v * 100) / 100;

function vertices(a: unknown, what: string): SketchVertex[] {
  if (!Array.isArray(a) || a.length < 2) throw new Error(`${what} needs at least 2 points [x, y].`);
  return a.map((q, i) => {
    if (!Array.isArray(q) || q.length < 2 || q.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${what} point ${i + 1} must be [x, y] or [x, y, bulge].`);
    return q[2] ? { x: q[0], y: q[1], b: q[2] } : { x: q[0], y: q[1] };
  });
}

/** Library entry summary for replies. */
function summary(name: string) {
  const p = getProfile(name);
  if (!p) return { name, missing: true };
  return {
    name: p.name,
    family: p.family,
    type: p.shape.type,
    material: p.material ?? null,
    h: r2(p.h),
    b: r2(p.b),
    areaCm2: r2(p.area / 100),
    kgPerM: r2(profileMassIn(p)),
    IyCm4: r2(p.Iy / 1e4),
    IzCm4: r2(p.Iz / 1e4),
    WyCm3: r2(p.Wy / 1e3),
    WzCm3: r2(p.Wz / 1e3),
    surfaceM2PerM: Math.round(p.surface * 1000) / 1000,
    insertionFromBoxCentre: p.insertion ? { y: r2(p.insertion.x), z: r2(p.insertion.y) } : null,
  };
}

/** Add or replace definitions in the project library (one undo step). */
function addDefs(defs: ProfileDef[], label: string, replace: boolean) {
  const lib = st().project.library.profiles as unknown as ProfileDef[];
  const clash = defs.filter((d) => lib.some((x) => x.name === d.name) || (getProfile(d.name) && !getProfile(d.name)!.custom));
  if (clash.length && !replace) throw new Error(`Profile name${clash.length === 1 ? '' : 's'} already in use: ${clash.map((d) => d.name).join(', ')}. Pass replace: true or choose another name.`);
  st().apply(label, (p) => {
    const names = new Set(defs.map((d) => d.name));
    p.library.profiles = [...p.library.profiles.filter((d) => !names.has(String(d.name))), ...(defs as unknown as Record<string, unknown>[])];
  });
}

export const profilesModule: ToolModule = {
  tools: [
    {
      name: 'create_custom_profile',
      description:
        'Create (or replace) a project custom profile from an outline or a thin-wall centre line, with an insertion point (the wire-line point members run through). Coordinates mm: x across the section (member local y), y up (local z). mode outline: outer loop + optional holes; points may carry a bulge for arcs; radius rounds every outline corner. mode thin_wall: centreline points, thickness, closed (tube) or open (C, Z, hat …), bendRadius = inner bend radius. insertion: [x, y] or a preset (tl … br = box corners / edge middles, mc box centre, centroid). Returns the section properties.',
      input_schema: {
        type: 'object',
        properties: {
          name: str,
          family: str,
          material: { type: 'string', description: 'e.g. S355, 6063 T6 (mass uses its density)' },
          mode: { type: 'string', enum: ['outline', 'thin_wall'] },
          outer: loop,
          holes: { type: 'array', items: loop },
          radius: { type: 'number', description: 'outline mode: corner radius for every outer corner' },
          centreline: loop,
          closed: { type: 'boolean' },
          thickness: num,
          bendRadius: num,
          insertion: { description: '[x, y] or a preset name', anyOf: [{ type: 'array', items: num, minItems: 2, maxItems: 2 }, { type: 'string', enum: PRESETS }] },
          replace: { type: 'boolean' },
        },
        required: ['name', 'mode'],
      },
    },
    {
      name: 'import_profiles_dxf',
      description:
        'Import custom profiles from DXF text: closed polylines (bulges kept), circles and joined lines/arcs; the largest loops are outlines, loops inside are holes. Names from TEXT/MTEXT inside or near each outline, insertion point from a POINT or a marker on an INSERT/INS/REF layer, else the origin. Units from $INSUNITS unless unitScale (mm per drawing unit) is given. only: import just these names.',
      input_schema: {
        type: 'object',
        properties: { dxf: str, fileName: str, unitScale: num, family: str, material: str, only: { type: 'array', items: str }, replace: { type: 'boolean' } },
        required: ['dxf'],
      },
    },
    {
      name: 'list_custom_profiles',
      description: 'List the project custom profiles with type, size, kg/m in their material, section properties, insertion point and the roles that use them; plus the profiles set by role.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'set_role_profiles',
      description:
        'Set the profile per member role (e.g. mullions one profile, transoms another) with optional rotation (deg), alignMode (grid / insertion) and material; profile "" clears a role. New members of the role get it. apply: all = update every member of those roles, selection = only selected members, none = settings only. Returns member counts per role.',
      input_schema: {
        type: 'object',
        properties: {
          roles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: MEMBER_ROLES },
                profile: { type: 'string', description: 'profile name; "" clears the role' },
                rotation: num,
                alignMode: { type: 'string', enum: ['grid', 'insertion'] },
                material: str,
              },
              required: ['role', 'profile'],
            },
          },
          apply: { type: 'string', enum: ['all', 'selection', 'none'] },
        },
        required: ['roles'],
      },
    },
  ],
  run: {
    create_custom_profile(input: Json) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new Error('name is required.');
      if (input.material !== undefined && !findMaterial(input.material as string)) throw new Error(`Unknown material "${input.material}".`);
      const sketch: Sketch = { version: 1, loops: [], insertion: null };
      if (input.mode === 'thin_wall') {
        const pts = vertices(input.centreline, 'centreline');
        const t = Number(input.thickness);
        if (!(t > 0)) throw new Error('thin_wall needs thickness > 0.');
        const br = Number(input.bendRadius ?? 0);
        sketch.loops.push({ id: loopId(), kind: 'wall', closed: !!input.closed, t, pts: pts.map((p) => ({ x: p.x, y: p.y, ...(br > 0 ? { r: br } : {}) })) });
      } else {
        const r = Number(input.radius ?? 0);
        sketch.loops.push({ id: loopId(), kind: 'poly', role: 'outer', pts: vertices(input.outer, 'outer').map((p) => (r > 0 && !p.b ? { ...p, r } : p)) });
        for (const [i, h] of ((input.holes as unknown[]) ?? []).entries()) sketch.loops.push({ id: loopId(), kind: 'poly', role: 'hole', pts: vertices(h, `hole ${i + 1}`) });
      }
      const ins = input.insertion;
      if (Array.isArray(ins)) sketch.insertion = { x: Number(ins[0]), y: Number(ins[1]) };
      const def = sketchToDef(sketch, { name, family: (input.family as string) || undefined, material: input.material ? findMaterial(input.material as string)!.name : undefined });
      if (typeof ins === 'string') {
        if (!PRESETS.includes(ins as InsertionPreset)) throw new Error(`insertion preset must be one of ${PRESETS.join(', ')}.`);
        if (def.shape.type === 'POLY') {
          const q: Vec2 = insertionPreset(def.shape, ins as InsertionPreset);
          def.insertion = q;
          (def.sketch as Sketch).insertion = q;
        }
      }
      profileFromDef(def);
      addDefs([def], `Assistant: custom profile ${name}`, !!input.replace);
      return { created: summary(name), insertion: def.insertion ?? null };
    },

    import_profiles_dxf(input: Json) {
      const r = parseProfileDxf(String(input.dxf ?? ''), {
        fileName: (input.fileName as string) || 'DXF profile',
        unitScale: input.unitScale as number | undefined,
        family: input.family as string | undefined,
        material: input.material ? findMaterial(input.material as string)?.name : undefined,
      });
      const only = (input.only as string[] | undefined)?.map((s) => s.toLowerCase());
      const ok = r.profiles.filter((f) => !f.error && (!only || only.includes(f.def.name.toLowerCase())));
      const bad = r.profiles.filter((f) => f.error).map((f) => ({ name: f.def.name, error: f.error }));
      if (ok.length) addDefs(ok.map((f) => f.def), 'Assistant: import DXF profiles', !!input.replace);
      return {
        imported: ok.map((f) => ({ ...summary(f.def.name), nameFrom: f.nameFrom, insertionFrom: f.insertionFrom, warnings: f.warnings })),
        rejected: bad,
        notes: r.notes,
        unitScale: r.unitScale,
        unitSource: r.unitSource,
      };
    },

    list_custom_profiles() {
      const p = st().project;
      const defs = p.library.profiles as unknown as ProfileDef[];
      const users: Record<string, MemberRole[]> = {};
      for (const m of Object.values(p.members)) if (m.profile) (users[m.profile] ??= []).includes(m.role) || users[m.profile].push(m.role);
      const counts = roleCounts(p);
      return {
        profiles: defs.map((d) => ({ ...summary(d.name), usedBy: users[d.name] ?? [], hasSketch: !!d.sketch })),
        roleProfiles: p.settings.roleProfiles ?? {},
        roles: Object.fromEntries(MEMBER_ROLES.filter((r) => counts[r].members + counts[r].lines > 0).map((r) => [r, counts[r]])),
      };
    },

    set_role_profiles(input: Json) {
      const roles = (input.roles as { role: MemberRole; profile: string; rotation?: number; alignMode?: AlignMode; material?: string }[]) ?? [];
      if (!roles.length) throw new Error('roles is empty.');
      for (const r of roles) {
        if (!MEMBER_ROLES.includes(r.role)) throw new Error(`Unknown role "${r.role}".`);
        if (r.profile && !getProfile(r.profile)) throw new Error(`Unknown profile "${r.profile}". Use search_profiles or list_custom_profiles.`);
        if (r.material && !findMaterial(r.material)) throw new Error(`Unknown material "${r.material}".`);
      }
      const mode = (input.apply as string) ?? 'all';
      const sel = st().selection.members;
      if (mode === 'selection' && !sel.length) throw new Error('apply: selection, but nothing is selected.');
      let changed = 0;
      st().apply('Assistant: profiles by role', (d) => {
        for (const r of roles) setRoleProfile(d, r.role, r.profile ? { profile: r.profile, rotation: r.rotation, alignMode: r.alignMode, material: r.material } : null);
        const which = roles.filter((r) => r.profile).map((r) => r.role);
        if (mode !== 'none' && which.length) changed = assignProfilesByRole(d, mode === 'selection' ? (sel as Id[]) : undefined, which);
      });
      const p = st().project;
      const counts = roleCounts(p);
      return { roleProfiles: p.settings.roleProfiles, changed, counts: Object.fromEntries(roles.map((r) => [r.role, counts[r.role]])) };
    },
  },
};
