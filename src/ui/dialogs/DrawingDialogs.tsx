import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, Segmented, Select, TextInput } from '../widgets';
import { drawingsFor } from '../actions';
import { issueDrawings } from '../../core/drawings';
import type { DocStatus, DrawingSettings, SheetSize } from '../../core/model/types';

const STATUSES: { value: DocStatus; label: string; purpose: string }[] = [
  { value: 'In approval', label: 'In approval', purpose: 'Issued for approval' },
  { value: 'Released', label: 'Released', purpose: 'Issued for fabrication' },
  { value: 'In preparation', label: 'In preparation', purpose: 'Issued for information' },
  { value: 'Withdrawn', label: 'Withdrawn', purpose: 'Withdrawn' },
];

/** Record a new revision for a set of drawings (ISO 7200 revision index + document status). */
export function IssueDrawingsDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const drawings = useMemo(() => {
    void project;
    return drawingsFor();
  }, [project]);
  const set = project.drawings.settings;
  const [which, setWhich] = useState<'changed' | 'all'>('changed');
  const [status, setStatus] = useState<DocStatus>('In approval');
  const [description, setDescription] = useState('Issued for approval');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [drawn, setDrawn] = useState(project.info.designer);
  const [checked, setChecked] = useState(set.checkedBy);
  const [approved, setApproved] = useState(set.approvedBy);
  const selected = which === 'all' ? drawings : drawings.filter((d) => d.changed);

  const run = () => {
    let n = 0;
    apply('Issue drawings', (p) => {
      n = issueDrawings(
        p,
        selected.map((d) => ({ id: d.id, fingerprint: d.fingerprint })),
        { description, status, date, drawn, checked, approved },
      );
    });
    notify(`Issued ${n} drawing${n === 1 ? '' : 's'} — ${description}.`);
    onClose();
  };

  return (
    <Modal
      title="Issue drawings"
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {selected.length} of {drawings.length} sheets get the next revision index
          </span>
          <button className="primary-btn" disabled={!selected.length || !description.trim()} onClick={run}>
            Issue {selected.length} sheet{selected.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p className="muted">
        Each issued sheet gets the next revision index ({set.revisionScheme === 'alpha' ? 'A, B, C…' : '0, 1, 2…'}) with this description in its revision
        table, and the document status in its title block. Sheets whose content changes afterwards are flagged as changed until they are issued again.
      </p>
      <Field label="Sheets">
        <Segmented
          value={which}
          options={[
            { value: 'changed', label: `New or changed (${drawings.filter((d) => d.changed).length})` },
            { value: 'all', label: `All (${drawings.length})` },
          ]}
          onChange={setWhich}
        />
      </Field>
      <div className="row2">
        <Field label="Document status (ISO 7200)">
          <Select<DocStatus>
            value={status}
            options={STATUSES.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(v) => {
              setStatus(v);
              setDescription(STATUSES.find((s) => s.value === v)!.purpose);
            }}
          />
        </Field>
        <Field label="Date of issue">
          <TextInput value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label="Revision description">
        <TextInput value={description} onChange={setDescription} />
      </Field>
      <div className="row3">
        <Field label="Drawn">
          <TextInput value={drawn} onChange={setDrawn} />
        </Field>
        <Field label="Checked">
          <TextInput value={checked} onChange={setChecked} />
        </Field>
        <Field label="Approved">
          <TextInput value={approved} onChange={setApproved} />
        </Field>
      </div>
    </Modal>
  );
}

const SHEET_OPTS: SheetSize[] = ['A3', 'A2', 'A1'];

