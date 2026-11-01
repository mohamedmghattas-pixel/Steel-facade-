import { useMemo, useState } from 'react';
import { derived, useStore } from '../state/store';
import { Icon } from './icons';
import { Field, NumberInput, ProfilePicker, Segmented, Select, TextInput, kg, mm } from './widgets';
import { MEMBER_ROLES, type Align, type AlignMode, type Finish, type Member, type MemberRole } from '../core/model/types';
import { ROLE_LABEL, updateMembers, newId } from '../core/model/ops';
import { setMemberRole } from '../core/model/roleProfiles';
import { alignModeOf } from '../core/model/geometry';
import { MATERIALS } from '../core/library/materials';
import { BOLT_SIZES } from '../core/library/bolts';
import { PROFILES, getProfile, profileFamilies, profileMassIn, type ProfileDef, type Standard } from '../core/library/profiles';
import { CONNECTIONS, paramSpecs, resolveParams } from '../core/connections/registry';
import { templateFor } from '../core/connections/custom';
import { dist } from '../core/model/geometry';
import { assignActiveProfile, removeReference } from './actions';
import { SectionPreview } from './SectionPreview';
import { RoleProfilesPanel } from './RoleProfilesPanel';
import { deleteCustomProfile, exportProfileDxf, exportProfilesCsv, exportProfilesJson, openProfileImport, openSketcher } from './profileActions';
import { AssistantPanel } from './AssistantPanel';
import { ConnectionPreviewView, openConnectionLibrary } from './ConnectionLibrary';
import { askConfirm } from './askState';
import { ConnectionMovementInfo, MovementSettingsSection } from './dialogs/MovementDialogs';
import { EndPrepSection, PlateProps } from './dialogs/ModellingDialogs';
import { GroupingProps } from './dialogs/ManagementDialogs';
import { ModifyOpsSection } from './ModifyPanels';
import { changeProfile } from '../core/model/modify';

