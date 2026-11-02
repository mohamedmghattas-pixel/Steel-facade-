/**
 * Assistant tools for profile assemblies (composite sections): list them,
 * import assembly details from DXF text, give an assembly to a role or to
 * members, and set component options. Every edit goes through store.apply
 * (undoable). See docs/PROFILE_ASSEMBLIES.md.
 */
import type { ToolModule, Json } from './types';
import { useStore } from '../../state/store';
import type { ComponentLengthRule, Id, MemberRole, ProfileAssembly, ProfileComponentKind } from '../../core/model/types';
import { MEMBER_ROLES } from '../../core/model/types';
import {
  COMPONENT_KINDS,
  addProfileAssembly,
  assemblyBox,
  assemblyMassPerMetre,
  assignProfileAssembly,
  lengthRuleLabel,
  setComponentOptions,
  setProfileAssemblyMain,
  updateProfileAssembly,
} from '../../core/library/profileAssembly';
import { buildDetailAssembly, defaultDetailChoice, parseAssemblyDxf, relativeOrientation } from '../../core/library/profileAssemblyDxf';
import { assignProfilesByRole, setRoleProfile } from '../../core/model/roleProfiles';

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const st = () => useStore.getState();
const r2 = (v: number) => Math.round(v * 100) / 100;

function find(key: unknown): ProfileAssembly {
  const k = String(key ?? '').trim();
  const list = st().project.library.profileAssemblies ?? [];
  const a = list.find((x) => x.id === k) ?? list.find((x) => x.name.toLowerCase() === k.toLowerCase());
  if (!a) throw new Error(`No profile assembly "${k}". Known: ${list.map((x) => x.name).join(', ') || 'none'}.`);
  return a;
}

function summary(a: ProfileAssembly) {
  const p = st().project;
  const b = assemblyBox(a);
  const kg = assemblyMassPerMetre(a);
  return {
    id: a.id,
    name: a.name,
    prefix: a.prefix ?? null,
    basePoint: a.basePoint ?? null,
    sizeMm: [r2(b.maxX - b.minX), r2(b.maxY - b.minY)],
    kgPerM: { fabricated: r2(kg.fabricated), total: r2(kg.total) },
    main: a.main,
    orientations: a.orientations ?? [],
    members: Object.values(p.members).filter((m) => m.profileAssembly === a.id).length,
    roles: Object.entries(p.settings.roleProfiles ?? {})
      .filter(([, rp]) => rp?.assembly === a.id)
      .map(([r]) => r),
    components: a.components.map((c) => ({ key: c.key, name: c.name, profile: c.profile, material: c.material, kind: c.kind, fabricate: c.fabricate, lengthRule: lengthRuleLabel(c.lengthRule) })),
  };
}

function rule(x: Json): ComponentLengthRule | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const k = x.kind;
  if (k === 'percent') return { kind: 'percent', percent: Number(x.percent ?? 0) };
  if (k === 'pieces') return { kind: 'pieces', length: Number(x.length ?? 100), spacing: Number(x.spacing ?? 600), edge: Number(x.edge ?? 0), at: x.at === 'nodes' ? 'nodes' : 'spacing' };
  if (k === 'full') return { kind: 'full', ...(x.start ? { start: Number(x.start) } : {}), ...(x.end ? { end: Number(x.end) } : {}) };
  throw new Error('lengthRule.kind must be full, percent or pieces.');
}

