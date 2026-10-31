/**
 * Connection library browser + the live connection preview used across the
 * app (Apply dialog, custom template editor, connection properties).
 *
 * The preview runs the real deriveModel on a mini project (core/connections/
 * preview.ts) — a typical joint, the user's selected members (what Apply
 * would create) or a selected connection with edited parameters — and shows
 * the detailing-check findings for that joint underneath.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import './connectionLibrary.css';
import { useStore } from '../state/store';
import { useAsk, askText } from './askState';
import { Field, NumberInput, ProfilePicker, Select, TextInput, kg } from './widgets';
import { Icon } from './icons';
import { CONNECTIONS, applyConnection, paramSpecs } from '../core/connections/registry';
import { CATALOG, CATEGORIES, searchCatalog, type CategoryId } from '../core/connections/catalog';
import { contextBoxes, previewFindings, previewFromConnection, previewFromMembers, previewJoint, type PreviewFinding, type PreviewJoint } from '../core/connections/preview';
import type { ParamSpec } from '../core/connections/common';
import { deriveModel } from '../core/derive/model';
import { codeForProject } from '../core/codes';
import { BOLT_SIZES } from '../core/library/bolts';
import { getProfile } from '../core/library/profiles';
import { newId } from '../core/model/ops';
import type { ConnectionType, CustomTemplate, Id, ParamValue, Project } from '../core/model/types';
import { ConnectionPreview, cachedThumbnail, renderThumbnail } from '../viewer/ConnectionPreview';

// ---------------------------------------------------------------------------
// Open state (kept here so the library can be opened from anywhere)

interface LibState {
  open: boolean;
  type?: ConnectionType;
  params?: Record<string, ParamValue>;
}
export const useConnectionLibrary = create<LibState>(() => ({ open: false }));
export function openConnectionLibrary(o: Omit<LibState, 'open'> = {}) {
  useConnectionLibrary.setState({ open: true, ...o });
}
const closeLibrary = () => useConnectionLibrary.setState({ open: false });

// ---------------------------------------------------------------------------
// Preview

export interface PreviewSpec {
  type: ConnectionType;
  params: Record<string, ParamValue>;
  /** Typical joint, the selected members (as Apply would place it) or an existing connection. */
  on: 'typical' | 'members' | 'connection';
  memberIds?: Id[];
  connectionId?: Id;
  secondaryProfile?: string;
  /** Unsaved templates (custom template editor) overriding the project library. */
  templates?: CustomTemplate[];
}

function withTemplates(p: Project, templates?: CustomTemplate[]): Project {
  if (!templates?.length) return p;
  const ids = new Set(templates.map((t) => t.id));
  return { ...p, library: { ...p.library, templates: [...p.library.templates.filter((t) => !ids.has(t.id)), ...templates] } };
}

export function buildPreview(project: Project, spec: PreviewSpec): { pj: PreviewJoint; note?: string } {
  const src = withTemplates(project, spec.templates);
  if (spec.on === 'connection' && spec.connectionId) {
    const pj = previewFromConnection(src, spec.connectionId, spec.params, spec.type);
    if (pj) return { pj };
  }
  if (spec.on === 'members' && spec.memberIds?.length) {
    const pj = previewFromMembers(src, spec.memberIds, spec.type, spec.params);
    if (pj) return { pj, note: 'Preview of the first joint Apply will create on your selection.' };
    return { pj: previewJoint(spec.type, spec.params, { base: src, secondaryProfile: spec.secondaryProfile }), note: 'No selected member end suits this type — showing a typical joint.' };
  }
  return { pj: previewJoint(spec.type, spec.params, { base: src, secondaryProfile: spec.secondaryProfile }) };
}

function stats(pj: PreviewJoint, dm: ReturnType<typeof deriveModel>): string {
  const parts = dm.parts.filter((p) => p.connectionId === pj.connectionId);
  const bolts = dm.bolts.filter((b) => b.connectionId === pj.connectionId).reduce((s, b) => s + b.positions.length, 0);
  const holes = parts.reduce((s, p) => s + (p.plateHoles?.length ?? 0) + p.holes.length, 0) + dm.parts.filter((p) => p.kind === 'member').reduce((s, p) => s + p.holes.length, 0);
  return `${parts.length} part${parts.length === 1 ? '' : 's'} · ${holes} holes · ${bolts} bolts/anchors · ${kg(parts.reduce((s, p) => s + p.mass, 0))}`;
}

