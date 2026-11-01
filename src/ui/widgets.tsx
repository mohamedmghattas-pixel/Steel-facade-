import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PROFILES, getProfile, profileLibraryRevision, profileMassIn, searchProfiles, type Standard } from '../core/library/profiles';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Number input that commits on blur/Enter, shows "—" for mixed values. */
export function NumberInput({
  value,
  onChange,
  step = 1,
  unit,
  mixed,
  min,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  step?: number;
  unit?: string;
  mixed?: boolean;
  min?: number;
}) {
  const [text, setText] = useState(mixed ? '' : fmt(value));
  useEffect(() => setText(mixed ? '' : fmt(value)), [value, mixed]);
  const commit = () => {
    if (text.trim() === '') return;
    const n = Number(text.replace(',', '.'));
    if (Number.isFinite(n) && n !== value) onChange(min !== undefined ? Math.max(min, n) : n);
    else setText(fmt(value));
  };
  return (
    <span className="num-input">
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={mixed ? '—' : ''}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

const fmt = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 1000) / 1000));

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onChange(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  mixed,
}: {
  value: T | undefined;
  options: { value: T; label: string }[] | T[];
  onChange: (v: T) => void;
  mixed?: boolean;
}) {
  const opts = (options as (T | { value: T; label: string })[]).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <select value={mixed ? '' : (value ?? '')} onChange={(e) => onChange(e.target.value as T)}>
      {mixed && <option value="">—</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T | undefined;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={String(o.value)} type="button" title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Searchable profile picker (EN + AISC). */
export function ProfilePicker({
  value,
  onChange,
  mixed,
  allowNone,
  filter,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  mixed?: boolean;
  allowNone?: boolean;
  filter?: (name: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [std, setStd] = useState<Standard | 'all'>('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const list = useMemo(
    () => searchProfiles(q, std === 'all' ? undefined : std).filter((p) => !filter || filter(p.name)).slice(0, 120),
    // The catalogue revision: custom profiles come and go with the project.
    [q, std, filter, profileLibraryRevision()],
  );
  const label = mixed ? '— mixed —' : value ? value : allowNone ? 'Wireframe (no profile)' : 'Choose profile';
  return (
    <div className="profile-picker" ref={ref}>
      <button type="button" className="picker-btn" onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <span className="muted">{value && getProfile(value) ? `${profileMassIn(getProfile(value)!).toFixed(1)} kg/m` : ''}</span>
      </button>
      {open && (
        <div className="picker-pop">
          <div className="picker-search">
            <input autoFocus placeholder="Search e.g. SHS 100, HSS4x4, L 60" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <Segmented
              value={std}
              options={[{ value: 'all' as const, label: 'All' }, ...[...new Set(PROFILES.map((p) => p.standard))].map((x) => ({ value: x, label: x }))]}
              onChange={setStd}
            />
          </div>
          <div className="picker-list">
            {allowNone && (
              <button type="button" onClick={() => (onChange(null), setOpen(false))}>
                <span>Wireframe (no profile)</span>
              </button>
            )}
            {list.map((p) => (
              <button type="button" key={p.name} className={p.name === value ? 'on' : ''} onClick={() => (onChange(p.name), setOpen(false))}>
                <span>{p.name}</span>
                <span className="muted">
                  {p.family} · {profileMassIn(p).toFixed(1)} kg/m{p.insertion ? ' · ⌖' : ''}
                </span>
              </button>
            ))}
            {!list.length && <div className="empty">No profiles match.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A dialog. `docked`: a side sheet over the right of the window that leaves the 3D view usable. */
export function Modal({ title, onClose, children, footer, wide, docked }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; docked?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className={`modal-backdrop ${docked ? 'docked' : ''}`} onMouseDown={(e) => !docked && e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${docked ? 'docked' : ''}`} role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** "3x1500, 1200" → [1500, 1500, 1500, 1200] */
export function parseList(s: string): number[] {
  const out: number[] = [];
  for (const tok of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = tok.match(/^(\d+)\s*[x*]\s*(-?\d+(?:\.\d+)?)$/i);
    if (m) for (let i = 0; i < Number(m[1]); i++) out.push(Number(m[2]));
    else if (Number.isFinite(Number(tok))) out.push(Number(tok));
  }
  return out;
}

export const kg = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} kg`;
export const mm = (n: number) => `${Math.round(n).toLocaleString()} mm`;
export { PROFILES };
