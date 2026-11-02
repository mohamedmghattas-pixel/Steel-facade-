/**
 * UI commands for profile assemblies (composite sections): DXF upload with a
 * review step, saving reviewed details, assigning an assembly to members or a
 * role, component options and removal. Model edits go through store.apply (one
 * undo step each); questions use the in-app askConfirm.
 */
import type { Id, MemberRole, ProfileAssembly, ProfileAssemblyComponent, Project, RoleProfile } from '../core/model/types';
import { ROLE_LABEL } from '../core/model/ops';
import {
  addProfileAssembly,
  assignProfileAssembly,
  removeProfileAssembly,
  setComponentOptions,
  setProfileAssemblyMain,
  updateProfileAssembly,
  ProfileAssemblyError,
} from '../core/library/profileAssembly';
import { buildDetailAssembly, defaultDetailChoice, parseAssemblyDxf, relativeOrientation, type DetailChoice } from '../core/library/profileAssemblyDxf';
import { useStore } from '../state/store';
import { pickFile } from '../state/storage';
import { askConfirm } from './askState';
import { useProfileUi, type AssemblyReview } from './profileUiState';
import { divisionNote, insertWithJunctions, setRoleProfileUi } from './profileActions';
import type { DivideResult } from '../core/model/junctions';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);

/** Review of an assembly-detail DXF (keeps the user's choices when the units or markers change). */
export function assemblyReviewFromText(fileName: string, text: string, opts: { unitScale?: number; markers?: string[] | null } = {}, prev?: AssemblyReview): AssemblyReview {
  const imp = parseAssemblyDxf(text, { fileName, unitScale: opts.unitScale, markerBlocks: opts.markers ?? undefined });
  const base = fileName.replace(/\.[^.]+$/, '');
  const details = imp.details.map((d, i) => {
    const old = prev?.details[i];
    const choice = defaultDetailChoice(imp, i, old?.choice.name ?? (imp.details.length > 1 ? `${base} ${i + 1}` : base));
    choice.source = fileName;
    if (old) {
      choice.prefix = old.choice.prefix;
      choice.basePointNote = old.choice.basePointNote;
      choice.rotation = old.choice.rotation;
      choice.mirror = old.choice.mirror;
    }
    const dup = d.duplicateOf;
    return { action: dup ? ('merge' as const) : ('save' as const), into: dup?.detail, choice };
  });
  return { fileName, text, imp, markers: opts.markers ?? null, unitScale: opts.unitScale, details, current: prev ? Math.min(prev.current, Math.max(0, details.length - 1)) : 0 };
}

/** Library → "Import assembly detail (DXF)…": pick a file and open the review. */
export async function openAssemblyImport() {
  const f = await pickFile('.dxf');
  if (!f) return;
  openAssemblyReview(f.name, await f.text());
}

/** Open the assembly review on DXF text (also from the profile import review). */
export function openAssemblyReview(fileName: string, text: string) {
  try {
    const r = assemblyReviewFromText(fileName, text);
    if (!r.imp.details.length) return notify(`No assembly detail found in ${fileName}${r.imp.notes.length ? `: ${r.imp.notes[0]}` : '.'}`, 'error');
    useProfileUi.setState({ assemblyReview: r, review: null });
  } catch (e) {
    notify(`Could not read ${fileName}: ${(e as Error).message}`, 'error');
  }
}

export const closeAssemblyReview = () => useProfileUi.setState({ assemblyReview: null });

/**
 * Save the reviewed details: each 'save' detail becomes a ProfileAssembly with
 * its component profiles; 'merge' details become orientations of the detail
 * they merge into. One undo step. Returns the saved assemblies.
 */
