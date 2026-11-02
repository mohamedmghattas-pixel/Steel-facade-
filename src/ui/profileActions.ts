/**
 * UI commands for custom profiles: upload (DXF / JSON / CSV with a review
 * step), the sketcher page, saving / renaming / deleting custom profiles and
 * profiles by role. Model edits go through store.apply (undoable); questions
 * use the in-app askConfirm.
 */
import type { Id, MemberRole, Project, RoleProfile } from '../core/model/types';
import { ROLE_LABEL } from '../core/model/ops';
import { getProfile, isCustomProfile, parseProfileCsv, parseProfileJson, profileDefsToCsv, profileDefsToJson, type ProfileDef } from '../core/library/profiles';
import { parseProfileDxf, profileToDxf } from '../core/library/profileDxf';
import { emptySketch, sketchFromDef } from '../core/library/sketch';
import { assignProfilesByRole, roleProfilePatch, setRoleProfile } from '../core/model/roleProfiles';
import { validateShape } from '../core/library/shapes';
import { useStore } from '../state/store';
import { download, pickFile, safeName } from '../state/storage';
import { askConfirm } from './askState';
import { useProfileUi, type ImportReview, type ReviewItem } from './profileUiState';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);
const customDefs = (p: Project = st().project) => p.library.profiles as unknown as ProfileDef[];

// ---------------------------------------------------------------------------
// Sketcher

/** Open the sketcher: a new profile, or an existing custom profile by name. */
export function openSketcher(name?: string) {
  const def = name ? customDefs().find((d) => d.name === name) : undefined;
  if (name && !def) return notify(`"${name}" is not a custom profile of this project.`, 'error');
  const sketch = def ? sketchFromDef(def) : emptySketch();
  if (def && !sketch) return notify(`${def.name} is a parametric ${def.shape.type} profile: edit it in a CSV / JSON file, or draw a new outline.`, 'error');
  useProfileUi.setState({
    sketcher: { editing: def?.name ?? null, sketch: sketch!, name: def?.name ?? '', family: def?.family ?? 'Custom outline', material: def?.material ?? '' },
  });
}

/** Open the sketcher on a definition that is not saved yet (e.g. from the import review). */
export function openSketcherWith(def: ProfileDef) {
  const sketch = sketchFromDef(def);
  if (!sketch) return notify('Only outline profiles can be opened in the sketcher.', 'error');
  useProfileUi.setState({ review: null, sketcher: { editing: null, sketch, name: def.name, family: def.family ?? 'Custom outline', material: def.material ?? '' } });
}

export function closeSketcher() {
  useProfileUi.setState({ sketcher: null });
}

/**
 * Save a definition into the project library. `original` is the name it was
 * opened as: saving under a new name renames the profile (members and role
 * profiles that use it follow). Asks before replacing another profile.
 */
export async function saveCustomProfile(def: ProfileDef, original: string | null): Promise<boolean> {
  const name = def.name.trim();
  if (!name) {
    notify('Give the profile a name.', 'error');
    return false;
  }
  const existing = getProfile(name);
  if (existing && !existing.custom && !isCustomProfile(name)) {
    notify(`"${name}" is a catalogue profile: choose another name.`, 'error');
    return false;
  }
  const taken = customDefs().some((d) => d.name === name) && name !== original;
  if (taken && !(await askConfirm(`A custom profile "${name}" already exists. Replace it?`, { title: 'Save profile', ok: 'Replace' }))) return false;
  const err = validateShape(def.shape);
  if (err) {
    notify(err, 'error');
    return false;
  }
  let users = 0;
  st().apply(original ? `Edit profile ${name}` : `New profile ${name}`, (p) => {
    const keep = p.library.profiles.filter((d) => String(d.name) !== name && (!original || String(d.name) !== original));
    p.library.profiles = [...keep, def as unknown as Record<string, unknown>];
    if (original && original !== name) {
      for (const m of Object.values(p.members)) {
        if (m.profile === original) {
          m.profile = name;
          users++;
        }
      }
      for (const rp of Object.values(p.settings.roleProfiles ?? {})) if (rp && rp.profile === original) rp.profile = name;
    }
  });
  const used = Object.values(st().project.members).filter((m) => m.profile === name).length;
  notify(
    `${original ? 'Updated' : 'Saved'} ${name}${users ? ` (renamed on ${users} member${users === 1 ? '' : 's'})` : used ? ` — ${used} member${used === 1 ? '' : 's'} use it` : ''}. Find it under Library → Custom.`,
  );
  return true;
}

