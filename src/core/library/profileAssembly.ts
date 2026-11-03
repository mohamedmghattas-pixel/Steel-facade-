/**
 * Profile assemblies (composite sections): several profiles that share one
 * assembly insertion point, the **base point** — a curtain-wall mullion made of
 * a steel box, aluminium extrusions, a pressure plate, a cover cap, gaskets and
 * packers. A member carrying one (`Member.profileAssembly`) is derived as one
 * part per fabricated component along its wire line, all in one assembly with
 * the main component as its main part; gaskets and other listed-only components
 * become accessories (metres or pieces). See docs/PROFILE_ASSEMBLIES.md.
 *
 * Coordinates: every component is placed in the section drawing coordinates of
 * the assembly (x → member local y, y → member local z, docs/PROFILES.md §2)
 * with the base point at (0, 0). A DXF-uploaded component is a custom POLY
 * profile drawn in exactly those coordinates with its insertion point at the
 * base point; a catalogue profile is placed by `offset` (where its insertion
 * point, else its box centre, sits from the base point).
 *
 * Everything here is pure (no DOM): helpers for derivation, outputs and the UI,
 * plus project operations that run inside `store.apply`.
 */
import type {
  ComponentLengthRule,
  Finish,
  Id,
  Member,
  Project,
  ProfileAssembly,
  ProfileAssemblyComponent,
  ProfileComponentKind,
  Vec2,
} from '../model/types';
import { getProfile, profileFromDef, type Profile, type ProfileDef } from './profiles';
import { findMaterial } from './materials';
import { shapeOutline } from './shapes';

export const COMPONENT_KINDS: readonly ProfileComponentKind[] = ['structural', 'cladding', 'gasket', 'shim', 'accessory'];

export const KIND_LABEL: Record<ProfileComponentKind, string> = {
  structural: 'Structural',
  cladding: 'Cladding / cover',
  gasket: 'Gasket',
  shim: 'Shim / packer',
  accessory: 'Accessory',
};

// ---------------------------------------------------------------------------
// Materials of components

/**
 * Non-metal materials of listed components (gaskets, packers, thermal breaks).
 * Densities are typical values (dense EPDM 1.1–1.5 g/cm³): use the supplier's
 * data sheet for weights that matter.
 */
export const NON_METALS: readonly { name: string; density: number; description: string; class: 'rubber' | 'plastic' }[] = [
  { name: 'EPDM', density: 1300, description: 'EPDM rubber gasket (dense, typical)', class: 'rubber' },
  { name: 'Silicone', density: 1200, description: 'Silicone rubber (typical)', class: 'rubber' },
  { name: 'Neoprene', density: 1300, description: 'Chloroprene rubber (typical)', class: 'rubber' },
  { name: 'PVC', density: 1400, description: 'PVC-U (typical)', class: 'plastic' },
  { name: 'HDPE', density: 950, description: 'HDPE packer / shim (typical)', class: 'plastic' },
  { name: 'PA66 GF25', density: 1300, description: 'Polyamide thermal break (typical)', class: 'plastic' },
];

