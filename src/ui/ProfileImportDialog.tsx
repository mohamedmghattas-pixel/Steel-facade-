/**
 * Review step of a profile upload (DXF / JSON / CSV): the profiles found, with
 * a section preview (insertion point marked), size, mass and area, editable
 * names, units for DXF, and per-profile "Edit in sketcher".
 */
import { useMemo } from 'react';
import { profileFromDef, profileMassIn, type Profile } from '../core/library/profiles';
import { MATERIALS } from '../core/library/materials';
import { Field, Modal, Select } from './widgets';
import { SectionPreview } from './SectionPreview';
import { addReviewed, openSketcherWith, reviewFromText } from './profileActions';
import { useProfileUi, type ImportReview, type ReviewItem } from './profileUiState';
import './profiles.css';

const UNITS: { value: string; label: string }[] = [
  { value: '1', label: 'millimetres' },
  { value: '10', label: 'centimetres' },
  { value: '1000', label: 'metres' },
  { value: '25.4', label: 'inches' },
  { value: '304.8', label: 'feet' },
];

const INS_FROM: Record<string, string> = { point: 'POINT entity', marker: 'INSERT-layer marker', origin: 'DXF origin (0, 0)', none: 'none (3×3 grid)' };

export function ProfileImportHost() {
  const review = useProfileUi((s) => s.review);
  return review ? <ProfileImportDialog review={review} /> : null;
}

function ProfileImportDialog({ review }: { review: ImportReview }) {
  const close = () => useProfileUi.setState({ review: null });
  const set = (r: Partial<ImportReview>) => useProfileUi.setState({ review: { ...review, ...r } });
  const setItem = (i: number, patch: Partial<ReviewItem>) => set({ items: review.items.map((it, k) => (k === i ? { ...it, ...patch } : it)) });
  const built = useMemo(
    () =>
      review.items.map((it): { p?: Profile; err?: string } => {
        if (it.error) return { err: it.error };
        try {
          return { p: profileFromDef(it.def) };
        } catch (e) {
          return { err: (e as Error).message.replace(`${it.def.name}: `, '') };
        }
      }),
    [review.items],
  );
  const names = review.items.map((it) => it.def.name.trim());
  const dup = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const chosen = review.items.filter((it, i) => it.include && built[i].p && !dup.has(it.def.name.trim()));
  const setAll = (patch: Partial<ReviewItem['def']>) => set({ items: review.items.map((it) => ({ ...it, def: { ...it.def, ...patch } })) });
  return (
    <Modal
      wide
      title={`Import profiles — ${review.fileName}`}
      onClose={close}
      footer={
        <>
          <span className="muted">
            {review.items.length} found · {chosen.length} selected
          </span>
          <button className="primary-btn" disabled={!chosen.length} onClick={() => addReviewed(chosen.map((it) => ({ ...it.def, name: it.def.name.trim() })))}>
            Add {chosen.length} profile{chosen.length === 1 ? '' : 's'} to the project
          </button>
        </>
      }
    >
      <div className="row3">
        {review.kind === 'dxf' && (
          <Field label="Drawing units" hint={review.unitSource === 'insunits' ? 'from $INSUNITS' : review.unitSource === 'measurement' ? 'from $MEASUREMENT' : review.unitSource === 'user' ? 'chosen' : 'not in the file: assumed'}>
            <Select
              value={String(review.unitScale ?? 1)}
              options={UNITS.some((u) => u.value === String(review.unitScale)) ? UNITS : [...UNITS, { value: String(review.unitScale), label: `${review.unitScale} mm/unit` }]}
              onChange={(v) => {
                const r = reviewFromText(review.fileName, review.text, Number(v));
                // Keep the names the user typed and the selection.
                r.items = r.items.map((it, i) => (review.items[i] ? { ...it, include: review.items[i].include && !it.error, def: { ...it.def, name: review.items[i].def.name, family: review.items[i].def.family, material: review.items[i].def.material } } : it));
                useProfileUi.setState({ review: r });
              }}
            />
          </Field>
        )}
        <Field label="Family (all)">
          <input value={review.items[0]?.def.family ?? ''} placeholder="Custom outline" onChange={(e) => setAll({ family: e.target.value || undefined })} />
        </Field>
        <Field label="Material (all)">
          <Select value={review.items[0]?.def.material ?? ''} options={[{ value: '', label: 'Steel (member material)' }, ...MATERIALS.map((m) => ({ value: m.name, label: m.name }))]} onChange={(v) => setAll({ material: v || undefined })} />
        </Field>
      </div>
      {review.notes.map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      <div className="pi-list">
        {review.items.map((it, i) => {
          const b = built[i];
          const p = b.p;
          return (
            <div key={i} className={`pi-item ${it.include && p ? '' : 'off'}`}>
              <SectionPreview profile={p ?? null} shape={p ? undefined : it.def.shape} insertion={null} size={96} mode={p?.insertion ? 'insertion' : 'grid'} />
              <div className="pi-main">
                <div className="pi-row">
                  <input type="checkbox" checked={it.include && !!p} disabled={!p} onChange={(e) => setItem(i, { include: e.target.checked })} aria-label={`Import ${it.def.name}`} />
                  <input className={`pi-name ${dup.has(it.def.name.trim()) ? 'err' : ''}`} value={it.def.name} onChange={(e) => setItem(i, { def: { ...it.def, name: e.target.value } })} aria-label="Profile name" />
                  {it.def.shape.type === 'POLY' && (
                    <button className="link-btn" onClick={() => openSketcherWith({ ...it.def, name: it.def.name.trim() })}>
                      Edit in sketcher…
                    </button>
                  )}
                </div>
                {p ? (
                  <div className="pi-props mono">
                    {p.b.toFixed(1)} × {p.h.toFixed(1)} mm · {(p.area / 100).toFixed(2)} cm² · {profileMassIn(p).toFixed(2)} kg/m{p.material ? ` (${p.material})` : ''} · Iy {(p.Iy / 1e4).toFixed(1)} cm⁴ · Iz {(p.Iz / 1e4).toFixed(1)} cm⁴
                    {it.def.shape.type === 'POLY' && ` · ${(it.def.shape.holes ?? []).length} hole${(it.def.shape.holes ?? []).length === 1 ? '' : 's'}`}
                  </div>
                ) : (
                  <p className="warning">{b.err}</p>
                )}
                <div className="muted pi-small">
                  {it.nameFrom && <>Name from {it.nameFrom === 'text' ? 'drawing text' : 'file name'} · </>}
                  Insertion point: {it.insertionFrom ? INS_FROM[it.insertionFrom] : it.def.insertion ? `${it.def.insertion.x}, ${it.def.insertion.y}` : 'none (3×3 grid)'}
                  {dup.has(it.def.name.trim()) && <span className="warning"> · duplicate name</span>}
                </div>
                {it.warnings.map((w, k) => (
                  <div key={k} className="muted pi-small">
                    {w}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
