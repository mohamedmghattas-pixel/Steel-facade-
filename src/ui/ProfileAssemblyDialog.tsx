/**
 * Review step of an assembly-detail upload (composite sections from DXF): the
 * details found with their base points, per detail a preview, the components
 * (layer, material, kind, area, kg/m, fabricate, length rule, main part,
 * detail), the assembly name / prefix / base-point note, turning and mirroring
 * about the base point, and what to do with a turned copy of another detail.
 */
import { useMemo, useState } from 'react';
import type { ComponentLengthRule, ProfileComponentKind } from '../core/model/types';
import { MATERIALS } from '../core/library/materials';
import { flattenLoop } from '../core/library/polyShape';
import { COMPONENT_KINDS, KIND_LABEL, NON_METALS, defaultFabricate, defaultLengthRule } from '../core/library/profileAssembly';
import { defaultMain, orientPoint, outlineKgm, type ComponentChoice, type DetailChoice } from '../core/library/profileAssemblyDxf';
import { Field, Modal, Select } from './widgets';
import { LoopsPreview, type PreviewLoop } from './AssemblyPreview';
import { useProfileUi, type AsmDetailReview, type AssemblyReview } from './profileUiState';
import { assemblyReviewFromText, closeAssemblyReview, saveAssemblyReview } from './profileAssemblyActions';
import './profileAssemblies.css';

const UNITS: { value: string; label: string }[] = [
  { value: '1', label: 'millimetres' },
  { value: '10', label: 'centimetres' },
  { value: '1000', label: 'metres' },
  { value: '25.4', label: 'inches' },
];

export const MATERIAL_OPTIONS = [...MATERIALS.map((m) => ({ value: m.name, label: m.name })), ...NON_METALS.map((m) => ({ value: m.name, label: `${m.name} (listed)` }))];

const fromText = (b: string) => b.replace(/^point$/, 'POINT').replace(/^marker:/, 'marker block ').replace(/^circle:/, 'circle on ').replace(/^none: /, 'no marker — ');

export function ProfileAssemblyHost() {
  const r = useProfileUi((s) => s.assemblyReview);
  return r ? <ProfileAssemblyDialog r={r} /> : null;
}