/** The non-metal of a material name (EPDM, HDPE …), case and spaces ignored. */
export const nonMetal = (name: string | undefined) => {
  const k = (name ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  return NON_METALS.find((m) => m.name.toLowerCase().replace(/[\s_-]+/g, '') === k);
};

export type MaterialClass = 'steel' | 'stainless' | 'aluminium' | 'rubber' | 'plastic';

/** Broad class of a material name (hatching, colours, NC rules). Unknown names count as plastic when not metal-like. */
export function materialClass(material: string | undefined): MaterialClass {
  const nm = nonMetal(material);
  if (nm) return nm.class;
  const m = findMaterial(material);
  if (m) return m.family === 'aluminium' ? 'aluminium' : m.family === 'stainless' ? 'stainless' : 'steel';
  const s = (material ?? '').toLowerCase();
  if (/alu|60\d\d/.test(s)) return 'aluminium';
  if (/rubber|epdm|sil|neopr|gasket/.test(s)) return 'rubber';
  if (/^s\d|steel|^a\d/.test(s)) return 'steel';
  return 'plastic';
}

/** kg/m³ of a component material (catalogue metals, the non-metals above, else steel). */
export function componentDensity(material: string | undefined): number {
  return findMaterial(material)?.density ?? nonMetal(material)?.density ?? 7850;
}

/** Proper name of a component material (catalogue / non-metal spelling), or the text as given. */
export function canonicalMaterial(material: string): string {
  return findMaterial(material)?.name ?? nonMetal(material)?.name ?? material.trim();
}

/** Description of a component material (IFC, lists). */
export function materialDescription(material: string): string {
  return findMaterial(material)?.description ?? nonMetal(material)?.description ?? material;
}

/** True for materials the profile catalogue knows (a ProfileDef can carry them). */
export const isCatalogueMaterial = (material: string | undefined) => !!findMaterial(material);

// ---------------------------------------------------------------------------
// Length rules

export function defaultLengthRule(kind: ProfileComponentKind): ComponentLengthRule {
  if (kind === 'gasket') return { kind: 'percent', percent: 2 };
  if (kind === 'shim') return { kind: 'pieces', length: 100, spacing: 600, edge: 150, at: 'spacing' };
  return { kind: 'full' };
}

/** Whether a kind is fabricated (a part with NC data and drawings) by default. */
export const defaultFabricate = (kind: ProfileComponentKind) => kind === 'structural' || kind === 'cladding';

const fmt = (n: number) => String(Math.round(n * 10) / 10);
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

export function lengthRuleLabel(r: ComponentLengthRule): string {
  if (r.kind === 'percent') return `L ${signed(r.percent)} %`;
  if (r.kind === 'pieces') return r.at === 'nodes' ? `${fmt(r.length)} mm at each connection node` : `${fmt(r.length)} mm every ${fmt(r.spacing ?? 600)} mm`;
  const s = r.start ?? 0;
  const e = r.end ?? 0;
  if (!s && !e) return 'Full length';
  return s === e ? `L ${signed(s)} mm per end` : `L ${signed(s)} / ${signed(e)} mm`;
}

/**
 * Pieces of a 'pieces' rule along a part of length L: their start x and length.
 * 'spacing': n = ⌊(L − 2·edge − length) / spacing⌋ + 1 pieces (at least 1), centred;
 * 'nodes': one centred at each x in `nodeXs` (clamped inside the part, pieces closer
 * than their length merged).
 */
export function rulePieces(r: Extract<ComponentLengthRule, { kind: 'pieces' }>, L: number, nodeXs: number[] = []): { x: number; length: number }[] {
  const len = Math.max(1, Math.min(r.length || 100, L));
  if (L <= 0) return [];
  if (r.at === 'nodes') {
    const xs = [...nodeXs].map((x) => Math.min(L - len / 2, Math.max(len / 2, x))).sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of xs) if (!out.length || x - out[out.length - 1] >= len - 1e-6) out.push(x);
    return out.map((x) => ({ x: x - len / 2, length: len }));
  }
  const S = Math.max(len, r.spacing || 600);
  const edge = Math.max(0, r.edge ?? 0);
  const n = Math.max(1, Math.floor((L - 2 * edge - len) / S + 1e-9) + 1);
  const c0 = L / 2 - ((n - 1) * S) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: c0 + i * S - len / 2, length: len }));
}

/** Allowances at the start and end of a 'full' rule (positive = longer), 0 for the others. */
export function ruleAllowances(r: ComponentLengthRule): { start: number; end: number } {
  return r.kind === 'full' ? { start: r.start ?? 0, end: r.end ?? 0 } : { start: 0, end: 0 };
}

/** Run length of a component on a part of length L (pieces: their total), mm. */
export function ruleRunLength(r: ComponentLengthRule, L: number, nodeXs: number[] = []): number {
  if (r.kind === 'percent') return L * (1 + (r.percent || 0) / 100);
  if (r.kind === 'pieces') return rulePieces(r, L, nodeXs).reduce((s, x) => s + x.length, 0);
  const a = ruleAllowances(r);
  return Math.max(0, L + a.start + a.end);
}

// ---------------------------------------------------------------------------
// Lookup and placement

export function findProfileAssembly(p: Pick<Project, 'library'>, id: Id | undefined | null): ProfileAssembly | undefined {
  if (!id) return undefined;
  return (p.library?.profileAssemblies ?? []).find((a) => a.id === id);
}

export function mainComponent(asm: ProfileAssembly): ProfileAssemblyComponent | undefined {
  return asm.components.find((c) => c.key === asm.main) ?? asm.components[0];
}

/**
 * The composite a member carries: its profile assembly, when that exists and the
 * member's profile is still the assembly's main profile (a member given another
 * profile by any command is a single profile again).
 */