export function SidePanel() {
  const panel = useStore((s) => s.sidePanel);
  const set = useStore((s) => s.set);
  return (
    <aside className="side">
      <div className="tabs" role="tablist">
        {(['assistant', 'properties', 'library', 'model'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={panel === t} className={panel === t ? 'on' : ''} onClick={() => set({ sidePanel: t })}>
            {t === 'assistant' ? 'Assistant' : t === 'properties' ? 'Properties' : t === 'library' ? 'Library' : 'Model'}
          </button>
        ))}
      </div>
      <div className={`side-body ${panel === 'assistant' ? 'flush' : ''}`}>
        {panel === 'assistant' && <AssistantPanel />}
        {panel === 'properties' && <PropertiesPanel />}
        {panel === 'library' && <LibraryPanel />}
        {panel === 'model' && <ModelPanel />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

function common<T>(items: T[], get: (t: T) => unknown): { value: unknown; mixed: boolean } {
  if (!items.length) return { value: undefined, mixed: false };
  const first = get(items[0]);
  return { value: first, mixed: items.some((i) => get(i) !== first) };
}

const FINISHES: { value: Finish; label: string }[] = [
  { value: 'none', label: 'Black steel' },
  { value: 'hdg', label: 'Hot-dip galvanised' },
  { value: 'paint', label: 'Painted' },
  { value: 'hdg+paint', label: 'Galvanised + painted (duplex)' },
];

function PropertiesPanel() {
  const sel = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  if (sel.members.length) return <MemberProps ids={sel.members} />;
  if (sel.connections.length) return <ConnectionProps id={sel.connections[0]} count={sel.connections.length} />;
  if (sel.plates?.length) return <PlateProps ids={sel.plates} />;
  if (sel.nodes.length) {
    const n = project.nodes[sel.nodes[0]];
    return (
      <section className="props">
        <h3>Node</h3>
        {n && <p className="mono">{`X ${n.p.x.toFixed(1)}  Y ${n.p.y.toFixed(1)}  Z ${n.p.z.toFixed(1)}`}</p>}
        <p className="muted">Tip: select a member and this node, then add a Base plate or Slab bracket from the Connections menu.</p>
      </section>
    );
  }
  return <ProjectProps />;
}

function MemberProps({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const ms = ids.map((id) => project.members[id]).filter(Boolean) as Member[];
  const dm = derived(project);
  const patch = (label: string, p: Partial<Member>) => apply(label, (d) => updateMembers(d, ids, p));
  const c = (f: (m: Member) => unknown) => common(ms, f);
  const profile = c((m) => m.profile);
  const length = ms.reduce((s, m) => s + dist(project.nodes[m.start].p, project.nodes[m.end].p), 0);
  const parts = ms.map((m) => dm.partByRef.get(`m:${m.id}`)).filter(Boolean);
  const mass = parts.reduce((s, pt) => s + (pt?.mass ?? 0), 0);
  const marks = [...new Set(parts.map((pt) => pt!.assembly))];

  return (
    <section className="props">
      <h3>
        {ms.length === 1 ? (ms[0].profile ? 'Member' : 'Wireframe line') : `${ms.length} lines selected`}
        {marks.length > 0 && marks.length <= 3 && <span className="badge">{marks.join(', ')}</span>}
      </h3>
      <div className="stats">
        <span>{mm(length)} wire length</span>
        {mass > 0 && <span>{kg(mass)}</span>}
      </div>
      <Field label="Profile">
        <ProfilePicker
          allowNone
          value={profile.value as string | null}
          mixed={profile.mixed}
          onChange={(v) => {
            // The wire line keeps its place on the section (modify.changeProfile); the profile's material comes along.
            let warn = '';
            apply('Profile', (d) => {
              warn = changeProfile(d, ids, v).warnings[0] ?? '';
            });
            if (warn) useStore.getState().notify(warn);
          }}
        />
      </Field>
      <div className="row2">
        <Field label="Role">
          <Select<MemberRole>
            value={c((m) => m.role).value as MemberRole}
            mixed={c((m) => m.role).mixed}
            options={MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            onChange={(v) => {
              apply('Role', (d) => void setMemberRole(d, ids, v));
              const rp = project.settings.roleProfiles?.[v];
              if (rp) useStore.getState().notify(`${ROLE_LABEL[v]} profile ${rp.profile} applied (Library → Profiles by role).`);
            }}
          />
        </Field>
        <Field label="Material">
          <Select
            value={c((m) => m.material).value as string}
            mixed={c((m) => m.material).mixed}
            options={MATERIALS.map((m) => m.name)}
            onChange={(v) => patch('Material', { material: v })}
          />
        </Field>
      </div>
      <Field label="Finish">
        <Select<Finish> value={c((m) => m.finish).value as Finish} mixed={c((m) => m.finish).mixed} options={FINISHES} onChange={(v) => patch('Finish', { finish: v })} />
      </Field>
      <h4>Position on the wire line</h4>
      <WirePosition ms={ms} ids={ids} />
      <div className="row2">
        <Field label="Rotation">
          <NumberInput value={c((m) => m.rotation).value as number} mixed={c((m) => m.rotation).mixed} unit="°" onChange={(v) => patch('Rotation', { rotation: v })} />
        </Field>
        <Field label="Quick rotate">
          <Segmented<number>
            value={c((m) => m.rotation).mixed ? undefined : (c((m) => m.rotation).value as number)}
            options={[0, 90, 180, 270].map((r) => ({ value: r, label: `${r}°` }))}
            onChange={(v) => patch('Rotation', { rotation: v })}
          />
        </Field>
      </div>
      <label className="check-row" title="Mirror the section about the wire line's local z: channels, angles, Z and custom outlines open the other way">
        <input
          type="checkbox"
          checked={ms.every((m) => !!m.mirrorSection)}
          ref={(el) => {
            if (el) el.indeterminate = c((m) => !!m.mirrorSection).mixed;
          }}
          onChange={(e) => apply('Mirror section', (d) => ids.forEach((id) => (e.target.checked ? (d.members[id].mirrorSection = true) : delete d.members[id].mirrorSection)))}
        />{' '}
        Mirrored section
      </label>
      <div className="row2">
        <Field label="Across (local y)">
          <Segmented<Align>
            value={c((m) => m.alignY).mixed ? undefined : (c((m) => m.alignY).value as Align)}
            options={[
              { value: -1, label: '◧', title: 'Line on the −y face' },
              { value: 0, label: '◫', title: 'Centred' },
              { value: 1, label: '◨', title: 'Line on the +y face' },
            ]}
            onChange={(v) => patch('Align', { alignY: v, alignMode: 'grid' })}
          />
        </Field>
        <Field label="Depth (local z)">
          <Segmented<Align>
            value={c((m) => m.alignZ).mixed ? undefined : (c((m) => m.alignZ).value as Align)}
            options={[
              { value: -1, label: '⬓', title: 'Line on the bottom (−z) face' },
              { value: 0, label: '◫', title: 'Centred' },
              { value: 1, label: '⬒', title: 'Line on the top (+z) face' },
            ]}
            onChange={(v) => patch('Align', { alignZ: v, alignMode: 'grid' })}
          />
        </Field>
      </div>
      <div className="row2">
        <Field label="Offset y">
          <NumberInput value={c((m) => m.offsetY).value as number} mixed={c((m) => m.offsetY).mixed} unit="mm" onChange={(v) => patch('Offset', { offsetY: v })} />
        </Field>
        <Field label="Offset z">
          <NumberInput value={c((m) => m.offsetZ).value as number} mixed={c((m) => m.offsetZ).mixed} unit="mm" onChange={(v) => patch('Offset', { offsetZ: v })} />
        </Field>
      </div>
      <div className="row2">
        <Field label="Extend start">
          <NumberInput value={c((m) => m.startExt).value as number} mixed={c((m) => m.startExt).mixed} unit="mm" onChange={(v) => patch('Extension', { startExt: v })} />
        </Field>
        <Field label="Extend end">
          <NumberInput value={c((m) => m.endExt).value as number} mixed={c((m) => m.endExt).mixed} unit="mm" onChange={(v) => patch('Extension', { endExt: v })} />
        </Field>
      </div>
      <EndPrepSection ids={ids} />
      <ModifyOpsSection ids={ids} />
      <button className="secondary-btn wide-btn" onClick={() => useStore.getState().set({ dialog: 'applyConnection' })}>
        <Icon name="bracket" size={15} /> Apply a connection to {ms.length === 1 ? 'this member' : `these ${ms.length} members`}…
      </button>
      <GroupingProps ids={ids} />
      {ms.length === 1 && (
        <Field label="Name / note">
          <TextInput value={ms[0].name ?? ''} onChange={(v) => patch('Name', { name: v || undefined })} placeholder={ms[0].layer ? `layer ${ms[0].layer}` : ''} />
        </Field>
      )}
    </section>
  );
}

/** Section preview with the 3×3 grid and the profile insertion point; switches the alignment mode. */
function WirePosition({ ms, ids }: { ms: Member[]; ids: string[] }) {
  const apply = useStore((s) => s.apply);
  const names = [...new Set(ms.map((m) => m.profile).filter(Boolean))] as string[];
  if (names.length !== 1) return null;
  const prof = getProfile(names[0]);
  if (!prof) return null;
  const modes = new Set(ms.map((m) => alignModeOf(m, prof)));
  const mode: AlignMode | undefined = modes.size === 1 ? [...modes][0] : undefined;
  const ay = new Set(ms.map((m) => m.alignY)).size === 1 ? ms[0].alignY : undefined;
  const az = new Set(ms.map((m) => m.alignZ)).size === 1 ? ms[0].alignZ : undefined;
  const set = (label: string, p: Partial<Member>) => apply(label, (d) => updateMembers(d, ids, p));
  return (
    <div className="wire-pos">
      <SectionPreview
        profile={prof}
        size={124}
        mirror={ms.every((m) => !!m.mirrorSection)}
        mode={mode}
        alignY={ay}
        alignZ={az}
        onGrid={(y, z) => set('Align', { alignMode: 'grid', alignY: y, alignZ: z })}
        onInsertion={prof.insertion ? () => set('Align', { alignMode: 'insertion' }) : undefined}
      />
      <div className="wire-pos-side">
        {prof.insertion ? (
          <Segmented<AlignMode>
            value={mode}
            options={[
              { value: 'insertion', label: 'Insertion point', title: "The wire line runs through the profile's insertion point" },
              { value: 'grid', label: '3×3 grid', title: 'The wire line on a face, an edge or the centre of the bounding box' },
            ]}
            onChange={(v) => set('Align', { alignMode: v })}
          />
        ) : (
          <span className="muted">No insertion point on this profile: the wire line sits on the 3×3 grid.</span>
        )}
        <span className="muted">Click a grid point{prof.insertion ? ' or the insertion point (cross)' : ''} to place the wire line. Offsets add on top.</span>
      </div>
    </div>
  );
}

function ConnectionProps({ id, count }: { id: string; count: number }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const selIds = useStore((s) => s.selection.connections);
  const set = useStore((s) => s.set);
  const c = project.connections[id];
  const [presetName, setPresetName] = useState('');
  const [showPreview, setShowPreview] = useState(true);
  if (!c) return null;
  const def = CONNECTIONS[c.type];
  const v = resolveParams(c, project);
  const specs = paramSpecs(c, project);
  // Edits apply to every selected connection of the same type (and template).
  const peers = selIds.map((x) => project.connections[x]).filter((x) => x && x.type === c.type && (c.type !== 'custom' || x.params.template === c.params.template));
  const dm = derived(project);
  const out = dm.connectionOut.get(c.id);
  const parts = dm.parts.filter((pt) => pt.connectionId === c.id);
  const warnings = dm.warnings.filter((w) => w.connectionId === c.id);
  const presets = project.library.presets.filter((pr) => pr.type === c.type);
  const setParam = (key: string, value: number | string | boolean) =>
    apply(`${def.label}: ${key}`, (p) => {
      for (const peer of peers) {
        const cc = p.connections[peer.id];
        if (cc) cc.params = { ...cc.params, [key]: value };
      }
    });
  const mixed = (key: string) => peers.some((x) => resolveParams(x, project)[key] !== v[key]);
  return (
    <section className="props">
      <h3>
        {c.type === 'custom' ? (templateFor(project, c.params.template)?.name ?? def.label) : def.label}
        {count > 1 && <span className="badge">{peers.length > 1 ? `editing ${peers.length}` : `+${count - 1} more`}</span>}
      </h3>
      <p className="muted">{def.description}</p>
      {warnings.map((w, i) => (
        <p key={i} className="warning">
          <Icon name="warn" size={14} /> {w.text}
        </p>
      ))}
      <div className="stats">
        <span>
          {parts.length} part{parts.length === 1 ? '' : 's'}
        </span>
        <span>{out?.bolts.reduce((s, b) => s + b.positions.length, 0) ?? 0} bolts/anchors</span>
        <span>{kg(parts.reduce((s, pt) => s + pt.mass, 0))}</span>
      </div>
      {showPreview && (
        <div className="sp-preview">
          <ConnectionPreviewView spec={{ type: c.type, params: c.params, on: 'connection', connectionId: c.id }} height={220} />
        </div>
      )}
      <div className="btn-row">
        <button className="link-btn" onClick={() => setShowPreview(!showPreview)}>
          {showPreview ? 'Hide 3D preview' : 'Show 3D preview'}
        </button>
        <button className="link-btn" onClick={() => openConnectionLibrary({ type: c.type, params: { ...c.params } })} title="Edit with the live preview in the connection library, then update this connection">
          Open in library…
        </button>
      </div>
      {specs.map((ps) => (
        <Field key={ps.key} label={ps.label}>
          {ps.kind === 'number' && <NumberInput value={v[ps.key] as number} mixed={mixed(ps.key)} unit={ps.unit} onChange={(n) => setParam(ps.key, n)} />}
          {ps.kind === 'select' && <Select value={v[ps.key] as string} mixed={mixed(ps.key)} options={ps.options ?? []} onChange={(x) => setParam(ps.key, x)} />}
          {ps.kind === 'text' && <TextInput value={String(v[ps.key])} onChange={(x) => setParam(ps.key, x)} />}
          {ps.kind === 'bolt' && <Select value={v[ps.key] as string} mixed={mixed(ps.key)} options={BOLT_SIZES.map((b) => b.name)} onChange={(x) => setParam(ps.key, x)} />}
          {ps.kind === 'profile' && (
            <ProfilePicker value={v[ps.key] as string} onChange={(x) => x && setParam(ps.key, x)} filter={(n) => getProfile(n)?.shape.type === 'L'} />
          )}
          {ps.kind === 'template' && (
            <Select value={String(v[ps.key])} options={project.library.templates.map((t) => ({ value: t.id, label: t.name }))} onChange={(x) => setParam(ps.key, x)} />
          )}
          {ps.kind === 'bool' && <input type="checkbox" checked={!!v[ps.key]} onChange={(e) => setParam(ps.key, e.target.checked)} />}
        </Field>
      ))}
      <ConnectionMovementInfo id={c.id} />
      <div className="btn-row">
        <button className="link-btn" onClick={() => apply('Reset connection', (p) => peers.forEach((x) => void (p.connections[x.id].params = c.type === 'custom' ? { template: c.params.template } : {})))}>
          Reset to defaults
        </button>
        {c.type === 'custom' && (
          <button className="link-btn" onClick={() => set({ dialog: 'customConnection' })}>
            Edit template…
          </button>
        )}
      </div>
      <h4>Presets</h4>
      {presets.map((pr) => (
        <div className="rule" key={pr.id}>
          <span>{pr.name}</span>
          <button
            className="secondary-btn"
            onClick={() =>
              apply(`Preset ${pr.name}`, (p) => {
                for (const peer of peers) p.connections[peer.id].params = { ...pr.params };
              })
            }
          >
            Apply
          </button>
          <button className="icon-btn" title="Delete preset" onClick={() => apply('Delete preset', (p) => void (p.library.presets = p.library.presets.filter((x) => x.id !== pr.id)))}>
            ×
          </button>
        </div>
      ))}
      <div className="row-inline">
        <TextInput value={presetName} placeholder="Preset name" onChange={setPresetName} />
        <button
          className="secondary-btn"
          disabled={!presetName.trim()}
          onClick={() => {
            apply('Save preset', (p) => void p.library.presets.push({ id: newId('pre'), name: presetName.trim(), type: c.type, params: { ...c.params } }));
            setPresetName('');
          }}
        >
          Save current
        </button>
      </div>
    </section>
  );
}

function ProjectProps() {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const s = project.settings;
  const dm = derived(project);
  const members = Object.values(project.members);
  const steel = dm.parts.reduce((a, pt) => a + pt.mass, 0);
  return (
    <section className="props">
      <h3>Project</h3>
      <div className="stats">
        <span>{members.length} lines</span>
        <span>{members.filter((m) => m.profile).length} members</span>
        <span>{Object.keys(project.connections).length} connections</span>
        <span>{kg(steel)}</span>
      </div>
      {!members.length && (
        <div className="empty-state">
          <p>Start by drawing a wireframe:</p>
          <ol>
            <li>
              Use <strong>Facade grid</strong> to generate mullions and transoms, or draw with <strong>Line</strong> (L) on the work plane.
            </li>
            <li>
              <strong>Import → DXF</strong> to bring in lines from shop or architectural drawings.
            </li>
            <li>
              <strong>Import → IFC</strong> to load the concrete or main steel model to snap to.
            </li>
          </ol>
          <p>
            Or <strong>File → Load sample facade</strong>.
          </p>
        </div>
      )}
      <div className="row2">
        <Field label="Project no.">
          <TextInput value={project.info.number} onChange={(v) => apply('Info', (p) => void (p.info.number = v))} />
        </Field>
        <Field label="Client">
          <TextInput value={project.info.client} onChange={(v) => apply('Info', (p) => void (p.info.client = v))} />
        </Field>
      </div>
      <Field label="Drawn by">
        <TextInput value={project.info.designer} onChange={(v) => apply('Info', (p) => void (p.info.designer = v))} />
      </Field>
      <h4>Defaults for new members</h4>
      <div className="row2">
        <Field label="Material">
          <Select value={s.defaultMaterial} options={MATERIALS.map((m) => m.name)} onChange={(v) => apply('Default material', (p) => void (p.settings.defaultMaterial = v))} />
        </Field>
        <Field label="Finish">
          <Select<Finish> value={s.defaultFinish} options={FINISHES} onChange={(v) => apply('Default finish', (p) => void (p.settings.defaultFinish = v))} />
        </Field>
      </div>
      <h4>Auto-assign rules</h4>
      <p className="muted">Applied by Members → Auto-assign. Layer rules win over role rules, role rules over direction rules.</p>
      {s.autoRules.map((r, i) => (
        <div className="rule" key={i}>
          <Select
            value={r.match}
            options={[
              { value: 'vertical', label: 'Vertical' },
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'inclined', label: 'Inclined' },
              { value: 'layer', label: 'DXF layer' },
              { value: 'role', label: 'Has role' },
            ]}
            onChange={(v) => apply('Rule', (p) => void (p.settings.autoRules[i].match = v as typeof r.match))}
          />
          {r.match === 'layer' && <TextInput value={r.layer ?? ''} placeholder="layer name" onChange={(v) => apply('Rule', (p) => void (p.settings.autoRules[i].layer = v))} />}
          {r.match === 'role' && (
            <Select<MemberRole>
              value={r.ofRole ?? 'other'}
              options={MEMBER_ROLES.map((x) => ({ value: x, label: ROLE_LABEL[x] }))}
              onChange={(v) => apply('Rule', (p) => void (p.settings.autoRules[i].ofRole = v))}
            />
          )}
          <ProfilePicker value={r.profile} onChange={(v) => v && apply('Rule', (p) => void (p.settings.autoRules[i].profile = v))} />
          <Select<MemberRole>
            value={r.role}
            options={MEMBER_ROLES.map((x) => ({ value: x, label: ROLE_LABEL[x] }))}
            onChange={(v) => apply('Rule', (p) => void (p.settings.autoRules[i].role = v))}
          />
          <button className="icon-btn" title="Remove rule" onClick={() => apply('Rule', (p) => void p.settings.autoRules.splice(i, 1))}>
            ×
          </button>
        </div>
      ))}
      <button
        className="link-btn"
        onClick={() => apply('Rule', (p) => void p.settings.autoRules.unshift({ match: 'layer', layer: 'MULLION', profile: 'SHS 100x100x5', role: 'mullion' }))}
      >
        + Add rule
      </button>
      <MovementSettingsSection />
      <h4>Cut optimisation</h4>
      <Field label="Stock bar lengths" hint="mm, comma separated">
        <TextInput
          value={s.stockLengths.join(', ')}
          onChange={(v) => {
            const list = v.split(/[,;\s]+/).map(Number).filter((n) => n > 0);
            if (list.length) apply('Stock lengths', (p) => void (p.settings.stockLengths = list));
          }}
        />
      </Field>
      <div className="row2">
        <Field label="Saw kerf">
          <NumberInput value={s.kerf} unit="mm" min={0} onChange={(v) => apply('Kerf', (p) => void (p.settings.kerf = v))} />
        </Field>
        <Field label="End trim">
          <NumberInput value={s.endTrim} unit="mm" min={0} onChange={(v) => apply('End trim', (p) => void (p.settings.endTrim = v))} />
        </Field>
      </div>
      <Field label="Plate sheets" hint="w x h, comma separated">
        <TextInput
          value={s.plateSheets.map((x) => `${x.w}x${x.h}`).join(', ')}
          onChange={(v) => {
            const list = v
              .split(/[,;]+/)
              .map((t) => t.trim().match(/^(\d+)\s*[x*]\s*(\d+)$/i))
              .filter(Boolean)
              .map((m) => ({ w: Number(m![1]), h: Number(m![2]) }));
            if (list.length) apply('Plate sheets', (p) => void (p.settings.plateSheets = list));
          }}
        />
      </Field>
      <h4>Assembly prefixes</h4>
      <div className="prefix-grid">
        {MEMBER_ROLES.map((r) => (
          <Field key={r} label={ROLE_LABEL[r]}>
            <TextInput value={s.assemblyPrefix[r]} onChange={(v) => apply('Prefix', (p) => void (p.settings.assemblyPrefix[r] = v || 'A'))} />
          </Field>
        ))}
        <Field label="Brackets">
          <TextInput value={s.bracketPrefix} onChange={(v) => apply('Prefix', (p) => void (p.settings.bracketPrefix = v || 'BK'))} />
        </Field>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ProfilePreview({ name }: { name: string }) {
  const p = getProfile(name);
  if (!p) return null;
  return (
    <div className="profile-preview">
      <SectionPreview profile={p} size={120} mode={p.insertion ? 'insertion' : 'grid'} title={`${name} cross-section`} />
      <dl>
        <dt>h × b</dt>
        <dd>
          {p.h.toFixed(1)} × {p.b.toFixed(1)} mm
        </dd>
        <dt>Mass</dt>
        <dd>
          {profileMassIn(p).toFixed(2)} kg/m{p.material ? ` ${p.material}` : ''}
        </dd>
        <dt>Area</dt>
        <dd>{(p.area / 100).toFixed(2)} cm²</dd>
        <dt>Iy / Iz</dt>
        <dd>
          {(p.Iy / 1e4).toFixed(1)} / {(p.Iz / 1e4).toFixed(1)} cm⁴
        </dd>
        <dt>Wy / Wz</dt>
        <dd>
          {(p.Wy / 1e3).toFixed(1)} / {(p.Wz / 1e3).toFixed(1)} cm³
        </dd>
        <dt>Surface</dt>
        <dd>{p.surface.toFixed(3)} m²/m</dd>
        {p.insertion && (
          <>
            <dt>Insertion</dt>
            <dd>
              {p.insertion.x.toFixed(1)}, {p.insertion.y.toFixed(1)} from centre
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

const STD_LABEL: Record<string, string> = { EN: 'EN (Europe)', BS: 'BS (UK)', AISC: 'AISC (US)', Custom: 'Custom' };

function LibraryPanel() {
  const active = useStore((s) => s.activeProfile);
  const role = useStore((s) => s.activeRole);
  const drawWith = useStore((s) => s.drawWithProfile);
  const set = useStore((s) => s.set);
  const selCount = useStore((s) => s.selection.members.length);
  const customCount = useStore((s) => s.project.library.profiles.length);
  const [std, setStd] = useState<Standard>('EN');
  const [family, setFamily] = useState<string>('SHS');
  const [q, setQ] = useState('');
  const standards = useMemo(() => [...new Set(PROFILES.map((p) => p.standard))], [customCount]);
  const families = useMemo(() => profileFamilies(std), [std]);
  const list = useMemo(() => {
    const k = q.toLowerCase().replace(/\s/g, '');
    return PROFILES.filter(
      (p) => p.standard === std && (k ? p.name.toLowerCase().replace(/\s/g, '').includes(k) : p.family === family),
    );
  }, [std, family, q, customCount]);
  return (
    <section className="library">
      <Segmented
        value={std}
        options={standards.map((x) => ({ value: x, label: STD_LABEL[x] ?? x }))}
        onChange={(v) => {
          setStd(v);
          setFamily(profileFamilies(v)[0]);
        }}
      />
      <input className="search" placeholder="Search profiles…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {!q && (
        <div className="chips">
          {families.map((f) => (
            <button key={f} className={`chip ${f === family ? 'on' : ''}`} onClick={() => setFamily(f)}>
              {f}
            </button>
          ))}
        </div>
      )}
      <div className="lib-list" role="listbox" aria-label="Profiles">
        {list.map((p) => (
          <button key={p.name} role="option" aria-selected={p.name === active} className={p.name === active ? 'on' : ''} onClick={() => set({ activeProfile: p.name })}>
            <span>{p.name}</span>
            <span className="muted">{profileMassIn(p).toFixed(1)} kg/m</span>
          </button>
        ))}
      </div>
      {active && <ProfilePreview name={active} />}
      <div className="row2">
        <Field label="Role for assign / draw">
          <Select<MemberRole>
            value={role}
            options={MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            onChange={(v) => {
              // A role with its own profile makes that the active profile (new members of the role get it).
              const rp = useStore.getState().project.settings.roleProfiles?.[v];
              set(rp && getProfile(rp.profile) ? { activeRole: v, activeProfile: rp.profile } : { activeRole: v });
            }}
          />
        </Field>
        <Field label="Draw new lines as">
          <Segmented
            value={drawWith ? 'profile' : 'wire'}
            options={[
              { value: 'wire', label: 'Wireframe' },
              { value: 'profile', label: 'Members' },
            ]}
            onChange={(v) => set({ drawWithProfile: v === 'profile' })}
          />
        </Field>
      </div>
      <button className="primary-btn wide" disabled={!selCount} onClick={assignActiveProfile}>
        Assign {active ?? ''} to {selCount} selected line{selCount === 1 ? '' : 's'}
      </button>
      <RoleProfilesPanel />
      <h4>Custom and imported profiles</h4>
      <p className="muted">
        {customCount} custom profile{customCount === 1 ? '' : 's'} in this project. Draw one with its insertion point, or upload DXF outlines (closed polylines, holes inside), JSON or a
        CSV catalogue <code>name,family,type,h,b,tw,tf,r,t,d,c,mass</code>.
      </p>
      <div className="btn-row">
        <button className="primary-btn" onClick={() => openSketcher()}>
          New custom profile…
        </button>
        <button className="secondary-btn" onClick={() => void openProfileImport()}>
          Import profiles (DXF / JSON / CSV)…
        </button>
      </div>
      <CustomProfileList />
      <div className="btn-row">
        <button className="secondary-btn" disabled={!customCount} onClick={exportProfilesJson}>
          Export JSON
        </button>
        <button className="secondary-btn" disabled={!customCount} onClick={exportProfilesCsv}>
          Export CSV
        </button>
        <button
          className="link-btn"
          disabled={!customCount}
          onClick={async () => (await askConfirm('Remove all custom profiles from this project?', { title: 'Custom profiles', ok: 'Remove' })) && useStore.getState().apply('Remove custom profiles', (p) => void (p.library.profiles = []))}
        >
          Remove all
        </button>
      </div>
    </section>
  );
}

/** The project's custom profiles with edit / export / remove. */
function CustomProfileList() {
  const defs = useStore((s) => s.project.library.profiles) as unknown as ProfileDef[];
  const set = useStore((s) => s.set);
  const active = useStore((s) => s.activeProfile);
  if (!defs.length) return null;
  return (
    <div className="custom-list">
      {defs.map((d) => {
        const p = getProfile(d.name);
        return (
          <div key={d.name} className={`custom-item ${active === d.name ? 'on' : ''}`}>
            <SectionPreview profile={p ?? null} size={40} mode={p?.insertion ? 'insertion' : 'grid'} />
            <button className="link-btn custom-name" onClick={() => set({ activeProfile: d.name })} title="Make it the active profile">
              {d.name}
              <span className="muted"> {p ? `${profileMassIn(p).toFixed(2)} kg/m` : 'invalid'}</span>
            </button>
            {d.shape?.type === 'POLY' && (
              <button className="link-btn" onClick={() => openSketcher(d.name)}>
                Edit
              </button>
            )}
            <button className="link-btn" onClick={() => exportProfileDxf(d)} title="Download as DXF">
              DXF
            </button>
            <button className="icon-btn" title={`Remove ${d.name}`} onClick={() => void deleteCustomProfile(d.name)}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModelPanel() {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const status = useStore((s) => s.refStatus);
  const set = useStore((s) => s.set);
  return (
    <section className="props">
      <h3>Levels</h3>
      {project.levels.map((l, i) => (
        <div className="rule" key={l.id}>
          <TextInput value={l.name} onChange={(v) => apply('Level', (p) => void (p.levels[i].name = v))} />
          <NumberInput value={l.z} unit="mm" onChange={(v) => apply('Level', (p) => void (p.levels[i].z = v))} />
          <button className="icon-btn" title="Remove" onClick={() => apply('Level', (p) => void p.levels.splice(i, 1))}>
            ×
          </button>
        </div>
      ))}
      <button
        className="link-btn"
        onClick={() => apply('Level', (p) => void p.levels.push({ id: newId('lv'), name: `L${String(p.levels.length).padStart(2, '0')}`, z: (p.levels.at(-1)?.z ?? 0) + 3500 }))}
      >
        + Add level
      </button>
      <h3>Grids</h3>
      {project.grids.map((g, i) => (
        <div className="rule rule4" key={g.id}>
          <TextInput value={g.name} onChange={(v) => apply('Grid', (p) => void (p.grids[i].name = v))} />
          <Select value={g.axis} options={[{ value: 'x', label: 'X =' }, { value: 'y', label: 'Y =' }]} onChange={(v) => apply('Grid', (p) => void (p.grids[i].axis = v as 'x' | 'y'))} />
          <NumberInput value={g.pos} unit="mm" onChange={(v) => apply('Grid', (p) => void (p.grids[i].pos = v))} />
          <button className="icon-btn" title="Remove" onClick={() => apply('Grid', (p) => void p.grids.splice(i, 1))}>
            ×
          </button>
        </div>
      ))}
      <button className="link-btn" onClick={() => apply('Grid', (p) => void p.grids.push({ id: newId('g'), name: String(p.grids.length + 1), axis: 'x', pos: (p.grids.at(-1)?.pos ?? -1500) + 1500 }))}>
        + Add grid
      </button>

      <h3>Reference models</h3>
      {!project.references.length && <p className="muted">Import → IFC reference model to show the concrete or main steel and snap to it.</p>}
      {project.references.map((r, i) => (
        <div className="ref-item" key={r.id}>
          <div className="ref-head">
            <input type="checkbox" checked={r.visible} onChange={(e) => apply('Reference', (p) => void (p.references[i].visible = e.target.checked))} aria-label="Visible" />
            <strong>{r.name}</strong>
            <button className="icon-btn" title="Remove" onClick={() => removeReference(r.id)}>
              ×
            </button>
          </div>
          <span className="muted">{status[r.id] ?? ''}</span>
          <Field label="Opacity">
            <input type="range" min={0.05} max={1} step={0.05} value={r.opacity} onChange={(e) => apply('Reference', (p) => void (p.references[i].opacity = Number(e.target.value)))} />
          </Field>
          <div className="row3">
            {(['x', 'y', 'z'] as const).map((k) => (
              <Field key={k} label={`Shift ${k.toUpperCase()}`}>
                <NumberInput value={r.offset[k]} unit="mm" onChange={(v) => apply('Reference', (p) => void (p.references[i].offset[k] = v))} />
              </Field>
            ))}
          </div>
        </div>
      ))}

      <h3>Underlays</h3>
      {!project.underlays.length && <p className="muted">Import → PDF / image underlay to trace over shop drawings.</p>}
      {project.underlays.map((u, i) => (
        <div className="ref-item" key={u.id}>
          <div className="ref-head">
            <input type="checkbox" checked={u.visible} onChange={(e) => apply('Underlay', (p) => void (p.underlays[i].visible = e.target.checked))} aria-label="Visible" />
            <strong>{u.name}</strong>
            <button className="icon-btn" title="Remove" onClick={() => removeReference(u.id)}>
              ×
            </button>
          </div>
          <span className="muted">
            {status[u.id] ?? ''} · plane {u.plane.kind} @ {u.plane.offset}
          </span>
          <div className="row2">
            <Field label="Scale">
              <NumberInput value={u.mmPerPx} unit="mm/px" onChange={(v) => v > 0 && apply('Underlay', (p) => void (p.underlays[i].mmPerPx = v))} />
            </Field>
            <Field label="Rotation">
              <NumberInput value={u.rotation} unit="°" onChange={(v) => apply('Underlay', (p) => void (p.underlays[i].rotation = v))} />
            </Field>
          </div>
          <div className="row3">
            <Field label="Origin u">
              <NumberInput value={u.origin.x} unit="mm" onChange={(v) => apply('Underlay', (p) => void (p.underlays[i].origin.x = v))} />
            </Field>
            <Field label="Origin v">
              <NumberInput value={u.origin.y} unit="mm" onChange={(v) => apply('Underlay', (p) => void (p.underlays[i].origin.y = v))} />
            </Field>
            {u.kind === 'pdf' && (
              <Field label="Page">
                <NumberInput value={u.page} min={1} onChange={(v) => apply('Underlay', (p) => void (p.underlays[i].page = Math.round(v)))} />
              </Field>
            )}
          </div>
          <Field label="Opacity">
            <input type="range" min={0.05} max={1} step={0.05} value={u.opacity} onChange={(e) => apply('Underlay', (p) => void (p.underlays[i].opacity = Number(e.target.value)))} />
          </Field>
          <div className="btn-row">
            <button
              className="secondary-btn"
              onClick={() => {
                set({ calibrateTarget: u.id, tool: 'calibrate', workPlane: { ...u.plane } });
              }}
            >
              <Icon name="calibrate" size={15} /> Calibrate (2 points)
            </button>
            <button className="secondary-btn" onClick={() => set({ workPlane: { ...u.plane } })}>
              Use its plane
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