function ProfileAssemblyDialog({ r }: { r: AssemblyReview }) {
  const [busy, setBusy] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const set = (patch: Partial<AssemblyReview>) => useProfileUi.setState({ assemblyReview: { ...r, ...patch } });
  const setDetail = (i: number, patch: Partial<AsmDetailReview>) => set({ details: r.details.map((d, k) => (k === i ? { ...d, ...patch } : d)) });
  const setChoice = (i: number, patch: Partial<DetailChoice>) => setDetail(i, { choice: { ...r.details[i].choice, ...patch } });
  const cur = Math.min(r.current, r.details.length - 1);
  const d = r.imp.details[cur];
  const dr = r.details[cur];
  const ch = dr.choice;
  const setComp = (outline: number, patch: Partial<ComponentChoice>) => {
    const comps = ch.components.map((c) => (c.outline === outline ? { ...c, ...patch } : c));
    const main = ch.main !== undefined && comps.some((c) => c.outline === ch.main && c.include) ? ch.main : defaultMain(r.imp, comps);
    setChoice(cur, { components: comps, main });
  };
  /** Move an outline to another detail (it is placed from that detail's base point). */
  const moveComp = (outline: number, to: number) => {
    const c = ch.components.find((x) => x.outline === outline)!;
    set({
      details: r.details.map((x, k) => {
        if (k === cur) {
          const comps = x.choice.components.filter((y) => y.outline !== outline);
          return { ...x, choice: { ...x.choice, components: comps, main: x.choice.main === outline ? defaultMain(r.imp, comps) : x.choice.main } };
        }
        if (k === to) return { ...x, choice: { ...x.choice, components: [...x.choice.components, c] } };
        return x;
      }),
    });
  };
  const reload = (opts: { unitScale?: number; markers?: string[] | null }) => set(assemblyReviewFromText(r.fileName, r.text, { unitScale: opts.unitScale ?? r.unitScale, markers: opts.markers === undefined ? r.markers : opts.markers }, r));

  const loops = useMemo((): PreviewLoop[] => {
    const rel = (q: { x: number; y: number }) => orientPoint({ x: q.x - d.base.x, y: q.y - d.base.y }, ch.rotation, ch.mirror);
    return ch.components.map((c) => {
      const o = r.imp.outlines[c.outline];
      return {
        key: String(c.outline),
        outer: flattenLoop(o.outer).map(rel),
        holes: o.holes.map((h) => flattenLoop(h).map(rel)),
        material: c.material,
        main: c.outline === ch.main,
        off: !c.include,
        hot: c.outline === hot,
        title: `${c.name} · ${o.layer} · ${c.material}`,
      };
    });
  }, [r.imp, d, ch, hot]);

  const saving = r.details.filter((x) => x.action === 'save');
  const comps = saving.reduce((s, x) => s + x.choice.components.filter((c) => c.include).length, 0);
  const markersUsed = new Set(r.imp.markerBlocks.filter((b) => b.used).map((b) => b.name));
  const rel = d.duplicateOf ?? d.similarTo;
  const totalKg = ch.components.filter((c) => c.include).reduce((s, c) => s + outlineKgm(r.imp.outlines[c.outline], c.material), 0);
  const mergeOk = !!rel && r.details[rel.detail]?.action === 'save';

  return (
    <Modal
      wide
      title={`Import assembly details — ${r.fileName}`}
      onClose={closeAssemblyReview}
      footer={
        <>
          <span className="muted">
            {r.imp.details.length} detail{r.imp.details.length === 1 ? '' : 's'} · {saving.length} assembl{saving.length === 1 ? 'y' : 'ies'} with {comps} component{comps === 1 ? '' : 's'} to save
          </span>
          <button
            className="primary-btn"
            disabled={!saving.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await saveAssemblyReview(r);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save {saving.length} profile assembl{saving.length === 1 ? 'y' : 'ies'}
          </button>
        </>
      }
    >
      <div className="asm-top">
        <Field label="Drawing units" hint={r.imp.unitSource === 'insunits' ? 'from $INSUNITS' : r.imp.unitSource === 'measurement' ? 'from $MEASUREMENT' : r.imp.unitSource === 'user' ? 'chosen' : 'not in the file: assumed'}>
          <Select value={String(r.imp.unitScale)} options={UNITS.some((u) => u.value === String(r.imp.unitScale)) ? UNITS : [...UNITS, { value: String(r.imp.unitScale), label: `${r.imp.unitScale} mm/unit` }]} onChange={(v) => reload({ unitScale: Number(v) })} />
        </Field>
        <div className="field">
          <span className="field-label">Base-point marker blocks</span>
          <div className="asm-markers">
            {r.imp.blocks.length ? (
              r.imp.blocks.map((b) => (
                <label key={b.name} className="check-row" title={r.imp.markerBlocks.find((m) => m.name === b.name)?.why ?? 'Treat this block as a base-point marker'}>
                  <input
                    type="checkbox"
                    checked={markersUsed.has(b.name)}
                    onChange={(e) => reload({ markers: e.target.checked ? [...markersUsed, b.name] : [...markersUsed].filter((n) => n !== b.name) })}
                  />{' '}
                  {b.name} <span className="muted">×{b.inserts}</span>
                </label>
              ))
            ) : (
              <span className="muted">no blocks</span>
            )}
          </div>
        </div>
        <div className="asm-notes muted">
          {r.imp.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      </div>

      <div className="asm-tabs" role="tablist">
        {r.imp.details.map((x, i) => {
          const a = r.details[i].action;
          return (
            <button key={i} role="tab" aria-selected={i === cur} className={`asm-tab ${i === cur ? 'on' : ''} ${a}`} onClick={() => set({ current: i })}>
              <strong>{r.details[i].choice.name || `Detail ${i + 1}`}</strong>
              <span className="muted">
                {' '}
                · {r.details[i].choice.components.length} outlines · BP {x.base.x.toFixed(1)}, {x.base.y.toFixed(1)}
                {a === 'merge' ? ' · merged' : a === 'skip' ? ' · skipped' : ''}
              </span>
            </button>
          );
        })}
      </div>

      <div className="asm-detail">
        <div className="asm-left">
          <LoopsPreview loops={loops} size={300} height={300} label={`Detail ${cur + 1}: components and base point`} onPick={(k) => setHot(Number(k))} />
          <div className="muted asm-small">
            Base point from {d.baseFrom.map(fromText).join(' + ')}. Main part outlined; dimmed outlines are left out.
          </div>
          <div className="btn-row">
            <button className="secondary-btn" title="Turn the detail 90° clockwise about its base point" onClick={() => setChoice(cur, { rotation: ((ch.rotation - 90 + 540) % 360) - 180 })}>
              ↻ −90°
            </button>
            <button className="secondary-btn" title="Turn the detail 90° counter-clockwise about its base point" onClick={() => setChoice(cur, { rotation: ((ch.rotation + 90 + 540) % 360) - 180 })}>
              ↺ +90°
            </button>
            <button className={`secondary-btn ${ch.mirror ? 'on' : ''}`} title="Mirror the detail about the base point's vertical" onClick={() => setChoice(cur, { mirror: !ch.mirror })}>
              ⇆ Flip
            </button>
            <span className="muted">
              {ch.rotation ? `turned ${ch.rotation}°` : 'as drawn'}
              {ch.mirror ? ', mirrored' : ''}
            </span>
          </div>
          <p className="muted asm-small">Drawing y is the member's local z (section depth), x its local y. Kg/m of the components: {totalKg.toFixed(2)}.</p>
        </div>
        <div className="asm-right">
          {rel && (
            <div className={`asm-dup ${d.duplicateOf ? 'dup' : 'similar'}`}>
              {d.duplicateOf ? (
                <p>
                  This detail is <strong>{r.details[rel.detail].choice.name}</strong> turned {rel.rotation}°{rel.mirror ? ' and mirrored' : ''}: the same composite in another orientation.
                </p>
              ) : (
                <p>
                  {d.similarTo!.matched} of {d.similarTo!.total} outlines match <strong>{r.details[rel.detail].choice.name}</strong> turned {rel.rotation}°; {d.similarTo!.differ.join(', ')} differ — usually its own assembly.
                </p>
              )}
              <div className="asm-choice">
                <label className="check-row">
                  <input type="radio" name={`act-${cur}`} checked={dr.action === 'merge'} disabled={!mergeOk} onChange={() => setDetail(cur, { action: 'merge', into: rel.detail })} /> Same assembly, other orientation (rotation {rel.rotation}°)
                </label>
                <label className="check-row">
                  <input type="radio" name={`act-${cur}`} checked={dr.action === 'save'} onChange={() => setDetail(cur, { action: 'save', into: undefined })} /> Keep as its own assembly
                </label>
                <label className="check-row">
                  <input type="radio" name={`act-${cur}`} checked={dr.action === 'skip'} onChange={() => setDetail(cur, { action: 'skip', into: undefined })} /> Skip
                </label>
              </div>
            </div>
          )}
          {!rel && (
            <label className="check-row">
              <input type="checkbox" checked={dr.action !== 'skip'} onChange={(e) => setDetail(cur, { action: e.target.checked ? 'save' : 'skip' })} /> Save this detail as a profile assembly
            </label>
          )}
          <div className="row3">
            <Field label="Assembly name">
              <input value={ch.name} placeholder="CW Mullion A" onChange={(e) => setChoice(cur, { name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Assembly name" />
            </Field>
            <Field label="Mark prefix" hint="empty: the role prefix">
              <input value={ch.prefix ?? ''} placeholder="MA" maxLength={8} onChange={(e) => setChoice(cur, { prefix: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') || undefined })} onKeyDown={(e) => e.stopPropagation()} aria-label="Mark prefix" />
            </Field>
            <Field label="Base point">
              <input value={ch.basePointNote ?? ''} placeholder="glazing line, front face" onChange={(e) => setChoice(cur, { basePointNote: e.target.value || undefined })} onKeyDown={(e) => e.stopPropagation()} aria-label="Base point note" />
            </Field>
          </div>
          <div className="asm-comps">
            <table>
              <thead>
                <tr>
                  <th title="Include">✓</th>
                  <th>Component</th>
                  <th>Layer / block</th>
                  <th>Material</th>
                  <th>Kind</th>
                  <th className="num">cm²</th>
                  <th className="num">kg/m</th>
                  <th title="Fabricated part (NC, drawings); off: listed only">Fab.</th>
                  <th>Length rule</th>
                  <th title="Main part of the assembly">Main</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {[...ch.components]
                  .sort((a, b) => r.imp.outlines[b.outline].area - r.imp.outlines[a.outline].area)
                  .map((c) => {
                    const o = r.imp.outlines[c.outline];
                    return (
                      <tr key={c.outline} className={`${c.include ? '' : 'off'} ${hot === c.outline ? 'hot' : ''}`} onMouseEnter={() => setHot(c.outline)} onMouseLeave={() => setHot(null)}>
                        <td>
                          <input type="checkbox" checked={c.include} disabled={!!o.error} onChange={(e) => setComp(c.outline, { include: e.target.checked })} aria-label={`Include ${c.name}`} />
                        </td>
                        <td>
                          <input className="asm-name" value={c.name} onChange={(e) => setComp(c.outline, { name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Component name" />
                          {o.error && <div className="warning asm-small">{o.error}</div>}
                          {o.holes.length > 0 && <div className="muted asm-small">{o.holes.length} hollow{o.holes.length === 1 ? '' : 's'}</div>}
                        </td>
                        <td className="muted asm-small">{o.block ?? o.layer}</td>
                        <td>
                          <Select value={c.material} options={MATERIAL_OPTIONS.some((m) => m.value === c.material) ? MATERIAL_OPTIONS : [{ value: c.material, label: c.material }, ...MATERIAL_OPTIONS]} onChange={(v) => setComp(c.outline, { material: v })} />
                        </td>
                        <td>
                          <Select<ProfileComponentKind>
                            value={c.kind}
                            options={COMPONENT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                            onChange={(v) => setComp(c.outline, { kind: v, fabricate: defaultFabricate(v), lengthRule: defaultLengthRule(v) })}
                          />
                        </td>
                        <td className="num">{(o.area / 100).toFixed(2)}</td>
                        <td className="num">{outlineKgm(o, c.material).toFixed(2)}</td>
                        <td>
                          <input type="checkbox" checked={c.fabricate} disabled={c.outline === ch.main} onChange={(e) => setComp(c.outline, { fabricate: e.target.checked })} aria-label={`Fabricate ${c.name}`} />
                        </td>
                        <td>
                          <RuleEditor rule={c.lengthRule} disabled={c.outline === ch.main} onChange={(rule) => setComp(c.outline, { lengthRule: rule })} />
                        </td>
                        <td>
                          <input type="radio" name={`main-${cur}`} checked={c.outline === ch.main} disabled={!c.include} onChange={() => setChoice(cur, { main: c.outline, components: ch.components.map((x) => (x.outline === c.outline ? { ...x, fabricate: true, lengthRule: { kind: 'full' } } : x)) })} aria-label={`Main component ${c.name}`} />
                        </td>
                        <td>
                          <Select<string>
                            value={String(cur)}
                            options={r.imp.details.map((_, k) => ({ value: String(k), label: `${k + 1}` }))}
                            onChange={(v) => Number(v) !== cur && moveComp(c.outline, Number(v))}
                          />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Length rule: full length ± end allowances, + %, or pieces (spacing / at nodes). */
export function RuleEditor({ rule, onChange, disabled }: { rule: ComponentLengthRule; onChange: (r: ComponentLengthRule) => void; disabled?: boolean }) {
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (
    <div className="asm-rule">
      <select
        value={rule.kind}
        disabled={disabled}
        aria-label="Length rule"
        onChange={(e) => {
          const k = e.target.value as ComponentLengthRule['kind'];
          onChange(k === 'percent' ? { kind: 'percent', percent: 2 } : k === 'pieces' ? { kind: 'pieces', length: 100, spacing: 600, edge: 150, at: 'spacing' } : { kind: 'full' });
        }}
      >
        <option value="full">Full length ±</option>
        <option value="percent">Length + %</option>
        <option value="pieces">Pieces</option>
      </select>
      {rule.kind === 'full' && !disabled && (
        <>
          <input type="number" step={0.5} value={rule.start ?? 0} title="Start allowance, mm (negative = shorter)" onChange={(e) => onChange({ ...rule, start: num(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
          <input type="number" step={0.5} value={rule.end ?? 0} title="End allowance, mm" onChange={(e) => onChange({ ...rule, end: num(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
        </>
      )}
      {rule.kind === 'percent' && <input type="number" step={0.5} value={rule.percent} title="Allowance, % of the member length" onChange={(e) => onChange({ ...rule, percent: num(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />}
      {rule.kind === 'pieces' && (
        <>
          <input type="number" step={10} value={rule.length} title="Piece length, mm" onChange={(e) => onChange({ ...rule, length: num(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
          <select value={rule.at ?? 'spacing'} title="Where the pieces go" onChange={(e) => onChange({ ...rule, at: e.target.value as 'spacing' | 'nodes' })}>
            <option value="spacing">every</option>
            <option value="nodes">at nodes</option>
          </select>
          {rule.at !== 'nodes' && <input type="number" step={50} value={rule.spacing ?? 600} title="Spacing, mm" onChange={(e) => onChange({ ...rule, spacing: num(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />}
        </>
      )}
    </div>
  );
}