export async function saveAssemblyReview(r: AssemblyReview): Promise<ProfileAssembly[]> {
  const built: { asm: ProfileAssembly; defs: ReturnType<typeof buildDetailAssembly>['defs'] }[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [i, d] of r.details.entries()) {
    if (d.action !== 'save') continue;
    const choice: DetailChoice = { ...d.choice, orientations: [] };
    // Details merged into this one: their orientation relative to it, as saved.
    const merged = r.details.map((x, j) => ({ x, j })).filter(({ x }) => x.action === 'merge' && x.into === i);
    if (merged.length) {
      choice.orientations = [{ name: d.choice.name, rotation: 0 }];
      for (const { x, j } of merged) {
        const rel = r.imp.details[j].duplicateOf ?? r.imp.details[j].similarTo;
        if (!rel || rel.detail !== i) continue;
        const o = relativeOrientation({ rotation: rel.rotation, mirror: rel.mirror }, { rotation: d.choice.rotation, mirror: d.choice.mirror });
        choice.orientations.push({ name: x.choice.name, rotation: o.rotation, ...(o.mirror ? { mirror: true } : {}) });
      }
    }
    const name = choice.name.trim();
    if (!name) errors.push(`Detail ${i + 1} needs an assembly name.`);
    else if (names.has(name)) errors.push(`Two details are named "${name}".`);
    names.add(name);
    const b = buildDetailAssembly(r.imp, i, choice);
    errors.push(...b.errors.map((e) => `${name}: ${e}`));
    if (b.assembly.components.length) built.push({ asm: b.assembly, defs: b.defs });
  }
  if (!built.length) {
    notify(errors[0] ?? 'Nothing to save: every detail is skipped or merged.', 'error');
    return [];
  }
  const existing = st().project.library.profileAssemblies ?? [];
  const clash = built.filter((b) => existing.some((a) => a.name === b.asm.name));
  if (clash.length && !(await askConfirm(`${clash.map((b) => b.asm.name).join(', ')} already exist${clash.length === 1 ? 's' : ''}. Replace?`, { title: 'Profile assemblies', ok: 'Replace' }))) return [];
  const saved: ProfileAssembly[] = [];
  try {
    st().apply(`Import ${built.length} profile assembl${built.length === 1 ? 'y' : 'ies'}`, (p) => {
      for (const b of built) {
        const old = (p.library.profileAssemblies ?? []).find((a) => a.name === b.asm.name);
        saved.push(addProfileAssembly(p, old ? { ...b.asm, id: old.id } : b.asm, b.defs));
      }
    });
  } catch (e) {
    notify((e as Error).message, 'error');
    return [];
  }
  useProfileUi.setState({ assemblyReview: null });
  const comps = saved.reduce((s, a) => s + a.components.length, 0);
  notify(`Saved ${saved.map((a) => a.name).join(', ')} (${comps} component profiles)${errors.length ? ` — ${errors.length} left out: ${errors[0]}` : ''}. Assign them in Library → Profiles by role or to selected members.`);
  return saved;
}

const run = (label: string, fn: (p: Project) => void): boolean => {
  try {
    st().apply(label, fn);
    return true;
  } catch (e) {
    notify(e instanceof ProfileAssemblyError ? e.message : (e as Error).message, 'error');
    return false;
  }
};

/** Give the selected members a profile assembly (null: back to the single main profile). */
export function assignAssemblyToSelection(id: Id | null, rotation?: number) {
  const sel = st().selection.members;
  if (!sel.length) return notify('Select members first.', 'error');
  let n = 0;
  let division: DivideResult | null = null;
  // Transoms crossing the touched mullions are divided there in the same step (mullions stay continuous).
  if (run(id ? 'Assign profile assembly' : 'Single profile', (d) => void ({ changed: n, division } = insertWithJunctions(d, sel, () => assignProfileAssembly(d, sel, id, rotation === undefined ? {} : { rotation })))))
    notify((id ? `Profile assembly on ${n} member${n === 1 ? '' : 's'}.` : `${n} member${n === 1 ? '' : 's'} back to a single profile.`) + (id ? divisionNote(division) : ''));
}

/** Profiles by role: the role's members carry this assembly (rotation from the chosen orientation). */
export function setRoleAssemblyUi(role: MemberRole, id: Id | null, rotation?: number) {
  const cur = st().project.settings.roleProfiles?.[role];
  if (!id) {
    if (!cur?.assembly) return;
    const { assembly: _a, ...rest } = cur;
    return void setRoleProfileUi(role, rest);
  }
  const asm = (st().project.library.profileAssemblies ?? []).find((a) => a.id === id);
  if (!asm) return;
  const main = asm.components.find((c) => c.key === asm.main);
  const rp: RoleProfile = { profile: main?.profile ?? cur?.profile ?? '', assembly: id, alignMode: 'insertion' };
  if (rotation !== undefined) rp.rotation = rotation;
  else if (cur?.rotation !== undefined) rp.rotation = cur.rotation;
  void setRoleProfileUi(role, rp);
  notify(`${ROLE_LABEL[role]}s carry ${asm.name}.`);
}

export function setComponentUi(id: Id, key: string, patch: Partial<Omit<ProfileAssemblyComponent, 'key' | 'profile'>>) {
  run('Component options', (d) => void setComponentOptions(d, id, key, patch));
}

export function setMainComponentUi(id: Id, key: string) {
  run('Main component', (d) => setProfileAssemblyMain(d, id, key));
}

export function updateAssemblyUi(id: Id, patch: Parameters<typeof updateProfileAssembly>[2]) {
  run('Profile assembly', (d) => updateProfileAssembly(d, id, patch));
}

export async function removeAssemblyUi(id: Id) {
  const p = st().project;
  const asm = (p.library.profileAssemblies ?? []).find((a) => a.id === id);
  if (!asm) return;
  const used = Object.values(p.members).filter((m) => m.profileAssembly === id).length;
  if (!(await askConfirm(`Remove the profile assembly "${asm.name}"?${used ? ` ${used} member${used === 1 ? '' : 's'} keep only its main profile.` : ''} Its component profiles that nothing else uses are removed too.`, { title: 'Profile assemblies', ok: 'Remove' }))) return;
  run(`Remove ${asm.name}`, (d) => void removeProfileAssembly(d, id, { profiles: true }));
}
