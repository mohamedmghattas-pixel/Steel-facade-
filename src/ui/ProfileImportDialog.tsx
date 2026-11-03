/**
 * Review step of a profile upload (DXF / JSON / CSV): the profiles found, with
 * a section preview (insertion point marked), size, mass and area, editable
 * names, units for DXF, and per-profile "Edit in sketcher".
 */
import { useMemo } from 'react';
import { PROFILE_PROCESSES, profileFromDef, profileMassIn, type Profile, type ProfileProcess } from '../core/library/profiles';
import { bentStrip, profileProcess } from '../core/library/forming';
import { MATERIALS } from '../core/library/materials';
import { Field, Modal, Select } from './widgets';
import { SectionPreview } from './SectionPreview';
import { LoopsPreview, type PreviewLoop } from './AssemblyPreview';
import { flattenLoop } from '../core/library/polyShape';
import { addReviewed, openSketcherWith, reviewFromText } from './profileActions';
import { useProfileUi, type ImportReview, type ReviewItem } from './profileUiState';
import { openAssemblyReview } from './profileAssemblyActions';
import './profiles.css';

const UNITS: { value: string; label: string }[] = [
  { value: '1', label: 'millimetres' },
  { value: '10', label: 'centimetres' },
  { value: '1000', label: 'metres' },
  { value: '25.4', label: 'inches' },
  { value: '304.8', label: 'feet' },
];

const INS_FROM: Record<string, string> = { point: 'POINT entity', marker: 'INSERT-layer marker', origin: 'DXF origin (0, 0)', none: 'none (3×3 grid)', detail: 'the base point of its detail, shared by all its outlines' };

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
  /** Read the file again (units, insertion rule), keeping the names typed and the selection. */
  const reread = (unitScale: number | undefined, sharedBase: boolean) => {
    const r = reviewFromText(review.fileName, review.text, unitScale, sharedBase);
    r.items = r.items.map((it, i) => (review.items[i] ? { ...it, include: review.items[i].include && !it.error, def: { ...it.def, name: review.items[i].def.name, family: review.items[i].def.family, material: review.items[i].def.material, process: review.items[i].def.process } } : it));
    useProfileUi.setState({ review: r });
  };
  // Outlines of each detail in its base-point coordinates (for the previews: the outline in its detail).
  const detailLoops = useMemo(() => {
    const by = new Map<number, PreviewLoop[]>();
    review.items.forEach((it, i) => {
      if (!it.detail || it.def.shape.type !== 'POLY') return;
      const list = by.get(it.detail.index) ?? [];
      list.push({ key: String(i), outer: flattenLoop(it.def.shape.outer), holes: (it.def.shape.holes ?? []).map((h) => flattenLoop(h)), material: it.def.material ?? 'S355', title: it.def.name });
      by.set(it.detail.index, list);
    });
    return by;
  }, [review.items]);
  const hasDetails = review.items.some((it) => it.detail) || review.sharedBase === false;
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
              onChange={(v) => reread(Number(v), review.sharedBase !== false)}
            />
          </Field>
        )}
        {review.kind === 'dxf' && hasDetails && (
          <Field label="Insertion point" hint="An assembly detail: all its outlines are extruded and cut about one base point">
            <Select<string>
              value={review.sharedBase === false ? 'each' : 'shared'}
              options={[
                { value: 'shared', label: 'Base point of the detail (shared)' },
                { value: 'each', label: 'Each outline its own' },
              ]}
              onChange={(v) => reread(review.unitScale, v === 'shared')}
            />
          </Field>
        )}
        <Field label="Family (all)">
          <input value={review.items[0]?.def.family ?? ''} placeholder="Custom outline" onChange={(e) => setAll({ family: e.target.value || undefined })} />
        </Field>
        <Field label="Material (all)">
          <Select value={review.items[0]?.def.material ?? ''} options={[{ value: '', label: 'Steel (member material)' }, ...MATERIALS.map((m) => ({ value: m.name, label: m.name }))]} onChange={(v) => setAll({ material: v || undefined })} />
        </Field>
        <Field label="Made by (all)" hint="Bent parts get an unfold; extruded and rolled ones do not">
          <Select<string>
            value={review.items[0]?.def.process ?? ''}
            options={[{ value: '', label: 'Auto (constant-thickness strips: bent)' }, ...PROFILE_PROCESSES]}
            onChange={(v) => setAll({ process: (v || undefined) as ProfileProcess | undefined })}
          />
        </Field>
      </div>
      {review.kind === 'dxf' && (
        <p className="muted">
          An assembly detail — several profiles linked to one base point (steel, aluminium, gaskets, packers)?{' '}
          <button className="link-btn" onClick={() => openAssemblyReview(review.fileName, review.text)}>
            Import as profile assembly…
          </button>
        </p>
      )}
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
              {it.detail && (detailLoops.get(it.detail.index)?.length ?? 0) > 1 ? (
                <LoopsPreview
                  loops={detailLoops.get(it.detail.index)!.map((l) => ({ ...l, off: l.key !== String(i), hot: l.key === String(i) }))}
                  size={96}
                  label={`${it.def.name} in its detail (base point marked)`}
                />
              ) : (
                <SectionPreview profile={p ?? null} shape={p ? undefined : it.def.shape} insertion={null} size={96} mode={p?.insertion ? 'insertion' : 'grid'} />
              )}
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
                    {madeText(p)}
                  </div>
                ) : (
                  <p className="warning">{b.err}</p>
                )}
                <div className="muted pi-small">
                  {it.nameFrom && <>Name from {it.nameFrom === 'text' ? 'drawing text' : 'file name'} · </>}
                  {it.detail && <>Detail {it.detail.index + 1} ({it.detail.name}) · </>}
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

/** " · bent from 2 mm sheet, unfold 468" / " · extruded": what the part drawings will show for the profile. */
function madeText(p: Profile): string {
  const info = profileProcess(p);
  if (info.process !== 'bent') return ` · ${info.process}${info.auto ? ' (no unfold)' : ''}`;
  const st = bentStrip(p);
  return ` · bent${info.t ? ` from ${Math.round(info.t * 100) / 100} mm sheet` : ''}${st ? `, unfold ${Math.round(st.width)}` : ''}`;
}
