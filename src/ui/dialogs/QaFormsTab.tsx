/**
 * Export package → QA forms: the QAF / VCF either built in or filled into the
 * user's own workbook (upload once; only the mapped cells change). Shows the
 * automatic QAF answers and, for an uploaded workbook, what is in the mapped
 * cells now, so a wrong mapping is easy to spot.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { TextInput } from '../widgets';
import { Icon } from '../icons';
import { currentIssue, qafDecisions, type PackagePlan } from '../../core/export/package';
import { QAF_ITEMS, defaultQafMapping, defaultVcfMapping, vcfRows, type QafAnswer } from '../../core/export/forms';
import type { QafMapping, VcfMapping } from '../../core/export/types';
import { clearFormTemplate, previewFormCells, setFormMapping, uploadFormTemplate, type FormKind } from '../exportPackageActions';

const ANSWER: Record<string, string> = { yes: 'Yes', no: 'No', na: 'N/A' };
const answerText = (a: QafAnswer) => (a ? ANSWER[a] : 'manual');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const col = (v: string) => v.trim().toUpperCase().replace(/[^A-Z]/g, '');
const cell = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

function usePreview(kind: FormKind, refs: string[], key: unknown) {
  const [state, setState] = useState<{ cells: Record<string, string>; sheets: string[]; sheet: string } | { error: string } | null>(null);
  const refKey = refs.join(',');
  useEffect(() => {
    let live = true;
    setState(null);
    void previewFormCells(kind, refKey ? refKey.split(',') : []).then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [kind, refKey, key]);
  return state;
}

export function QaFormsTab({ plan }: { plan: PackagePlan }) {
  const forms = useStore((s) => s.project.exportPackage?.forms);
  const notify = useStore((s) => s.notify);
  const upload = async (kind: FormKind) => {
    try {
      const name = await uploadFormTemplate(kind);
      if (name) notify(`${kind.toUpperCase()} template "${name}" stored in this browser; it is filled at the next export.`);
    } catch (e) {
      notify(`Could not read the workbook: ${(e as Error).message}`, 'error');
    }
  };
  return (
    <div className="xp-forms">
      <p className="muted">
        Without a workbook of your own, FacadeSteel writes its built-in QAF and VCF with the same layout (no logo). Upload your form once to have it filled instead: only the mapped cells change, so logos, styles, merged
        cells, lists and check boxes stay as they are. Workbooks are kept in this browser, like reference models.
      </p>
      <QafSection plan={plan} t={forms?.qaf} onUpload={() => void upload('qaf')} />
      <VcfSection plan={plan} t={forms?.vcf} onUpload={() => void upload('vcf')} />
    </div>
  );
}

function Head({ title, t, onUpload, kind }: { title: string; t?: { name: string }; onUpload: () => void; kind: FormKind }) {
  return (
    <div className="xp-form-head">
      <h4>{title}</h4>
      <span className="muted">{t ? `Your workbook: ${t.name}` : 'Built-in form'}</span>
      <span className="grow" />
      <button className="secondary-btn" onClick={onUpload}>
        <Icon name="import" size={14} /> {t ? 'Replace…' : 'Upload workbook…'}
      </button>
      {t && (
        <button className="secondary-btn" onClick={() => clearFormTemplate(kind)}>
          <Icon name="close" size={14} /> Clear
        </button>
      )}
    </div>
  );
}

function SheetPick({ sheets, value, onChange }: { sheets: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Sheet">
      {[...new Set([value, ...sheets])].map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function QafSection({ plan, t, onUpload }: { plan: PackagePlan; t?: { name: string; mapping: QafMapping }; onUpload: () => void }) {
  const decisions = useMemo(() => qafDecisions(plan), [plan]);
  const m: QafMapping = t ? { ...defaultQafMapping(), ...t.mapping, rows: { ...defaultQafMapping().rows, ...t.mapping.rows } } : defaultQafMapping();
  const refs = t ? QAF_ITEMS.map((i) => `C${m.rows[i.key]}`) : [];
  const preview = usePreview('qaf', refs, t);
  const set = (patch: Partial<QafMapping>) => setFormMapping('qaf', { ...m, ...patch });
  const cells = preview && 'cells' in preview ? preview.cells : {};
  return (
    <section className="xp-form">
      <Head title="QAF — Basic check list for material & fabrication submittals" t={t} onUpload={onUpload} kind="qaf" />
      {t && (
        <div className="xp-map">
          <label>
            Sheet <SheetPick sheets={preview && 'sheets' in preview ? preview.sheets : []} value={m.sheet} onChange={(sheet) => set({ sheet })} />
          </label>
          <label>
            Yes <TextInput value={m.yes} onChange={(v) => set({ yes: col(v) || m.yes })} />
          </label>
          <label>
            No <TextInput value={m.no} onChange={(v) => set({ no: col(v) || m.no })} />
          </label>
          <label>
            N/A <TextInput value={m.na} onChange={(v) => set({ na: col(v) || m.na })} />
          </label>
          <label>
            Name cell <TextInput value={m.name} onChange={(v) => set({ name: cell(v) })} />
          </label>
          <label>
            Date cell <TextInput value={m.date} onChange={(v) => set({ date: cell(v) })} />
          </label>
        </div>
      )}
      {preview && 'error' in preview && t && <p className="xp-err">{preview.error}</p>}
      <table className="xp-table xp-qaf">
        <thead>
          <tr>
            <th>Row</th>
            <th>Item</th>
            {t && <th>In your workbook (column C)</th>}
            <th>Answer</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => {
            const row = m.rows[d.item.key];
            const theirs = cells[`C${row}`] ?? '';
            const off = !!t && !!preview && 'cells' in preview && norm(theirs).slice(0, 12) !== norm(d.item.text).slice(0, 12);
            return (
              <tr key={d.item.key} className={off ? 'xp-mismatch' : ''}>
                <td>
                  {t ? (
                    <input
                      className="xp-row-input"
                      type="number"
                      min={1}
                      defaultValue={row}
                      aria-label={`Row of ${d.item.text}`}
                      onKeyDown={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const n = Math.floor(Number(e.target.value));
                        if (n > 0 && n !== row) set({ rows: { ...m.rows, [d.item.key]: n } });
                      }}
                    />
                  ) : (
                    row
                  )}
                </td>
                <td>{d.item.text}</td>
                {t && <td className={off ? 'xp-err' : 'muted'}>{theirs || '(empty)'}</td>}
                <td className={`xp-ans xp-ans-${d.answer ?? 'manual'}`}>{answerText(d.answer)}</td>
                <td className="muted">{d.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function VcfSection({ plan, t, onUpload }: { plan: PackagePlan; t?: { name: string; mapping: VcfMapping }; onUpload: () => void }) {
  const rows = useMemo(() => vcfRows(plan.ctx.settings.history ?? [], currentIssue(plan.ctx)), [plan]);
  const def = defaultVcfMapping();
  const m: VcfMapping = t ? { ...def, ...t.mapping, cols: { ...def.cols, ...t.mapping.cols } } : def;
  const head: [keyof VcfMapping, string][] = [
    ['projectName', 'Project name'],
    ['submittalType', 'Submittal type'],
    ['submittalRef', 'Submittal REF'],
    ['date', 'VCF date'],
  ];
  const refs = t ? [...head.map(([k]) => String(m[k])), ...Object.values(m.cols).map((c) => `${c}${m.firstRow - 1}`)] : [];
  const preview = usePreview('vcf', refs, t);
  const cells = preview && 'cells' in preview ? preview.cells : {};
  const set = (patch: Partial<VcfMapping>) => setFormMapping('vcf', { ...m, ...patch });
  return (
    <section className="xp-form">
      <Head title="VCF — Versions control form" t={t} onUpload={onUpload} kind="vcf" />
      {t && (
        <>
          <div className="xp-map">
            <label>
              Sheet <SheetPick sheets={preview && 'sheets' in preview ? preview.sheets : []} value={m.sheet} onChange={(sheet) => set({ sheet })} />
            </label>
            {head.map(([k, label]) => (
              <label key={k} title={`Now: ${cells[String(m[k])] ?? '(empty)'}`}>
                {label} <TextInput value={String(m[k])} onChange={(v) => set({ [k]: cell(v) } as Partial<VcfMapping>)} />
              </label>
            ))}
            <label>
              First table row{' '}
              <TextInput
                value={String(m.firstRow)}
                onChange={(v) => {
                  const n = Math.floor(Number(v));
                  if (n > 0) set({ firstRow: n });
                }}
              />
            </label>
          </div>
          <div className="xp-map">
            {(Object.keys(m.cols) as (keyof VcfMapping['cols'])[]).map((k) => (
              <label key={k} title={`Header now: ${cells[`${m.cols[k]}${m.firstRow - 1}`] ?? '(empty)'}`}>
                {k} <TextInput value={m.cols[k]} onChange={(v) => set({ cols: { ...m.cols, [k]: col(v) || m.cols[k] } })} />
              </label>
            ))}
          </div>
          {preview && 'error' in preview && <p className="xp-err">{preview.error}</p>}
          {preview && 'cells' in preview && (
            <p className="muted">
              Table header row {m.firstRow - 1} in your workbook: {Object.values(m.cols).map((c) => cells[`${c}${m.firstRow - 1}`] || '—').join(' | ')}
            </p>
          )}
        </>
      )}
      <table className="xp-table">
        <thead>
          <tr>
            <th>Revision</th>
            <th>Version</th>
            <th>Status</th>
            <th>Issued by</th>
            <th>Comment type</th>
            <th>Modifications</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.revision}>
              <td>{r.revision}</td>
              <td>{r.version}</td>
              <td>{r.status}</td>
              <td>{r.issuedBy || <span className="muted">(project designer)</span>}</td>
              <td>{r.commentType}</td>
              <td className="muted">{r.modifications}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Each export with a new revision adds a row; the newest is “Last Update”, earlier ones “Superseded”.</p>
    </section>
  );
}