export function memberComposite(p: Pick<Project, 'library'>, m: Pick<Member, 'profile' | 'profileAssembly'>): { asm: ProfileAssembly; main: ProfileAssemblyComponent } | undefined {
  if (!m.profileAssembly || !m.profile) return undefined;
  const asm = findProfileAssembly(p, m.profileAssembly);
  const main = asm && mainComponent(asm);
  if (!asm || !main) return undefined;
  const prof = getProfile(main.profile);
  return prof && prof.name === getProfile(m.profile)?.name ? { asm, main } : undefined;
}

/** The base point relative to a component profile's box centre (outline coordinates). */
export function componentInsertion(c: Pick<ProfileAssemblyComponent, 'offset'>, prof: Pick<Profile, 'insertion'>): Vec2 {
  const ins = prof.insertion ?? { x: 0, y: 0 };
  return { x: ins.x - (c.offset?.x ?? 0), y: ins.y - (c.offset?.y ?? 0) };
}

/**
 * Shift of a component's box centre from the member's wire line, in local (y, z)
 * (the role of `sectionShift` for a composite). The base point sits on the wire
 * line plus the member offsets; with `alignMode: 'grid'` the main component is
 * placed on its 3×3 grid and the others follow it. A mirrored section mirrors
 * the whole composite about the wire line's local z.
 */
export function componentShift(
  m: Pick<Member, 'alignMode' | 'alignY' | 'alignZ' | 'offsetY' | 'offsetZ' | 'mirrorSection'>,
  mainProf: Pick<Profile, 'insertion' | 'b' | 'h'>,
  mainComp: Pick<ProfileAssemblyComponent, 'offset'>,
  comp: Pick<ProfileAssemblyComponent, 'offset'>,
  compProf: Pick<Profile, 'insertion'>,
): Vec2 {
  const oy = m.offsetY || 0;
  const oz = m.offsetZ || 0;
  let base: Vec2 = { x: oy, y: oz };
  if (m.alignMode === 'grid') {
    const insM = componentInsertion(mainComp, mainProf);
    base = { x: -(m.alignY ?? 0) * (mainProf.b / 2) + oy + insM.x, y: -(m.alignZ ?? 0) * (mainProf.h / 2) + oz + insM.y };
  }
  const ins = componentInsertion(comp, compProf);
  const s = { x: base.x - ins.x, y: base.y - ins.y };
  return m.mirrorSection ? { x: -s.x, y: s.y } : s;
}

export interface ComponentSection {
  comp: ProfileAssemblyComponent;
  profile: Profile;
  /** Outline and holes in the assembly's section coordinates (base point at 0, 0). */
  outer: Vec2[];
  holes: Vec2[][];
  /** Area mm², mass kg/m in the component material. */
  area: number;
  kgm: number;
}

/** Every component's outline in base-point coordinates, with area and kg/m (components whose profile is missing are left out). */
export function assemblySections(asm: ProfileAssembly): ComponentSection[] {
  const out: ComponentSection[] = [];
  for (const comp of asm.components) {
    const prof = getProfile(comp.profile);
    if (!prof) continue;
    const ins = componentInsertion(comp, prof);
    const o = shapeOutline(prof.shape);
    const mv = (pts: Vec2[]) => pts.map((q) => ({ x: q.x - ins.x, y: q.y - ins.y }));
    out.push({ comp, profile: prof, outer: mv(o.outer), holes: o.holes.map(mv), area: prof.area, kgm: (prof.area * componentDensity(comp.material)) / 1e6 });
  }
  return out;
}

/** Bounding box of the composite in base-point coordinates (every component). */
export function assemblyBox(asm: ProfileAssembly): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of assemblySections(asm))
    for (const q of s.outer) {
      b.minX = Math.min(b.minX, q.x);
      b.minY = Math.min(b.minY, q.y);
      b.maxX = Math.max(b.maxX, q.x);
      b.maxY = Math.max(b.maxY, q.y);
    }
  return Number.isFinite(b.minX) ? b : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/** Mass per metre of the fabricated components / of all components, kg/m. */
export function assemblyMassPerMetre(asm: ProfileAssembly): { fabricated: number; total: number } {
  let fabricated = 0;
  let total = 0;
  for (const s of assemblySections(asm)) {
    total += s.kgm;
    if (s.comp.fabricate) fabricated += s.kgm;
  }
  return { fabricated, total };
}

