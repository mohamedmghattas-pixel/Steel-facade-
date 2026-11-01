/**
 * Profiles by member role ("mullions are a different profile than transoms"):
 * `ProjectSettings.roleProfiles` maps a role to a profile with an optional
 * rotation, alignment mode and material. New members drawn or generated with a
 * role get its profile; `assignProfilesByRole` updates existing members (used
 * by the "Profiles by role" panel, the assistant and features that classify
 * wire lines into mullions / transoms).
 */
import type { Id, Member, MemberRole, Project, RoleProfile } from './types';
import { MEMBER_ROLES } from './types';
import { getProfile } from '../library/profiles';
import { findMaterial } from '../library/materials';

/** The role profile of a role, when one is set and its profile exists in the catalogue. */
export function roleProfile(p: Project, role: MemberRole): RoleProfile | undefined {
  const rp = p.settings.roleProfiles?.[role];
  return rp && getProfile(rp.profile) ? rp : undefined;
}

/**
 * Member fields a role profile sets: the profile, plus rotation / alignment
 * mode when given, and the material (the role's, else the profile's own).
 */
export function roleProfilePatch(rp: RoleProfile): Partial<Member> {
  const prof = getProfile(rp.profile);
  const patch: Partial<Member> = { profile: prof?.name ?? rp.profile };
  if (rp.rotation !== undefined && Number.isFinite(rp.rotation)) patch.rotation = rp.rotation;
  if (rp.alignMode) patch.alignMode = rp.alignMode;
  const mat = findMaterial(rp.material ?? prof?.material);
  if (mat) patch.material = mat.name;
  return patch;
}

/** Member fields for a new member of `role` (empty when the role has no profile). */
export function newMemberPatch(p: Project, role: MemberRole): Partial<Member> {
  const rp = roleProfile(p, role);
  return rp ? roleProfilePatch(rp) : {};
}

/**
 * Give members the profile of their role. `memberIds` limits it to those
 * members (default: every member, construction lines included, so lines
 * classified as mullions / transoms become steel). Members whose role has no
 * profile are left alone. Returns how many members changed.
 */
export function assignProfilesByRole(p: Project, memberIds?: Iterable<Id>, roles?: readonly MemberRole[]): number {
  let changed = 0;
  const ids = memberIds ? [...memberIds] : Object.keys(p.members);
  const patches = new Map<MemberRole, Partial<Member>>();
  for (const role of roles ?? MEMBER_ROLES) {
    const rp = roleProfile(p, role);
    if (rp) patches.set(role, roleProfilePatch(rp));
  }
  for (const id of ids) {
    const m = p.members[id];
    if (!m) continue;
    const patch = patches.get(m.role);
    if (!patch) continue;
    const before = JSON.stringify([m.profile, m.rotation, m.alignMode, m.material]);
    Object.assign(m, patch);
    if (JSON.stringify([m.profile, m.rotation, m.alignMode, m.material]) !== before) changed++;
  }
  return changed;
}

/** Set (or clear with null) the profile of a role. Throws on an unknown profile or material. */
export function setRoleProfile(p: Project, role: MemberRole, rp: RoleProfile | null): void {
  p.settings.roleProfiles ??= {};
  if (!rp) {
    delete p.settings.roleProfiles[role];
    return;
  }
  const prof = getProfile(rp.profile);
  if (!prof) throw new Error(`Unknown profile "${rp.profile}"`);
  if (rp.material !== undefined && !findMaterial(rp.material)) throw new Error(`Unknown material "${rp.material}"`);
  const out: RoleProfile = { profile: prof.name };
  if (rp.rotation !== undefined) out.rotation = rp.rotation;
  if (rp.alignMode) out.alignMode = rp.alignMode;
  if (rp.material) out.material = findMaterial(rp.material)!.name;
  p.settings.roleProfiles[role] = out;
}

/**
 * Change the role of members; with `applyProfile` (default) they also get the
 * new role's profile when it has one.
 */
export function setMemberRole(p: Project, ids: Iterable<Id>, role: MemberRole, applyProfile = true): number {
  const list = [...ids].filter((id) => p.members[id]);
  for (const id of list) p.members[id].role = role;
  if (applyProfile) assignProfilesByRole(p, list, [role]);
  return list.length;
}

/** Number of members (with a profile) and wire lines (without) per role. */
export function roleCounts(p: Project): Record<MemberRole, { members: number; lines: number; profiles: Record<string, number> }> {
  const out = Object.fromEntries(MEMBER_ROLES.map((r) => [r, { members: 0, lines: 0, profiles: {} as Record<string, number> }])) as Record<
    MemberRole,
    { members: number; lines: number; profiles: Record<string, number> }
  >;
  for (const m of Object.values(p.members)) {
    const c = out[m.role] ?? out.other;
    if (m.profile) {
      c.members++;
      c.profiles[m.profile] = (c.profiles[m.profile] ?? 0) + 1;
    } else c.lines++;
  }
  return out;
}

/** Members of a role whose profile, rotation, alignment or material differs from the role profile. */
export function membersOffRoleProfile(p: Project, role: MemberRole): Id[] {
  const rp = roleProfile(p, role);
  if (!rp) return [];
  const patch = roleProfilePatch(rp);
  return Object.values(p.members)
    .filter((m) => m.role === role && (Object.keys(patch) as (keyof Member)[]).some((k) => m[k] !== patch[k]))
    .map((m) => m.id);
}