export function DrawingSettingsDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const s = project.drawings.settings;
  const patch = (label: string, v: Partial<DrawingSettings>) => apply(label, (p) => void Object.assign(p.drawings.settings, v));
  const [notes, setNotes] = useState(s.extraNotes.join('\n'));
  const iso = s.standard === 'ISO';
  return (
    <Modal
      title="Drawing settings"
      wide
      onClose={() => {
        const list = notes.split('\n').map((x) => x.trim()).filter(Boolean);
        if (list.join('\n') !== s.extraNotes.join('\n')) patch('Drawing notes', { extraNotes: list });
        onClose();
      }}
    >
      <Field label="Drawing standard">
        <Segmented
          value={s.standard}
          options={[
            { value: 'ISO', label: 'ISO / EN (international)' },
            { value: 'ASME', label: 'ASME / AISC (US)' },
          ]}
          onChange={(v) => patch('Drawing standard', { standard: v })}
        />
      </Field>
      <ul className="std-list">
        {iso ? (
          <>
            <li>Sheets ISO 5457 (frame, filing margin, grid reference, centring marks); title block ISO 7200; projection symbol ISO 5456-2.</li>
            <li>First-angle projection (ISO 128-3 / ISO 5456-2): plan view below, view from the left on the right; interrupted views for long parts.</li>
            <li>Lines ISO 128-2 (0.5 / 0.25 / frame 0.7), lettering ISO 3098, dimensions ISO 129-1, scales ISO 5455.</li>
            <li>Item balloons ISO 6433, parts lists ISO 7573, weld symbols ISO 2553 (system A), notes per EN 1090-2.</li>
          </>
        ) : (
          <>
            <li>Third-angle projection (ASME Y14.3): plan view above, view from the right on the right.</li>
            <li>Weld symbols AWS A2.4 (leg size), notes per AISC 303 / AWS D1.1 / ASTM. Sheet layout stays ISO 5457.</li>
          </>
        )}
      </ul>
      <div className="row3">
        <Field label="Part & assembly sheets">
          <Select<SheetSize> value={s.sheet} options={SHEET_OPTS} onChange={(v) => patch('Sheet size', { sheet: v })} />
        </Field>
        <Field label="GA sheets">
          <Select<SheetSize> value={s.gaSheet} options={[...SHEET_OPTS, 'A0']} onChange={(v) => patch('GA sheet size', { gaSheet: v })} />
        </Field>
        <Field label="Revision index">
          <Select
            value={s.revisionScheme}
            options={[
              { value: 'alpha', label: 'A, B, C … (ISO 7200)' },
              { value: 'numeric', label: '0, 1, 2 …' },
            ]}
            onChange={(v) => patch('Revision scheme', { revisionScheme: v as 'alpha' | 'numeric' })}
          />
        </Field>
      </div>
      <div className="row3">
        <Field label="Drawing number prefix" hint={`e.g. ${s.numberPrefix || project.info.number || 'DWG'}-A-M1`}>
          <TextInput value={s.numberPrefix} placeholder={project.info.number || 'DWG'} onChange={(v) => patch('Number prefix', { numberPrefix: v })} />
        </Field>
        <Field label={iso ? 'Execution class (EN 1090-2)' : 'Execution class'}>
          <Select value={s.executionClass} options={['EXC1', 'EXC2', 'EXC3', 'EXC4']} onChange={(v) => patch('Execution class', { executionClass: v })} />
        </Field>
        <Field label="Legal owner (title block)">
          <TextInput value={s.legalOwner} placeholder={project.info.client} onChange={(v) => patch('Legal owner', { legalOwner: v })} />
        </Field>
      </div>
      <div className="row3">
        <Field label={iso ? 'Fillet weld throat a' : 'Fillet weld leg size'}>
          <NumberInput value={s.weldSize} unit="mm" min={2} onChange={(v) => patch('Weld size', { weldSize: v })} />
        </Field>
        <Field label="Weld process (ISO 4063)" hint="135 = MAG, 111 = MMA, 136 = FCAW">
          <TextInput value={s.weldProcess} onChange={(v) => patch('Weld process', { weldProcess: v })} />
        </Field>
        <Field label="Checked / approved by (defaults)">
          <span className="row-inline">
            <TextInput value={s.checkedBy} placeholder="Checked" onChange={(v) => patch('Checked by', { checkedBy: v })} />
            <TextInput value={s.approvedBy} placeholder="Approved" onChange={(v) => patch('Approved by', { approvedBy: v })} />
          </span>
        </Field>
      </div>
      <Field label="Additional general notes" hint="One note per line — printed after the standard notes on every sheet">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
    </Modal>
  );
}