export async function deleteCustomProfile(name: string) {
  const used = Object.values(st().project.members).filter((m) => m.profile === name).length;
  const roles = Object.entries(st().project.settings.roleProfiles ?? {}).filter(([, rp]) => rp?.profile === name);
  const extra = used ? ` ${used} member${used === 1 ? '' : 's'} use it and will have no section.` : '';
  if (!(await askConfirm(`Remove the custom profile "${name}"?${extra}${roles.length ? ' It is also cleared from Profiles by role.' : ''}`, { title: 'Custom profiles', ok: 'Remove' }))) return;
  st().apply(`Remove profile ${name}`, (p) => {
    p.library.profiles = p.library.profiles.filter((d) => String(d.name) !== name);
    for (const [r] of roles) delete p.settings.roleProfiles[r as MemberRole];
  });
}

// ---------------------------------------------------------------------------
// Upload with review

/** Review list for an uploaded file (DXF, JSON or CSV). */
export function reviewFromText(fileName: string, text: string, unitScale?: number): ImportReview {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const kind: ImportReview['kind'] = ext === 'dxf' || /^\s*0\s*[\r\n]+\s*SECTION/.test(text) ? 'dxf' : ext === 'json' || /^\s*[[{]/.test(text) ? 'json' : 'csv';
  if (kind === 'dxf') {
    const r = parseProfileDxf(text, { fileName, unitScale });
    const items: ReviewItem[] = r.profiles.map((f) => ({ def: f.def, include: !f.error, error: f.error, warnings: f.warnings, nameFrom: f.nameFrom, insertionFrom: f.insertionFrom }));
    return { fileName, kind, text, items, notes: r.notes, unitScale: r.unitScale, unitSource: r.unitSource };
  }
  const r = kind === 'json' ? parseProfileJson(text) : parseProfileCsv(text);
  return { fileName, kind, text, items: r.defs.map((def) => ({ def, include: true, warnings: [] })), notes: r.errors };
}

/** Library → "Import profiles (DXF / JSON / CSV)…": pick a file and open the review step. */
export async function openProfileImport() {
  const f = await pickFile('.dxf,.json,.csv,.txt');
  if (!f) return;
  try {
    const review = reviewFromText(f.name, await f.text());
    if (!review.items.length) return notify(`No profiles found in ${f.name}${review.notes.length ? `: ${review.notes[0]}` : '.'}`, 'error');
    useProfileUi.setState({ review });
  } catch (e) {
    notify(`Could not read ${f.name}: ${(e as Error).message}`, 'error');
  }
}

/** Add reviewed definitions (replacing custom profiles of the same name). */
export function addReviewed(defs: ProfileDef[]) {
  const builtIn = defs.filter((d) => getProfile(d.name) && !getProfile(d.name)!.custom);
  const ok = defs.filter((d) => !builtIn.includes(d));
  if (!ok.length) return notify(`Nothing added: ${builtIn.map((d) => d.name).join(', ')} ${builtIn.length === 1 ? 'is a catalogue name' : 'are catalogue names'}.`, 'error');
  st().apply(`Import ${ok.length} profile${ok.length === 1 ? '' : 's'}`, (p) => {
    const names = new Set(ok.map((d) => d.name));
    p.library.profiles = [...p.library.profiles.filter((d) => !names.has(String(d.name))), ...(ok as unknown as Record<string, unknown>[])];
  });
  useProfileUi.setState({ review: null });
  notify(`Added ${ok.length} profile${ok.length === 1 ? '' : 's'}${builtIn.length ? ` (${builtIn.length} skipped: catalogue names)` : ''}. Find them under Library → Custom.`);
}

// ---------------------------------------------------------------------------
// Export

const base = () => safeName(st().project.info.name);

export function exportProfilesJson() {
  download(`${base()}-profiles.json`, profileDefsToJson(customDefs()), 'application/json');
}

export function exportProfilesCsv() {
  const defs = customDefs();
  const poly = defs.filter((d) => d.shape.type === 'POLY').length;
  download(`${base()}-profiles.csv`, profileDefsToCsv(defs), 'text/csv');
  if (poly) notify(`${poly} outline profile${poly === 1 ? ' is' : 's are'} not in the CSV (use Export JSON).`);
}

export function exportProfileDxf(def: ProfileDef) {
  download(`${safeName(def.name)}.dxf`, profileToDxf(def), 'application/dxf');
}

export function exportProfileJsonOne(def: ProfileDef) {
  download(`${safeName(def.name)}.json`, profileDefsToJson([def]), 'application/json');
}

// ---------------------------------------------------------------------------
// Profiles by role

const plural = (role: MemberRole, n: number) => `${n} ${ROLE_LABEL[role].toLowerCase()}${n === 1 ? '' : 's'}`;

/**
 * Set (or clear) the profile of a role. When members of the role use other
 * settings, ask whether to update them all.
 */
export async function setRoleProfileUi(role: MemberRole, rp: RoleProfile | null) {
  const p = st().project;
  const members = Object.values(p.members).filter((m) => m.role === role);
  let apply = false;
  if (rp && members.length) {
    const patch = roleProfilePatch(rp);
    const differ = members.filter((m) => (Object.keys(patch) as (keyof typeof patch)[]).some((k) => m[k] !== patch[k]) || (!patch.profileAssembly && !!m.profileAssembly));
    const what = rp.assembly ? (p.library.profileAssemblies ?? []).find((a) => a.id === rp.assembly)?.name ?? rp.profile : rp.profile;
    if (differ.length) apply = await askConfirm(`Update all ${plural(role, members.length)} to ${what}? (${differ.length} change.) Choose Cancel to only use it for new ${ROLE_LABEL[role].toLowerCase()}s.`, { title: 'Profiles by role', ok: `Update all ${ROLE_LABEL[role].toLowerCase()}s` });
  }
  let n = 0;
  st().apply(`${ROLE_LABEL[role]} profile`, (d) => {
    setRoleProfile(d, role, rp);
    if (apply) n = assignProfilesByRole(d, undefined, [role]);
  });
  if (apply) notify(`Updated ${plural(role, n)}.`);
}

/** "Apply to all <role>s" / "Apply to selection". */
export function applyRoleProfile(role: MemberRole, scope: 'all' | 'selection') {
  const sel = st().selection.members;
  if (scope === 'selection' && !sel.length) return notify('Select members first.', 'error');
  if (!st().project.settings.roleProfiles?.[role]) return notify(`Choose a ${ROLE_LABEL[role].toLowerCase()} profile first.`, 'error');
  let n = 0;
  st().apply(`Apply ${ROLE_LABEL[role].toLowerCase()} profile`, (d) => {
    const ids: Id[] | undefined = scope === 'selection' ? sel : undefined;
    n = assignProfilesByRole(d, ids, [role]);
  });
  notify(n ? `Updated ${plural(role, n)}.` : scope === 'selection' ? `No selected ${ROLE_LABEL[role].toLowerCase()}s needed a change.` : `All ${ROLE_LABEL[role].toLowerCase()}s already use it.`);
}