/** Live 3D preview of a connection with its detailing findings. Rebuilds 100 ms after the last change; keeps the camera. */
export function ConnectionPreviewView({ spec, height = 300, showFindings = true }: { spec: PreviewSpec; height?: number; showFindings?: boolean }) {
  const project = useStore((s) => s.project);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ConnectionPreview | null>(null);
  const [labels, setLabels] = useState(false);
  const [state, setState] = useState<{ findings: PreviewFinding[]; note?: string; stats?: string; error?: string }>({ findings: [] });
  const last = useRef('');
  useEffect(() => {
    if (!host.current) return;
    let v: ConnectionPreview | null = null;
    try {
      v = new ConnectionPreview(host.current, { labels: false });
    } catch (e) {
      setState({ findings: [], error: `3D preview unavailable: ${(e as Error).message}` });
    }
    view.current = v;
    return () => {
      v?.dispose();
      view.current = null;
    };
  }, []);
  const key = JSON.stringify(spec);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const { pj, note } = buildPreview(project, spec);
        const dm = deriveModel(pj.project);
        const boxes = contextBoxes(pj, dm);
        const ident = `${spec.type}|${pj.kind}|${spec.on}|${spec.connectionId ?? ''}|${spec.secondaryProfile ?? ''}|${String(spec.params.template ?? '')}|${(spec.memberIds ?? []).join(',')}`;
        view.current?.setContent({ dm, connectionId: pj.connectionId, boxes }, ident !== last.current);
        last.current = ident;
        setState({ findings: showFindings ? previewFindings(pj, dm, codeForProject(project)) : [], note, stats: stats(pj, dm) });
      } catch (e) {
        setState({ findings: [], error: (e as Error).message });
      }
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, project, showFindings]);
  const errors = state.findings.filter((f) => f.severity === 'error').length;
  const warns = state.findings.length - errors;
  return (
    <div className="cp-wrap">
      <div className="cp-view" style={{ height }} ref={host} data-testid="connection-preview">
        <div className="cp-tools">
          <button type="button" className={`chip ${labels ? 'on' : ''}`} onClick={() => (setLabels(!labels), view.current?.setLabels(!labels))} title="Show part, plate and bolt labels">
            Labels
          </button>
          <button type="button" className="chip" onClick={() => view.current?.fit()} title="Fit the connection in the view">
            Fit
          </button>
        </div>
        <div className="cp-legend">
          <span className="sw plate" />
          plates <span className="sw bolt" />
          bolts <span className="sw anchor" />
          anchors <span className="sw hole" />
          holes <span className="sw weld" />
          welds
        </div>
      </div>
      <div className="cp-status">
        <span className="muted">{state.stats}</span>
        {showFindings && (
          <span className={errors ? 'cp-bad' : warns ? 'cp-warn' : 'cp-ok'}>{errors ? `${errors} error${errors > 1 ? 's' : ''}` : warns ? `${warns} warning${warns > 1 ? 's' : ''}` : 'Detailing checks OK'}</span>
        )}
      </div>
      {state.note && <p className="muted cp-note">{state.note}</p>}
      {state.error && <p className="warning">{state.error}</p>}
      {showFindings && state.findings.length > 0 && (
        <ul className="cp-findings" data-testid="preview-findings">
          {state.findings.slice(0, 12).map((f, i) => (
            <li key={i} className={f.severity}>
              <Icon name="warn" size={12} /> {f.text}
            </li>
          ))}
          {state.findings.length > 12 && <li className="muted">… {state.findings.length - 12} more</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parameter editor

export function ParamInput({ ps, value, onChange, project }: { ps: ParamSpec; value: ParamValue | undefined; onChange: (v: ParamValue) => void; project: Project }) {
  const v = value ?? ps.default;
  switch (ps.kind) {
    case 'number':
      return <NumberInput value={v as number} unit={ps.unit} onChange={onChange} />;
    case 'select':
      return <Select value={String(v)} options={ps.options ?? []} onChange={onChange} />;
    case 'bool':
      return (
        <label className="check cp-bool">
          <input type="checkbox" checked={v === true || v === 'true'} onChange={(e) => onChange(e.target.checked)} /> {v === true || v === 'true' ? 'Yes' : 'No'}
        </label>
      );
    case 'bolt':
      return <Select value={String(v)} options={BOLT_SIZES.map((b) => b.name)} onChange={onChange} />;
    case 'profile':
      return <ProfilePicker value={String(v)} onChange={(x) => x && onChange(x)} filter={(n) => getProfile(n)?.shape.type === 'L'} />;
    case 'template':
      return <Select value={String(v)} options={project.library.templates.map((t) => ({ value: t.id, label: t.name }))} onChange={onChange} />;
    default:
      return <TextInput value={String(v)} onChange={onChange} />;
  }
}

/** All parameters of a spec list; key parameters first, the rest under "More". */
export function ParamEditor({
  specs,
  values,
  onChange,
  keyParams = [],
}: {
  specs: ParamSpec[];
  values: Record<string, ParamValue>;
  onChange: (key: string, v: ParamValue) => void;
  keyParams?: string[];
}) {
  const project = useStore((s) => s.project);
  const key = specs.filter((s) => keyParams.includes(s.key)).sort((a, b) => keyParams.indexOf(a.key) - keyParams.indexOf(b.key));
  const rest = specs.filter((s) => !keyParams.includes(s.key));
  const field = (ps: ParamSpec) => (
    <Field key={ps.key} label={ps.label} hint={ps.help}>
      <ParamInput ps={ps} value={values[ps.key]} onChange={(x) => onChange(ps.key, x)} project={project} />
    </Field>
  );
  if (!key.length) return <div className="cp-params">{rest.map(field)}</div>;
  return (
    <>
      <div className="cp-params">{key.map(field)}</div>
      {rest.length > 0 && (
        <details className="cp-more">
          <summary>More parameters ({rest.length})</summary>
          <div className="cp-params">{rest.map(field)}</div>
        </details>
      )}
    </>
  );
}

/** Parameter specs for a type (custom: the template's parameters). */
export function specsFor(type: ConnectionType, params: Record<string, ParamValue>, project: Project): ParamSpec[] {
  return paramSpecs({ id: '', type, node: '', main: null, secondary: [], params }, project);
}

/** Connection type picker grouped by library category. */
export function TypeSelect({ value, onChange }: { value: ConnectionType; onChange: (t: ConnectionType) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as ConnectionType)} aria-label="Connection type">
      {CATEGORIES.map((cat) => {
        const types = Object.values(CATALOG).filter((e) => e.category === cat.id);
        if (!types.length) return null;
        return (
          <optgroup key={cat.id} label={cat.label}>
            {types.map((e) => (
              <option key={e.type} value={e.type}>
                {CONNECTIONS[e.type].label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Thumbnails: one shared offscreen renderer, queued so the list stays responsive.

const queue: (() => void)[] = [];
let busy = false;
function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  setTimeout(() => {
    try {
      job();
    } finally {
      busy = false;
      pump();
    }
  }, 0);
}

function Thumb({ thumbKey, build }: { thumbKey: string; build: () => PreviewJoint }) {
  const [url, setUrl] = useState(() => cachedThumbnail(thumbKey));
  useEffect(() => {
    if (url) return;
    let alive = true;
    queue.push(() => {
      if (!alive) return;
      try {
        const pj = build();
        const dm = deriveModel(pj.project);
        const u = renderThumbnail(thumbKey, { dm, connectionId: pj.connectionId, boxes: contextBoxes(pj, dm) });
        if (alive) setUrl(u);
      } catch {
        /* thumbnail is optional */
      }
    });
    pump();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbKey]);
  return url ? <img className="cl-thumb" src={url} alt="" /> : <div className="cl-thumb cl-thumb-wait" />;
}

// ---------------------------------------------------------------------------
// Library browser

type Entry =
  | { kind: 'type'; type: ConnectionType }
  | { kind: 'template'; id: Id }
  | { kind: 'preset'; id: Id };

const entryKey = (e: Entry) => (e.kind === 'type' ? `t:${e.type}` : `${e.kind}:${e.id}`);

export function ConnectionLibraryHost() {
  const open = useConnectionLibrary((s) => s.open);
  if (!open) return null;
  return createPortal(<ConnectionLibrary />, document.body);
}

function ConnectionLibrary() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const init = useConnectionLibrary.getState();
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CategoryId | 'all'>(init.type ? CATALOG[init.type].category : 'all');
  const [entry, setEntry] = useState<Entry>(init.type ? { kind: 'type', type: init.type } : { kind: 'type', type: 'helpingHand' });
  const [params, setParams] = useState<Record<string, ParamValue>>(init.params ?? {});
  const [on, setOn] = useState<PreviewSpec['on']>(() => (selection.connections.length && init.type ? 'connection' : selection.members.length ? 'members' : 'typical'));
  const [secProfile, setSecProfile] = useState('');
  const [replace, setReplace] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !useAsk.getState().ask && closeLibrary();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const labels = useMemo(() => Object.fromEntries(Object.values(CONNECTIONS).map((d) => [d.type, d.label])) as Record<ConnectionType, string>, []);
  const typeEntries = useMemo(() => {
    const hits = query.trim() ? searchCatalog(query, labels) : Object.values(CATALOG);
    return hits.filter((e) => e.type !== 'custom' && (cat === 'all' || e.category === cat));
  }, [query, cat, labels]);
  const q = query.trim().toLowerCase();
  const templates = project.library.templates.filter((t) => (cat === 'all' || cat === 'custom') && (!q || `${t.name} ${t.description}`.toLowerCase().includes(q)));
  const presets = project.library.presets.filter((p) => (cat === 'all' || cat === 'custom') && (!q || `${p.name} ${labels[p.type]}`.toLowerCase().includes(q)));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of Object.values(CATALOG)) if (e.type !== 'custom') c[e.category] = (c[e.category] ?? 0) + 1;
    c.custom = project.library.templates.length + project.library.presets.length;
    return c;
  }, [project.library]);

  // Resolve the selected entry.
  const preset = entry.kind === 'preset' ? project.library.presets.find((p) => p.id === entry.id) : undefined;
  const tpl = entry.kind === 'template' ? project.library.templates.find((t) => t.id === entry.id) : undefined;
  const type: ConnectionType = entry.kind === 'type' ? entry.type : entry.kind === 'template' ? 'custom' : (preset?.type ?? 'angleCleat');
  const allParams: Record<string, ParamValue> = { ...(preset?.params ?? {}), ...params, ...(tpl ? { template: tpl.id } : {}) };
  const def = CONNECTIONS[type];
  const cat0 = CATALOG[type];
  const specs = specsFor(type, allParams, project).filter((s) => s.kind !== 'template' || type !== 'custom' || !tpl);
  const selTypeConns = selection.connections.map((id) => project.connections[id]).filter((c) => c && c.type === type);
  const choose = (e: Entry) => {
    setEntry(e);
    setParams({});
    setSecProfile('');
    if (on === 'connection') setOn(selection.members.length ? 'members' : 'typical');
  };
  const spec: PreviewSpec = {
    type,
    params: allParams,
    on: on === 'connection' && selTypeConns.length ? 'connection' : on === 'members' && selection.members.length ? 'members' : 'typical',
    memberIds: selection.members,
    connectionId: selTypeConns[0]?.id,
    secondaryProfile: secProfile || undefined,
  };
  const title = tpl ? tpl.name : preset ? preset.name : def.label;

  const applyToMembers = () => {
    let ids: Id[] = [];
    useStore.getState().apply(`Apply ${title}`, (p) => {
      ids = applyConnection(p, selection.members, { type, params: allParams, replace });
    });
    useStore.getState().notify(ids.length ? `Placed ${ids.length} ${title} connection${ids.length === 1 ? '' : 's'}.` : 'No selected member end needed this connection (or they already have one — tick "Replace").');
  };
  const updateConnections = () => {
    useStore.getState().apply(`Update ${title}`, (p) => {
      for (const c of selTypeConns) p.connections[c.id].params = { ...allParams };
    });
    useStore.getState().notify(`Updated ${selTypeConns.length} connection${selTypeConns.length === 1 ? '' : 's'}.`);
  };
  const savePreset = async () => {
    const name = await askText('Name of the new preset', `${title} – custom`, { title: 'Save as preset', ok: 'Save' });
    if (!name?.trim()) return;
    const id = newId('pre');
    useStore.getState().apply('Save preset', (p) => void p.library.presets.push({ id, name: name.trim(), type, params: { ...allParams } }));
    useStore.getState().notify(`Saved preset "${name.trim()}".`);
  };

  const card = (e: Entry, name: string, summary: string, thumb: ReactNode, badge?: string) => (
    <button key={entryKey(e)} type="button" className={`cl-card ${entryKey(e) === entryKey(entry) ? 'on' : ''}`} onClick={() => choose(e)} data-type={e.kind === 'type' ? e.type : undefined}>
      {thumb}
      <span className="cl-card-text">
        <strong>{name}</strong>
        {badge && <span className="badge">{badge}</span>}
        <span className="muted">{summary}</span>
      </span>
    </button>
  );

  return (
    <div className="cl-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeLibrary()}>
      <div className="cl-modal" role="dialog" aria-label="Connection library">
        <header>
          <h2>Connection library</h2>
          <span className="muted">{Object.keys(CONNECTIONS).length - 1} connection types · detailing only — capacity by the engineer of record</span>
          <button className="icon-btn" onClick={closeLibrary} aria-label="Close">
            ×
          </button>
        </header>
        <div className="cl-body">
          <aside className="cl-left">
            <input className="cl-search" placeholder="Search: bracket, slot, clamp, rainscreen…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Search connections" />
            <div className="cl-cats">
              <button type="button" className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>
                All
              </button>
              {CATEGORIES.map((c) => (
                <button key={c.id} type="button" className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)} title={c.description}>
                  {c.label} <span className="muted">{counts[c.id] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="cl-list">
              {CATEGORIES.filter((c) => c.id !== 'custom').map((c) => {
                const list = typeEntries.filter((e) => e.category === c.id);
                if (!list.length) return null;
                return (
                  <div key={c.id} className="cl-group">
                    <h4>{c.label}</h4>
                    {list.map((e) => card({ kind: 'type', type: e.type }, labels[e.type], e.summary, <Thumb thumbKey={`type:${e.type}`} build={() => previewJoint(e.type, {}, { base: project })} />))}
                  </div>
                );
              })}
              {(templates.length > 0 || presets.length > 0 || cat === 'custom') && (
                <div className="cl-group">
                  <h4>Custom templates & presets</h4>
                  {templates.map((t) =>
                    card({ kind: 'template', id: t.id }, t.name, t.description || 'Custom template', <Thumb thumbKey={`tpl:${t.id}:${JSON.stringify(t).length}`} build={() => previewJoint('custom', { template: t.id }, { base: project })} />, 'template'),
                  )}
                  {presets.map((p) =>
                    card({ kind: 'preset', id: p.id }, p.name, `${labels[p.type]} preset`, <Thumb thumbKey={`pre:${p.id}:${JSON.stringify(p.params)}`} build={() => previewJoint(p.type, p.params, { base: project })} />, 'preset'),
                  )}
                  {!templates.length && !presets.length && <p className="muted">No templates or presets yet — save one with "Save as preset", or build a template in Joints → Custom.</p>}
                </div>
              )}
              {!typeEntries.length && !templates.length && !presets.length && <p className="muted">Nothing matches "{query}".</p>}
            </div>
          </aside>
          <section className="cl-right">
            <div className="cl-head">
              <h3>{title}</h3>
              <span className="badge">{CATEGORIES.find((c) => c.id === cat0.category)?.label}</span>
            </div>
            <p>{tpl ? tpl.description || cat0.summary : cat0.summary}</p>
            <div className="cl-facts">
              <div>
                <span className="field-label">Typical use</span>
                {cat0.use}
              </div>
              <div>
                <span className="field-label">Members</span>
                {cat0.members}
              </div>
              <div>
                <span className="field-label">Standards notes</span>
                {cat0.standards}
              </div>
            </div>
            <div className="cl-split">
              <div className="cl-params-col">
                <h4>Parameters</h4>
                <ParamEditor specs={specs} values={allParams} keyParams={cat0.keyParams} onChange={(k, x) => setParams({ ...params, [k]: x })} />
                {Object.keys(params).length > 0 && (
                  <button type="button" className="link-btn" onClick={() => setParams({})}>
                    Reset to defaults
                  </button>
                )}
              </div>
              <div className="cl-preview-col">
                <div className="cl-preview-bar">
                  <span className="field-label">Preview on</span>
                  <select value={spec.on} onChange={(e) => setOn(e.target.value as PreviewSpec['on'])} aria-label="Preview on">
                    <option value="typical">Typical joint</option>
                    <option value="members" disabled={!selection.members.length}>
                      My selected members ({selection.members.length})
                    </option>
                    <option value="connection" disabled={!selTypeConns.length}>
                      My selected connection ({selTypeConns.length})
                    </option>
                  </select>
                  {spec.on === 'typical' && cat0.previewProfiles && (
                    <select value={secProfile} onChange={(e) => setSecProfile(e.target.value)} aria-label="Preview member">
                      <option value="">{cat0.previewProfiles[0]}</option>
                      {cat0.previewProfiles.slice(1).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <ConnectionPreviewView spec={spec} height={340} />
              </div>
            </div>
          </section>
        </div>
        <footer>
          <label className="check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace existing connections on those ends
          </label>
          <div className="btn-row">
            <button className="secondary-btn" onClick={savePreset}>
              Save as preset
            </button>
            {selTypeConns.length > 0 && (
              <button className="secondary-btn" onClick={updateConnections}>
                Update {selTypeConns.length} selected connection{selTypeConns.length === 1 ? '' : 's'}
              </button>
            )}
            <button className="primary-btn" disabled={!selection.members.length || (type === 'custom' && !allParams.template)} onClick={applyToMembers}>
              Apply to {selection.members.length} selected member{selection.members.length === 1 ? '' : 's'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