export const profileAssembliesModule: ToolModule = {
  tools: [
    {
      name: 'profile_assembly_list',
      description: 'List the profile assemblies (composite sections: several profiles on one base point, e.g. a curtain-wall mullion with steel box, aluminium extrusions, gaskets, packers): components with material, kind, fabricate flag and length rule, size, kg/m, members and roles using each.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'profile_assembly_import_dxf',
      description:
        'Import assembly details from DXF text: finds base points (POINT, marker blocks like CP, INSERT-layer circles), clusters closed outlines per base point, nests hollows, maps layers to material / kind, detects turned copies. dryRun (default true) only reports the details; otherwise saves one assembly per detail (names[i], prefixes[i]); a detail that is a turned copy of another is merged as an orientation unless keepCopies.',
      input_schema: {
        type: 'object',
        properties: {
          dxf: { type: 'string', description: 'ASCII DXF content' },
          fileName: str,
          unitScale: { type: 'number', description: 'mm per drawing unit (default from the header)' },
          dryRun: { type: 'boolean' },
          names: { type: 'array', items: str },
          prefixes: { type: 'array', items: str },
          keepCopies: { type: 'boolean' },
        },
        required: ['dxf'],
      },
    },
    {
      name: 'profile_assembly_assign',
      description: 'Give a profile assembly to member roles (role profile; apply updates existing members of the role) and / or to members (ids, or "selection"). assembly: id or name; "" on roles clears the assembly (members keep the main profile). rotation: member rotation (e.g. an orientation of the assembly).',
      input_schema: {
        type: 'object',
        properties: {
          assembly: str,
          roles: { type: 'array', items: { type: 'string', enum: MEMBER_ROLES } },
          members: { type: 'array', items: str },
          selection: { type: 'boolean' },
          rotation: num,
          apply: { type: 'boolean', description: 'roles: update existing members too (default true)' },
        },
        required: ['assembly'],
      },
    },
    {
      name: 'profile_assembly_set',
      description:
        'Change a profile assembly: name, prefix (assembly marks), basePoint note, main component key, and per component (key) name, material (S355, 6063 T6, EPDM, HDPE …), kind, fabricate (false = listed only: gaskets in metres, shims in pieces) and lengthRule {kind: full, start, end mm | percent, percent | pieces, length, spacing, edge, at: spacing/nodes}.',
      input_schema: {
        type: 'object',
        properties: {
          assembly: str,
          name: str,
          prefix: str,
          basePoint: str,
          main: str,
          components: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: str,
                name: str,
                material: str,
                kind: { type: 'string', enum: COMPONENT_KINDS },
                fabricate: { type: 'boolean' },
                lengthRule: { type: 'object', properties: { kind: { type: 'string', enum: ['full', 'percent', 'pieces'] }, start: num, end: num, percent: num, length: num, spacing: num, edge: num, at: { type: 'string', enum: ['spacing', 'nodes'] } } },
              },
              required: ['key'],
            },
          },
        },
        required: ['assembly'],
      },
    },
  ],
  run: {
    profile_assembly_list: () => ({ assemblies: (st().project.library.profileAssemblies ?? []).map(summary) }),

    profile_assembly_import_dxf: (input: Json) => {
      const fileName = String(input.fileName ?? 'detail.dxf');
      const imp = parseAssemblyDxf(String(input.dxf ?? ''), { fileName, unitScale: typeof input.unitScale === 'number' ? input.unitScale : undefined });
      const details = imp.details.map((d, i) => ({
        detail: i + 1,
        basePoint: { x: r2(d.base.x), y: r2(d.base.y), from: d.baseFrom },
        components: d.outlines.map((o) => ({ name: imp.outlines[o].name, layer: imp.outlines[o].block ?? imp.outlines[o].layer, material: imp.outlines[o].rule.material, kind: imp.outlines[o].rule.kind, areaMm2: r2(imp.outlines[o].area), holes: imp.outlines[o].holes.length, error: imp.outlines[o].error })),
        duplicateOf: d.duplicateOf ? { detail: d.duplicateOf.detail + 1, rotation: d.duplicateOf.rotation, mirror: d.duplicateOf.mirror } : null,
        similarTo: d.similarTo ? { detail: d.similarTo.detail + 1, rotation: d.similarTo.rotation, matched: d.similarTo.matched, total: d.similarTo.total, differ: d.similarTo.differ } : null,
      }));
      if (input.dryRun !== false) return { details, notes: imp.notes, saved: [] };
      const names = Array.isArray(input.names) ? input.names.map(String) : [];
      const prefixes = Array.isArray(input.prefixes) ? input.prefixes.map(String) : [];
      const base = fileName.replace(/\.[^.]+$/, '');
      const saved: string[] = [];
      const errors: string[] = [];
      st().apply(`Import profile assemblies from ${fileName}`, (p) => {
        imp.details.forEach((d, i) => {
          if (d.duplicateOf && !input.keepCopies) return;
          const choice = defaultDetailChoice(imp, i, names[i] || (imp.details.length > 1 ? `${base} ${i + 1}` : base));
          if (prefixes[i]) choice.prefix = prefixes[i];
          choice.source = fileName;
          const copies = imp.details.map((x, j) => ({ x, j })).filter(({ x }) => !input.keepCopies && x.duplicateOf?.detail === i);
          if (copies.length) choice.orientations = [{ name: choice.name, rotation: 0 }, ...copies.map(({ x, j }) => ({ name: names[j] || `${base} ${j + 1}`, ...relativeOrientation(x.duplicateOf!, { rotation: 0, mirror: false }) }))];
          const b = buildDetailAssembly(imp, i, choice);
          errors.push(...b.errors);
          if (!b.assembly.components.length) return;
          saved.push(addProfileAssembly(p, b.assembly, b.defs).name);
        });
      });
      return { details, notes: imp.notes, saved, errors, assemblies: saved.map((n) => summary(find(n))) };
    },

    profile_assembly_assign: (input: Json) => {
      const clear = input.assembly === '';
      const a = clear ? null : find(input.assembly);
      const roles = (Array.isArray(input.roles) ? input.roles : []) as MemberRole[];
      const sel = st().selection.members;
      const ids: Id[] = input.selection ? sel : Array.isArray(input.members) ? input.members.map(String) : [];
      if (!roles.length && !ids.length) throw new Error('Give roles and / or members (or selection: true).');
      const rotation = typeof input.rotation === 'number' ? input.rotation : undefined;
      let changed = 0;
      st().apply(a ? `Profile assembly ${a.name}` : 'Single profile', (d) => {
        for (const r of roles) {
          const cur = d.settings.roleProfiles?.[r];
          if (!a) {
            if (cur?.assembly) setRoleProfile(d, r, { ...cur, assembly: undefined });
            continue;
          }
          setRoleProfile(d, r, { profile: cur?.profile ?? '', assembly: a.id, alignMode: 'insertion', ...(rotation !== undefined ? { rotation } : cur?.rotation !== undefined ? { rotation: cur.rotation } : {}) });
        }
        if (roles.length && input.apply !== false) changed += assignProfilesByRole(d, undefined, roles);
        if (ids.length) changed += assignProfileAssembly(d, ids, a?.id ?? null, rotation === undefined ? {} : { rotation });
      });
      return { assembly: a ? summary(find(a.id)) : null, roles, changed };
    },

    profile_assembly_set: (input: Json) => {
      const a = find(input.assembly);
      st().apply(`Profile assembly ${a.name}`, (d) => {
        const patch: Parameters<typeof updateProfileAssembly>[2] = {};
        if (typeof input.name === 'string') patch.name = input.name;
        if (typeof input.prefix === 'string') patch.prefix = input.prefix;
        if (typeof input.basePoint === 'string') patch.basePoint = input.basePoint || undefined;
        if (Object.keys(patch).length) updateProfileAssembly(d, a.id, patch);
        for (const c of (Array.isArray(input.components) ? input.components : []) as Json[]) {
          const p: Parameters<typeof setComponentOptions>[3] = {};
          if (typeof c.name === 'string') p.name = c.name;
          if (typeof c.material === 'string') p.material = c.material;
          if (typeof c.kind === 'string') p.kind = c.kind as ProfileComponentKind;
          if (typeof c.fabricate === 'boolean') p.fabricate = c.fabricate;
          const lr = rule(c.lengthRule as Json);
          if (lr) p.lengthRule = lr;
          setComponentOptions(d, a.id, String(c.key), p);
        }
        if (typeof input.main === 'string' && input.main) setProfileAssemblyMain(d, a.id, input.main);
      });
      return summary(find(a.id));
    },
  },
};
