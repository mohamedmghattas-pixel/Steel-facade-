/**
 * "Profiles by role": one profile per member role (mullions, transoms …) with
 * rotation, alignment mode and material, member counts and apply buttons.
 */
import { useState } from 'react';
import { MEMBER_ROLES, type AlignMode, type MemberRole, type RoleProfile } from '../core/model/types';
import { ROLE_LABEL } from '../core/model/ops';
import { MATERIALS } from '../core/library/materials';
import { getProfile } from '../core/library/profiles';
import { membersOffRoleProfile, roleCounts } from '../core/model/roleProfiles';
import { useStore } from '../state/store';
import { NumberInput, ProfilePicker, Select } from './widgets';
import { SectionPreview } from './SectionPreview';
import { applyRoleProfile, setRoleProfileUi } from './profileActions';
import { setRoleAssemblyUi } from './profileAssemblyActions';
import { AssemblyPreview } from './AssemblyPreview';
import './profiles.css';

const DEFAULT_ROLES: MemberRole[] = ['mullion', 'transom'];

export function RoleProfilesPanel() {
  const project = useStore((s) => s.project);
  const selCount = useStore((s) => s.selection.members.length);
  const rps = project.settings.roleProfiles ?? {};
  const counts = roleCounts(project);
  const [extra, setExtra] = useState<MemberRole[]>([]);
  const shown = MEMBER_ROLES.filter((r) => DEFAULT_ROLES.includes(r) || rps[r] || extra.includes(r) || counts[r].members + counts[r].lines > 0);
  const addable = MEMBER_ROLES.filter((r) => !shown.includes(r));
  // Profile assemblies: one option per assembly and drawn orientation ("<id>|<rotation>").
  const assemblies = project.library.profileAssemblies ?? [];
  const asmOf = (rp?: RoleProfile) => (rp?.assembly ? assemblies.find((a) => a.id === rp.assembly) : undefined);
  const asmOptions = assemblies.flatMap((a) =>
    a.orientations?.length
      ? a.orientations.map((o) => ({ value: `${a.id}|${o.rotation}`, label: `${a.name} · ${o.name} (${o.rotation}°)` }))
      : [{ value: `${a.id}|`, label: `${a.name} (composite)` }],
  );
  const asmValue = (rp?: RoleProfile) => {
    const a = asmOf(rp);
    if (!a) return '';
    const hit = a.orientations?.find((o) => o.rotation === (rp?.rotation ?? 0));
    return a.orientations?.length ? `${a.id}|${(hit ?? a.orientations[0]).rotation}` : `${a.id}|`;
  };
  const update = (role: MemberRole, patch: Partial<RoleProfile>) => {
    const cur = rps[role];
    if (!cur) return;
    void setRoleProfileUi(role, { ...cur, ...patch });
  };
  return (
    <section className="role-profiles">
      <h4>Profiles by role</h4>
      <p className="muted">Mullions, transoms and the other roles each get their own profile. New members of a role get it; Apply updates existing ones.</p>
      {shown.map((role) => {
        const rp = rps[role];
        const c = counts[role];
        const prof = rp ? getProfile(rp.profile) : undefined;
        const off = rp ? membersOffRoleProfile(project, role).length : 0;
        const label = ROLE_LABEL[role].toLowerCase();
        return (
          <div className="rp-row" key={role} data-role={role}>
            {asmOf(rp) ? (
              <AssemblyPreview asm={asmOf(rp)!} size={56} rotation={rp?.rotation ?? 0} />
            ) : (
              <SectionPreview profile={prof ?? null} size={56} mode={rp?.alignMode ?? (prof?.insertion ? 'insertion' : 'grid')} title={`${ROLE_LABEL[role]} section`} />
            )}
            <div className="rp-main">
              <div className="rp-head">
                <strong>{ROLE_LABEL[role]}</strong>
                <span className="muted">
                  {c.members} member{c.members === 1 ? '' : 's'}
                  {c.lines ? ` + ${c.lines} line${c.lines === 1 ? '' : 's'}` : ''}
                  {rp && off ? ` · ${off} differ` : ''}
                </span>
              </div>
              <div className="rp-pick">
                <ProfilePicker value={rp?.profile ?? null} onChange={(v) => v && void setRoleProfileUi(role, { ...(rp ?? {}), profile: v, assembly: undefined })} />
                {rp && (
                  <button className="icon-btn" title={`No ${label} profile (members keep theirs)`} onClick={() => void setRoleProfileUi(role, null)}>
                    ×
                  </button>
                )}
              </div>
              {assemblies.length > 0 && (
                <div className="rp-asm" title="A profile assembly (composite section): the role's members carry every component from its base point">
                  <Select<string>
                    value={asmValue(rp)}
                    options={[{ value: '', label: 'Single profile (no assembly)' }, ...asmOptions]}
                    onChange={(v) => {
                      const [id, rot] = v.split('|');
                      setRoleAssemblyUi(role, id || null, rot === '' || rot === undefined ? undefined : Number(rot));
                    }}
                  />
                </div>
              )}
              {rp && (
                <div className="rp-opts">
                  <label title="Section rotation about the member axis (empty: members keep theirs)">
                    Rot.
                    <NumberInput value={rp.rotation} unit="°" onChange={(v) => update(role, { rotation: v })} />
                  </label>
                  <Select<string>
                    value={rp.alignMode ?? ''}
                    options={[
                      { value: '', label: 'Position: keep' },
                      { value: 'insertion', label: 'Insertion point' },
                      { value: 'grid', label: '3×3 grid' },
                    ]}
                    onChange={(v) => update(role, { alignMode: (v || undefined) as AlignMode | undefined })}
                  />
                  <Select<string>
                    value={rp.material ?? ''}
                    options={[{ value: '', label: prof?.material ? `Material: ${prof.material}` : 'Material: keep' }, ...MATERIALS.map((m) => ({ value: m.name, label: m.name }))]}
                    onChange={(v) => update(role, { material: v || undefined })}
                  />
                </div>
              )}
              {rp && (
                <div className="btn-row">
                  <button className="secondary-btn" disabled={!c.members && !c.lines} onClick={() => applyRoleProfile(role, 'all')}>
                    Apply to all {label}s
                  </button>
                  <button className="secondary-btn" disabled={!selCount} onClick={() => applyRoleProfile(role, 'selection')}>
                    Apply to selection
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {addable.length > 0 && (
        <Select<string>
          value=""
          options={[{ value: '', label: '+ Add a role…' }, ...addable.map((r) => ({ value: r, label: ROLE_LABEL[r] }))]}
          onChange={(v) => v && setExtra([...extra, v as MemberRole])}
        />
      )}
    </section>
  );
}
