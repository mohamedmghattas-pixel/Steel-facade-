/**
 * Library → Profile assemblies (composite sections): the project's assemblies
 * with a composite preview, upload from DXF, assign to the selection, edit the
 * name / prefix / main component and each component's options, remove.
 */
import { useState } from 'react';
import type { ProfileAssembly, ProfileComponentKind } from '../core/model/types';
import { COMPONENT_KINDS, KIND_LABEL, assemblyBox, assemblyMassPerMetre, lengthRuleLabel, validateProfileAssembly } from '../core/library/profileAssembly';
import { useStore } from '../state/store';
import { Select } from './widgets';
import { AssemblyPreview, ProfileContextPreview } from './AssemblyPreview';
import { MATERIAL_OPTIONS, RuleEditor } from './ProfileAssemblyDialog';
import { assignAssemblyToSelection, openAssemblyImport, removeAssemblyUi, setComponentUi, setMainComponentUi, updateAssemblyUi } from './profileAssemblyActions';
import './profileAssemblies.css';

export function ProfileAssembliesPanel() {
  const list = useStore((s) => s.project.library.profileAssemblies) ?? [];
  const members = useStore((s) => s.project.members);
  const selCount = useStore((s) => s.selection.members.length);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="asm-lib">
      <h4>Profile assemblies (composite sections)</h4>
      <p className="muted">
        Several profiles on one base point — a mullion with its steel box, aluminium extrusions, gaskets and packers — modelled together on a wire line, fabricated as one assembly, drawn as an assembly with single-part drawings.
      </p>
      <div className="btn-row">
        <button className="secondary-btn" onClick={() => void openAssemblyImport()}>
          Import assembly detail (DXF)…
        </button>
      </div>
      {list.map((a) => {
        const used = Object.values(members).filter((m) => m.profileAssembly === a.id).length;
        const kgm = assemblyMassPerMetre(a);
        const b = assemblyBox(a);
        const problems = validateProfileAssembly(a);
        return (
          <div key={a.id} className={`asm-item ${open === a.id ? 'open' : ''}`} data-assembly={a.name}>
            <div className="asm-row">
              <AssemblyPreview asm={a} size={56} />
              <div className="asm-main">
                <button className="link-btn asm-title" onClick={() => setOpen(open === a.id ? null : a.id)} title="Show the components and their options">
                  {a.name}
                </button>
                <span className="muted">
                  {a.components.length} components · {(b.maxX - b.minX).toFixed(0)} × {(b.maxY - b.minY).toFixed(0)} mm · {kgm.fabricated.toFixed(1)} kg/m fabricated · {used} member{used === 1 ? '' : 's'}
                  {a.prefix ? ` · prefix ${a.prefix}` : ''}
                </span>
                {problems.map((p, i) => (
                  <span key={i} className="warning asm-small">
                    {p}
                  </span>
                ))}
              </div>
              <div className="asm-actions">
                <button className="link-btn" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  {open === a.id ? 'Hide components' : 'Components…'}
                </button>
                <button className="secondary-btn" disabled={!selCount} title="The selected members carry this composite section" onClick={() => assignAssemblyToSelection(a.id)}>
                  Assign to {selCount || ''} selected
                </button>
                <button className="icon-btn" title={`Remove ${a.name}`} onClick={() => void removeAssemblyUi(a.id)}>
                  ×
                </button>
              </div>
            </div>
            {open === a.id && <AssemblyEditor a={a} />}
          </div>
        );
      })}
    </section>
  );
}

function AssemblyEditor({ a }: { a: ProfileAssembly }) {
  return (
    <div className="asm-edit">
      <div className="row3">
        <label className="field">
          <span className="field-label">Name</span>
          <input defaultValue={a.name} onBlur={(e) => e.target.value.trim() && e.target.value !== a.name && updateAssemblyUi(a.id, { name: e.target.value.trim() })} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <label className="field">
          <span className="field-label">Mark prefix</span>
          <input defaultValue={a.prefix ?? ''} maxLength={8} onBlur={(e) => e.target.value !== (a.prefix ?? '') && updateAssemblyUi(a.id, { prefix: e.target.value.trim() })} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <label className="field">
          <span className="field-label">Base point</span>
          <input defaultValue={a.basePoint ?? ''} onBlur={(e) => e.target.value !== (a.basePoint ?? '') && updateAssemblyUi(a.id, { basePoint: e.target.value.trim() || undefined })} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </div>
      {a.orientations?.length ? <p className="muted asm-small">Orientations: {a.orientations.map((o) => `${o.name} ${o.rotation}°${o.mirror ? ' mirrored' : ''}`).join(' · ')}</p> : null}
      <div className="asm-comps">
        <table>
          <thead>
            <tr>
              <th aria-label="Position in the assembly" />
              <th>Component</th>
              <th>Material</th>
              <th>Kind</th>
              <th title="Fabricated part (NC, drawings); off: listed only">Fab.</th>
              <th>Length rule</th>
              <th>Main</th>
            </tr>
          </thead>
          <tbody>
            {a.components.map((c) => (
              <tr key={c.key}>
                <td className="asm-comp-pos">
                  <ProfileContextPreview name={c.profile} size={44} />
                </td>
                <td title={c.profile}>{c.name}</td>
                <td>
                  <Select value={c.material} options={MATERIAL_OPTIONS.some((m) => m.value === c.material) ? MATERIAL_OPTIONS : [{ value: c.material, label: c.material }, ...MATERIAL_OPTIONS]} onChange={(v) => setComponentUi(a.id, c.key, { material: v })} />
                </td>
                <td>
                  <Select<ProfileComponentKind> value={c.kind} options={COMPONENT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} onChange={(v) => setComponentUi(a.id, c.key, { kind: v })} />
                </td>
                <td>
                  <input type="checkbox" checked={c.fabricate} disabled={c.key === a.main} onChange={(e) => setComponentUi(a.id, c.key, { fabricate: e.target.checked })} aria-label={`Fabricate ${c.name}`} />
                </td>
                <td title={lengthRuleLabel(c.lengthRule)}>
                  <RuleEditor rule={c.lengthRule} disabled={c.key === a.main} onChange={(rule) => setComponentUi(a.id, c.key, { lengthRule: rule })} />
                </td>
                <td>
                  <input type="radio" name={`main-${a.id}`} checked={c.key === a.main} onChange={() => setMainComponentUi(a.id, c.key)} aria-label={`Main component ${c.name}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