/** Problems that keep an assembly from deriving as intended (empty when fine). */
export function validateProfileAssembly(asm: ProfileAssembly): string[] {
  const out: string[] = [];
  if (!asm.name?.trim()) out.push('The assembly needs a name.');
  if (!asm.components.length) out.push('The assembly has no components.');
  const keys = new Set<string>();
  for (const c of asm.components) {
    if (keys.has(c.key)) out.push(`Component key "${c.key}" is used twice.`);
    keys.add(c.key);
    if (!getProfile(c.profile)) out.push(`${c.name}: profile "${c.profile}" is not in the library.`);
    if (c.lengthRule.kind === 'pieces' && !(c.lengthRule.length > 0)) out.push(`${c.name}: pieces need a length.`);
  }
  const main = asm.components.find((c) => c.key === asm.main);
  if (!main) out.push(`Main component "${asm.main}" is not a component.`);
  else if (!main.fabricate) out.push(`The main component ${main.name} must be fabricated (it is the member's own part).`);
  if (asm.prefix && !/^[A-Za-z0-9_-]{1,8}$/.test(asm.prefix)) out.push('The prefix takes 1–8 letters, digits, - or _.');
  return out;
}

// ---------------------------------------------------------------------------
// Migration

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function sanitizeRule(r: unknown, kind: ProfileComponentKind): ComponentLengthRule {
  const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
  if (o.kind === 'percent') return { kind: 'percent', percent: num(o.percent, 0) };
  if (o.kind === 'pieces') return { kind: 'pieces', length: num(o.length, 100) || 100, spacing: num(o.spacing, 600) || 600, edge: num(o.edge, 0), at: o.at === 'nodes' ? 'nodes' : 'spacing' };
  if (o.kind === 'full') return { kind: 'full', ...(num(o.start) ? { start: num(o.start) } : {}), ...(num(o.end) ? { end: num(o.end) } : {}) };
  return defaultLengthRule(kind);
}

/** Profile assemblies of a loaded project: well-formed entries only, every field defaulted. */
export function sanitizeProfileAssemblies(raw: unknown): ProfileAssembly[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileAssembly[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || typeof (a as ProfileAssembly).id !== 'string') continue;
    const src = a as ProfileAssembly;
    const components: ProfileAssemblyComponent[] = (Array.isArray(src.components) ? src.components : [])
      .filter((c) => c && typeof c === 'object' && typeof c.key === 'string' && typeof c.profile === 'string')
      .map((c) => {
        const kind: ProfileComponentKind = COMPONENT_KINDS.includes(c.kind) ? c.kind : 'structural';
        return {
          ...c,
          name: typeof c.name === 'string' && c.name ? c.name : c.key,
          material: typeof c.material === 'string' && c.material ? c.material : 'S355',
          kind,
          fabricate: typeof c.fabricate === 'boolean' ? c.fabricate : defaultFabricate(kind),
          lengthRule: sanitizeRule(c.lengthRule, kind),
        };
      });
    if (!components.length) continue;
    out.push({
      ...src,
      name: typeof src.name === 'string' && src.name ? src.name : src.id,
      components,
      main: components.some((c) => c.key === src.main) ? src.main : components[0].key,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project operations (run inside store.apply; throw ProfileAssemblyError)

export class ProfileAssemblyError extends Error {}

let counter = 0;
export function newAssemblyId(): Id {
  counter = (counter + 1) % 1e6;
  return `pa${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Name of a component profile: "<assembly> / <component>". */
export const componentProfileName = (assembly: string, component: string) => `${assembly.trim()} / ${component.trim()}`;

/**
 * Add (or replace, same id) a profile assembly with the profile definitions of
 * its components (custom profiles of the same name are replaced). Throws when a
 * definition is invalid, takes a catalogue name, or the assembly is invalid.
 */
export function addProfileAssembly(p: Project, asm: ProfileAssembly, defs: ProfileDef[] = []): ProfileAssembly {
  for (const d of defs) {
    const existing = getProfile(d.name);
    if (existing && !existing.custom) throw new ProfileAssemblyError(`"${d.name}" is a catalogue profile name.`);
    try {
      profileFromDef(d);
    } catch (e) {
      throw new ProfileAssemblyError((e as Error).message);
    }
  }
  const names = new Set(defs.map((d) => d.name));
  p.library.profiles = [...p.library.profiles.filter((d) => !names.has(String(d.name))), ...(defs as unknown as Record<string, unknown>[])];
  const missing = asm.components.filter((c) => !names.has(c.profile) && !getProfile(c.profile));
  if (missing.length) throw new ProfileAssemblyError(`Unknown profile${missing.length === 1 ? '' : 's'}: ${missing.map((c) => c.profile).join(', ')}.`);
  const out: ProfileAssembly = { ...asm, id: asm.id || newAssemblyId(), components: asm.components.map((c) => ({ ...c, material: canonicalMaterial(c.material) })) };
  // Profiles registered in this same edit are checked by name above; validate the rest of the structure.
  const errs = validateStructure(out);
  if (errs.length) throw new ProfileAssemblyError(errs[0]);
  p.library.profileAssemblies ??= [];
  const i = p.library.profileAssemblies.findIndex((a) => a.id === out.id);
  if (i >= 0) p.library.profileAssemblies[i] = out;
  else p.library.profileAssemblies.push(out);
  return out;
}

function validateStructure(asm: ProfileAssembly): string[] {
  const out: string[] = [];
  if (!asm.name?.trim()) out.push('The assembly needs a name.');
  if (!asm.components.length) out.push('The assembly has no components.');
  const keys = new Set<string>();
  for (const c of asm.components) {
    if (keys.has(c.key)) out.push(`Component key "${c.key}" is used twice.`);
    keys.add(c.key);
  }
  const main = asm.components.find((c) => c.key === asm.main);
  if (!main) out.push(`Main component "${asm.main}" is not a component.`);
  else if (!main.fabricate) out.push(`The main component ${main.name} must be fabricated.`);
  if (asm.prefix && !/^[A-Za-z0-9_-]{1,8}$/.test(asm.prefix)) out.push('The prefix takes 1–8 letters, digits, - or _.');
  return out;
}

/** Member fields that make a member carry the assembly (profile = main component's profile, its material, base point on the wire line). */
export function profileAssemblyPatch(asm: ProfileAssembly): Partial<Member> {
  const main = mainComponent(asm);
  const prof = main ? getProfile(main.profile) : undefined;
  if (!main || !prof) throw new ProfileAssemblyError(`${asm.name}: the main component's profile is missing.`);
  const patch: Partial<Member> = { profile: prof.name, profileAssembly: asm.id, alignMode: 'insertion' };
  const mat = findMaterial(main.material);
  if (mat) patch.material = mat.name;
  return patch;
}

/**
 * Give members a profile assembly (null: back to the main component's single
 * profile). Optional rotation. Returns how many members changed.
 */
export function assignProfileAssembly(p: Project, memberIds: Iterable<Id>, id: Id | null, opts: { rotation?: number } = {}): number {
  let n = 0;
  if (id === null) {
    for (const mid of memberIds) {
      const m = p.members[mid];
      if (m?.profileAssembly) {
        delete m.profileAssembly;
        n++;
      }
    }
    return n;
  }
  const asm = findProfileAssembly(p, id);
  if (!asm) throw new ProfileAssemblyError(`No profile assembly "${id}".`);
  const patch = profileAssemblyPatch(asm);
  if (opts.rotation !== undefined && Number.isFinite(opts.rotation)) patch.rotation = opts.rotation;
  for (const mid of memberIds) {
    const m = p.members[mid];
    if (!m) continue;
    const before = JSON.stringify([m.profile, m.profileAssembly, m.material, m.alignMode, m.rotation]);
    Object.assign(m, patch);
    if (JSON.stringify([m.profile, m.profileAssembly, m.material, m.alignMode, m.rotation]) !== before) n++;
  }
  return n;
}

/** Change component options (name, material, kind, fabricate, length rule, finish, offset). */
export function setComponentOptions(p: Project, id: Id, key: string, patch: Partial<Omit<ProfileAssemblyComponent, 'key' | 'profile'>>): ProfileAssemblyComponent {
  const asm = findProfileAssembly(p, id);
  if (!asm) throw new ProfileAssemblyError(`No profile assembly "${id}".`);
  const c = asm.components.find((x) => x.key === key);
  if (!c) throw new ProfileAssemblyError(`${asm.name} has no component "${key}".`);
  if (patch.material !== undefined) patch.material = canonicalMaterial(patch.material);
  if (key === asm.main && patch.fabricate === false) throw new ProfileAssemblyError('The main component must be fabricated.');
  Object.assign(c, patch);
  if (patch.kind && !patch.lengthRule && c.lengthRule.kind === 'full' && (patch.kind === 'gasket' || patch.kind === 'shim')) c.lengthRule = defaultLengthRule(patch.kind);
  if (key === asm.main && patch.material) syncMain(p, asm);
  return c;
}

/** Set the main component; members and role profiles that carry the assembly follow (profile and material). */
export function setProfileAssemblyMain(p: Project, id: Id, key: string) {
  const asm = findProfileAssembly(p, id);
  if (!asm) throw new ProfileAssemblyError(`No profile assembly "${id}".`);
  const c = asm.components.find((x) => x.key === key);
  if (!c) throw new ProfileAssemblyError(`${asm.name} has no component "${key}".`);
  c.fabricate = true;
  if (c.lengthRule.kind !== 'full') c.lengthRule = { kind: 'full' };
  asm.main = key;
  syncMain(p, asm);
}

function syncMain(p: Project, asm: ProfileAssembly) {
  const patch = profileAssemblyPatch(asm);
  for (const m of Object.values(p.members)) if (m.profileAssembly === asm.id) Object.assign(m, { profile: patch.profile, ...(patch.material ? { material: patch.material } : {}) });
  for (const rp of Object.values(p.settings.roleProfiles ?? {})) if (rp?.assembly === asm.id) rp.profile = patch.profile!;
}

/** Rename an assembly, its prefix and base-point note. */
export function updateProfileAssembly(p: Project, id: Id, patch: Partial<Pick<ProfileAssembly, 'name' | 'prefix' | 'basePoint' | 'orientations'>>) {
  const asm = findProfileAssembly(p, id);
  if (!asm) throw new ProfileAssemblyError(`No profile assembly "${id}".`);
  if (patch.prefix !== undefined && patch.prefix && !/^[A-Za-z0-9_-]{1,8}$/.test(patch.prefix)) throw new ProfileAssemblyError('The prefix takes 1–8 letters, digits, - or _.');
  if (patch.name !== undefined && !patch.name.trim()) throw new ProfileAssemblyError('The assembly needs a name.');
  Object.assign(asm, patch);
  if (patch.prefix === '') delete asm.prefix;
}

/**
 * Remove an assembly: members carrying it keep the main component as a single
 * profile, role profiles keep the main profile. With `profiles`, component
 * profiles no member uses any more are removed from the library too.
 */
export function removeProfileAssembly(p: Project, id: Id, opts: { profiles?: boolean } = {}): number {
  const asm = findProfileAssembly(p, id);
  if (!asm) throw new ProfileAssemblyError(`No profile assembly "${id}".`);
  let n = 0;
  for (const m of Object.values(p.members))
    if (m.profileAssembly === id) {
      delete m.profileAssembly;
      n++;
    }
  for (const rp of Object.values(p.settings.roleProfiles ?? {})) if (rp?.assembly === id) delete rp.assembly;
  p.library.profileAssemblies = p.library.profileAssemblies.filter((a) => a.id !== id);
  if (opts.profiles) {
    const used = new Set(Object.values(p.members).map((m) => m.profile));
    for (const rp of Object.values(p.settings.roleProfiles ?? {})) if (rp) used.add(rp.profile);
    for (const a of p.library.profileAssemblies) for (const c of a.components) used.add(c.profile);
    const drop = new Set(asm.components.map((c) => c.profile).filter((x) => !used.has(x)));
    p.library.profiles = p.library.profiles.filter((d) => !drop.has(String(d.name)));
  }
  return n;
}

/** Finish of a fabricated component part: its own, else the member's for steel, else none. */
export function componentFinish(c: ProfileAssemblyComponent, memberFinish: Finish): Finish {
  if (c.finish) return c.finish;
  const k = materialClass(c.material);
  return k === 'steel' ? memberFinish : 'none';
}

/** The profile assembly a profile is a component of (the first one, when several use it), with that component. */
export function assemblyOfProfile(p: Pick<Project, 'library'>, profile: string): { asm: ProfileAssembly; comp: ProfileAssemblyComponent } | undefined {
  for (const asm of p.library?.profileAssemblies ?? []) {
    const comp = asm.components.find((c) => c.profile === profile);
    if (comp) return { asm, comp };
  }
  return undefined;
}
