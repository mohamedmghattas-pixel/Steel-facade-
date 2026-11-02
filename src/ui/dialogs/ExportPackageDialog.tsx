/**
 * Export → Export package…: package fields, template picker and editor (folder
 * tree, items, file-name patterns with a live path preview), item checklist with
 * counts and sizes, and the two ways to write the package (folder / ZIP).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../../state/store';
import { download, pickFile } from '../../state/storage';
import { Modal } from '../widgets';
import { Icon } from '../icons';
import { askConfirm } from '../askState';
import { OUTPUTS, TOKEN_HELP, TOKENS, outputMeta, type OutputCategory } from '../../core/export/catalog';
import {
  activeExportTemplate,
  addFolder,
  addItem,
  copyTemplate,
  expandPattern,
  exportTemplates,
  findFolder,
  isBuiltinTemplate,
  moveFolderBy,
  moveFolderTo,
  moveItemTo,
  packageSettings,
  parseTemplateJson,
  removeFolder,
  removeItem,
  renameFolder,
  sanitizePath,
  templateIssues,
  templateToJson,
  updateItem,
  walkFolders,
} from '../../core/export/template';
import { DRAWING_GROUP_LABEL, formatBytes, packageTree, planPaths, type PackagePlan } from '../../core/export/package';
import { DRAWING_GROUPS, type DrawingGroup, type ExportTemplate, type OutputId } from '../../core/export/types';
import {
  canExportToFolder,
  cancelExportPackage,
  deleteExportTemplate,
  outlineCurrentPackage,
  planCurrentPackage,
  type PackageOutline,
  runExportPackage,
  saveExportTemplate,
  setActiveExportTemplate,
  useExportPackage,
} from '../exportPackageActions';
import { QaFormsTab } from './QaFormsTab';
import './exportPackage.css';

type Tab = 'items' | 'template' | 'tree' | 'forms';

/** Text input that reports every keystroke (live preview) and keeps keys away from the app shortcuts. */
function LiveInput({ value, onChange, placeholder, mono, label }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; label?: string }) {
  return (
    <input
      type="text"
      className={`xp-input ${mono ? 'mono' : ''}`}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

const size = (n: number, exact: boolean) => (n ? `${exact ? '' : '≈ '}${formatBytes(n)}` : '');

/**
 * Up to this many parts the package is planned as the dialog opens and on every change (live sizes); larger
 * models plan it on "Calculate sizes" (the drawing set and the cheap outputs take seconds there).
 */
const LIVE_PLAN_PARTS = 300;

/** The plan for the inputs it was made from: fresh while the project, template, fields and choices are the same. */
interface Planned {
  plan: PackagePlan;
  inputs: unknown[];
}

export function ExportPackageDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const notify = useStore((s) => s.notify);
  const running = useExportPackage((s) => s.running);
  const progress = useExportPackage((s) => s.progress);
  const [initial] = useState(() => packageSettings(project));
  const [code, setCode] = useState(initial.code);
  const [seq, setSeq] = useState(String(initial.seq));
  const [rev, setRev] = useState(initial.rev ?? '');
  const [skip, setSkip] = useState<Set<string>>(() => new Set(initial.skip ?? []));
  const [tpl, setTpl] = useState<ExportTemplate>(() => activeExportTemplate(project));
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>('items');
  const [sel, setSel] = useState('root');
  const [tokensOpen, setTokensOpen] = useState(false);

  const seqNum = Math.max(0, Math.floor(Number(seq) || 0));
  const settings = useMemo(() => ({ code, seq: seqNum, rev: rev.trim() }), [code, seqNum, rev]);
  // Opening is instant at any size: the outline (items, folders, tokens, model counts) needs no drawing set.
  const outline = useMemo(() => outlineCurrentPackage({ template: tpl, settings, skip: [...skip] }), [project, tpl, settings, skip]);
  const inputs = [project, tpl, settings, skip];
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [calculating, setCalculating] = useState(false);
  const plan = planned && planned.inputs.every((x, i) => x === inputs[i]) ? planned.plan : null;
  const live = outline.counts.parts <= LIVE_PLAN_PARTS;
  const calculate = () => {
    setCalculating(true);
    const req = { template: tpl, settings, skip: [...skip] };
    const at = [...inputs];
    // A tick first, so the busy state shows before the drawing set and the outputs are planned.
    setTimeout(() => {
      try {
        setPlanned({ plan: planCurrentPackage(req), inputs: at });
      } catch (e) {
        notify(`Could not plan the package: ${(e as Error).message}`, 'error');
      } finally {
        setCalculating(false);
      }
    }, 20);
  };
  useEffect(() => {
    if (live && !plan && !calculating) setPlanned({ plan: planCurrentPackage({ template: tpl, settings, skip: [...skip] }), inputs: [project, tpl, settings, skip] });
  }, [live, project, tpl, settings, skip]);
  const issues = useMemo(() => templateIssues(tpl), [tpl]);
  const builtin = isBuiltinTemplate(tpl.id);
  const stored = exportTemplates(project);
  const listed = stored.some((t) => t.id === tpl.id) ? stored : [...stored, tpl];

  /** Edit the draft; the built-in template is copied on the first edit. */
  const editTpl = (fn: (t: ExportTemplate) => ExportTemplate) => {
    const base = builtin ? copyTemplate(tpl, `${tpl.name} (copy)`) : tpl;
    setTpl(fn(base));
    setDirty(true);
  };

  const pickTemplate = async (id: string) => {
    if (id === tpl.id) return;
    if (dirty && !(await askConfirm(`Discard the unsaved changes to "${tpl.name}"?`, { title: 'Export template', ok: 'Discard' }))) return;
    const t = stored.find((x) => x.id === id);
    if (!t) return;
    setTpl(t);
    setDirty(false);
    setSel('root');
    setActiveExportTemplate(t.id);
  };

  const importJson = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const { template, warnings } = parseTemplateJson(await f.text());
      saveExportTemplate(template);
      setTpl(template);
      setDirty(false);
      setSel('root');
      notify(`Imported the export template "${template.name}".${warnings.length ? ` ${warnings.length} note(s): ${warnings[0]}` : ''}`);
    } catch (e) {
      notify(`Could not import the template: ${(e as Error).message}`, 'error');
    }
  };

  const save = () => {
    saveExportTemplate(tpl);
    setDirty(false);
    notify(`Saved the export template "${tpl.name}" in the project.`);
  };

  const run = async (target: 'zip' | 'folder') => {
    try {
      const out = await runExportPackage(target, { template: tpl, settings, skip: [...skip] });
      if (out.aborted) return;
      setDirty(false);
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };

  const toggle = (id: string) => {
    const next = new Set(skip);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSkip(next);
  };

  const errors = issues.filter((i) => i.level === 'error');
  const files = plan ? plan.files.length + 1 : 0;
  const c = outline.counts;
  const calcBtn = (
    <button className="secondary-btn" data-testid="xp-calculate" disabled={calculating} onClick={calculate} title="Plan every file of the package: the drawing set, file names and sizes">
      {calculating ? 'Calculating…' : planned ? 'Recalculate sizes' : 'Calculate sizes'}
    </button>
  );

  return (
    <Modal
      title="Export package"
      wide
      onClose={onClose}
      footer={
        running && progress ? (
          <>
            <div className="xp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <div className="xp-bar">
                <span style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
              </div>
              <span className="muted xp-progress-text">
                {progress.done} / {progress.total} · {progress.path}
                {progress.pages ? ` · page ${progress.page} of ${progress.pages}` : ''}
              </span>
            </div>
            <button className="secondary-btn" onClick={cancelExportPackage}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="muted" data-testid="xp-summary">
              {plan ? `${files} files · ${size(plan.size, false)}` : `${outline.items.length} items · sizes not calculated`}
              {errors.length ? <span className="xp-err"> · {errors[0].text}</span> : null}
            </span>
            <span className="row-inline">
              {!plan && calcBtn}
              {canExportToFolder() && (
                <button className="secondary-btn" disabled={!!errors.length || (!!plan && !plan.files.length)} onClick={() => void run('folder')} title="Write the folder tree into a folder you choose (Chrome / Edge)">
                  <Icon name="file" size={15} /> Export to folder…
                </button>
              )}
              <button className="primary-btn" disabled={!!errors.length || (!!plan && !plan.files.length)} onClick={() => void run('zip')} title="One ZIP with the whole package folder">
                <Icon name="export" size={15} /> Download ZIP
              </button>
            </span>
          </>
        )
      }
    >
      <div className="xp">
        <div className="xp-fields">
          <label className="field">
            <span className="field-label">Package code</span>
            <LiveInput value={code} onChange={setCode} placeholder="FWR" label="Package code" />
          </label>
          <label className="field">
            <span className="field-label">Sequence</span>
            <LiveInput value={seq} onChange={(v) => setSeq(v.replace(/[^0-9]/g, ''))} placeholder="1" label="Sequence" />
            <span className="field-hint">{outline.tokens.seq}</span>
          </label>
          <label className="field">
            <span className="field-label">Revision</span>
            <LiveInput value={rev} onChange={setRev} placeholder={plan?.ctx.autoRev ?? outline.autoRev} label="Revision" />
            <span className="field-hint">{rev.trim() ? 'Set by hand' : `From the drawing revisions: ${plan?.ctx.autoRev ?? outline.autoRev}`}</span>
          </label>
          <label className="field xp-tpl-pick">
            <span className="field-label">Template</span>
            <span className="row-inline">
              <select value={tpl.id} onChange={(e) => void pickTemplate(e.target.value)} aria-label="Export template">
                {listed.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {isBuiltinTemplate(t.id) ? ' (built-in)' : ''}
                    {t.id === tpl.id && dirty ? ' *' : ''}
                  </option>
                ))}
              </select>
              <button className="icon-btn" title="Import a template (JSON)" onClick={() => void importJson()}>
                <Icon name="import" size={15} />
              </button>
              <button className="icon-btn" title="Export this template (JSON) to share it" onClick={() => download(`${tpl.name.replace(/[^\w.-]+/g, '_')}.export-template.json`, templateToJson(tpl), 'application/json')}>
                <Icon name="export" size={15} />
              </button>
            </span>
          </label>
        </div>
        <div className="xp-root">
          Package folder <code>{outline.root}</code>
          <span className="muted xp-counts" data-testid="xp-counts">
            {c.members.toLocaleString()} wire lines · {c.parts.toLocaleString()} parts ({c.partMarks.toLocaleString()} marks) · {c.assemblies.toLocaleString()} assemblies (
            {c.assemblyMarks.toLocaleString()} marks) · {c.drawings === null ? 'drawing set made when you calculate sizes or export' : `${c.drawings.toLocaleString()} drawing sheets`}
          </span>
          {plan && plan.warnings.length > 0 && (
            <span className="xp-warn" title={plan.warnings.join('\n')}>
              <Icon name="warn" size={13} /> {plan.warnings.length} warning{plan.warnings.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="tabs xp-tabs">
          <button className={tab === 'items' ? 'on' : ''} onClick={() => setTab('items')}>
            Items
          </button>
          <button className={tab === 'template' ? 'on' : ''} onClick={() => setTab('template')}>
            Template{dirty ? ' *' : ''}
          </button>
          <button className={tab === 'tree' ? 'on' : ''} onClick={() => setTab('tree')}>
            Folder tree
          </button>
          <button className={tab === 'forms' ? 'on' : ''} onClick={() => setTab('forms')}>
            QA forms
          </button>
        </div>

        {!plan && tab !== 'template' && (
          <div className="xp-calc" data-testid="xp-calc-bar">
            <span className="muted">
              {calculating
                ? 'Planning the package: drawing set, file names and sizes…'
                : planned
                  ? 'The sizes are out of date (the template, the fields or the model changed).'
                  : `Files and sizes are not calculated yet: planning makes the drawing set${c.parts ? ` of ${c.parts.toLocaleString()} parts` : ''}, which takes a while on large models. The export plans them anyway.`}
            </span>
            {calcBtn}
          </div>
        )}
        {tab === 'items' && <ItemsTab outline={outline} plan={plan} skip={skip} toggle={toggle} setSkip={setSkip} />}
        {tab === 'template' && (
          <TemplateTab
            tpl={tpl}
            plan={plan}
            outline={outline}
            sel={sel}
            setSel={setSel}
            edit={editTpl}
            builtin={builtin}
            dirty={dirty}
            issues={issues}
            save={save}
            rename={(name) => editTpl((t) => ({ ...t, name }))}
            remove={async () => {
              if (!(await askConfirm(`Delete the export template "${tpl.name}"?`, { title: 'Delete template', ok: 'Delete' }))) return;
              if (stored.some((t) => t.id === tpl.id)) deleteExportTemplate(tpl.id);
              setTpl(activeExportTemplate({ ...project, activeExportTemplate: undefined }));
              setDirty(false);
              setSel('root');
            }}
            tokensOpen={tokensOpen}
            setTokensOpen={setTokensOpen}
          />
        )}
        {tab === 'tree' && plan && <TreeTab plan={plan} />}
        {tab === 'forms' && plan && <QaFormsTab plan={plan} />}
        {plan && plan.warnings.length > 0 && tab !== 'template' && (
          <ul className="xp-warnings">
            {plan.warnings.slice(0, 5).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ItemsTab({ outline, plan, skip, toggle, setSkip }: { outline: PackageOutline; plan: PackagePlan | null; skip: Set<string>; toggle: (id: string) => void; setSkip: (s: Set<string>) => void }) {
  const all = outline.items.map((i) => i.item.id);
  return (
    <div className="xp-items">
      <div className="xp-items-bar">
        <button className="link-btn" onClick={() => setSkip(new Set())}>
          All
        </button>
        <button className="link-btn" onClick={() => setSkip(new Set(all))}>
          None
        </button>
        <span className="muted">Unchecked items are left out and listed in README.txt. Items with nothing to export are skipped with the reason.</span>
      </div>
      <table className="xp-table">
        <thead>
          <tr>
            <th />
            <th>Item</th>
            <th>Folder</th>
            <th className="num">Files</th>
            <th className="num">Size</th>
          </tr>
        </thead>
        <tbody>
          {outline.items.map(({ item, folder }) => {
            const m = outputMeta(item.output);
            const on = !skip.has(item.id);
            const ip = plan?.items.find((x) => x.item.id === item.id);
            return (
              <tr key={item.id} className={ip?.skip || !on ? 'off' : ''}>
                <td>
                  <input type="checkbox" checked={on} onChange={() => toggle(item.id)} aria-label={`Include ${m.label}`} />
                </td>
                <td>
                  {m.label} <span className="muted">{m.format}</span>
                  {item.drawings?.length ? <span className="muted"> · {item.drawings.map((g) => DRAWING_GROUP_LABEL[g]).join(', ')}</span> : null}
                  {ip?.skip && <div className="xp-skip">Skipped: {ip.skip}</div>}
                </td>
                <td className="mono xp-folder">{folder || '(package folder)'}</td>
                <td className="num">{!on || ip?.skip ? '–' : ip ? ip.files.length : '…'}</td>
                <td className="num">{!on || ip?.off || ip?.skip ? '' : ip ? size(ip.size, ip.exact) : ''}</td>
              </tr>
            );
          })}
          <tr className="xp-total">
            <td />
            <td>README.txt (manifest: every file, its source and revision; skipped items; errors)</td>
            <td className="mono xp-folder">(package folder)</td>
            <td className="num">1</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TreeTab({ plan }: { plan: PackagePlan }) {
  const text = useMemo(() => packageTree(plan.root, planPaths(plan), plan.folders), [plan]);
  const lines = text.split('\n');
  const MAX = 600;
  return (
    <div className="xp-tree">
      <p className="muted">The package as Windows <code>tree /F</code> lists it — compare it with a reference folder.</p>
      <pre>{lines.length > MAX ? `${lines.slice(0, MAX).join('\n')}\n… ${lines.length - MAX} more lines` : text}</pre>
      <button className="secondary-btn" onClick={() => void navigator.clipboard?.writeText(text)}>
        Copy tree
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

const CATEGORIES: OutputCategory[] = ['Drawings', 'Models', 'Project', 'Fabrication', 'Lists', 'Site', 'Coordination', 'Records'];

function TemplateTab(props: {
  tpl: ExportTemplate;
  plan: PackagePlan | null;
  outline: PackageOutline;
  sel: string;
  setSel: (id: string) => void;
  edit: (fn: (t: ExportTemplate) => ExportTemplate) => void;
  builtin: boolean;
  dirty: boolean;
  issues: ReturnType<typeof templateIssues>;
  save: () => void;
  rename: (name: string) => void;
  remove: () => void;
  tokensOpen: boolean;
  setTokensOpen: (v: boolean) => void;
}) {
  const { tpl, plan, outline, sel, setSel, edit, builtin, dirty, issues } = props;
  const folders = walkFolders(tpl);
  const folder = findFolder(tpl, sel) ?? tpl.root;
  const isRoot = folder.id === tpl.root.id;
  /** The folder's path in this package (tokens expanded, names made safe). */
  const pathOf = (id: string) => {
    const e = folders.find((x) => x.folder.id === id);
    return e && e.depth ? sanitizePath(e.path.map((n) => expandPattern(n, outline.tokens).text).join('/')) : '';
  };
  const issueFor = (id: string) => issues.filter((i) => i.id === id);
  // A folder cannot move into itself or its own sub-folders.
  const inside = new Set(walkFolders({ ...tpl, root: folder }).map((e) => e.folder.id));
  const parentId = folders.find((x) => x.folder.id === folder.id)?.parent?.id;
  // Item ids stay when the built-in template is copied, so the selection survives the first edit.
  const editSel = (fn: (t: ExportTemplate, id: string) => ExportTemplate) => edit((t) => fn(t, findFolder(t, sel) ? sel : t.root.id));

  return (
    <div className="xp-editor">
      <div className="xp-editor-head">
        <label className="field">
          <span className="field-label">Template name</span>
          <LiveInput value={tpl.name} onChange={props.rename} label="Template name" />
        </label>
        <span className="row-inline">
          {builtin ? (
            <span className="muted">Built-in — your first change makes a copy in this project.</span>
          ) : (
            <>
              <button className="primary-btn" disabled={!dirty} onClick={props.save}>
                Save template
              </button>
              <button className="secondary-btn" onClick={() => void props.remove()}>
                <Icon name="trash" size={14} /> Delete
              </button>
            </>
          )}
        </span>
      </div>
      <div className="xp-editor-body">
        <div className="xp-folders">
          <ul role="tree">
            {folders.map((e) => (
              <li key={e.folder.id} role="treeitem" aria-selected={e.folder.id === folder.id}>
                <button className={e.folder.id === folder.id ? 'on' : ''} style={{ paddingLeft: 6 + e.depth * 14 }} onClick={() => setSel(e.folder.id)} title={e.depth ? e.path.join('/') : 'Package folder'}>
                  <span className="xp-fname">{e.depth ? e.folder.name : `${e.folder.name}`}</span>
                  <span className="muted">{e.folder.items.length || ''}</span>
                  {issueFor(e.folder.id).length + e.folder.items.reduce((s, it) => s + issueFor(it.id).length, 0) > 0 && <Icon name="warn" size={12} />}
                </button>
              </li>
            ))}
          </ul>
          <div className="xp-folder-btns">
            <button
              className="secondary-btn"
              title="New folder inside the selected one"
              onClick={() => {
                let id = '';
                editSel((t, parent) => {
                  const r = addFolder(t, parent);
                  id = r.id;
                  return r.template;
                });
                if (id) setSel(id);
              }}
            >
              <Icon name="plus" size={13} /> Folder
            </button>
            <button className="icon-btn" title="Move up" disabled={isRoot} onClick={() => editSel((t, id) => moveFolderBy(t, id, -1))}>
              ↑
            </button>
            <button className="icon-btn" title="Move down" disabled={isRoot} onClick={() => editSel((t, id) => moveFolderBy(t, id, 1))}>
              ↓
            </button>
            <button
              className="icon-btn"
              title="Delete folder (with its items)"
              disabled={isRoot}
              onClick={() => {
                const parent = folders.find((x) => x.folder.id === folder.id)?.parent;
                editSel((t, id) => removeFolder(t, id));
                setSel(parent?.id ?? 'root');
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>

        <div className="xp-folder-edit">
          <label className="field">
            <span className="field-label">{isRoot ? 'Package folder name' : 'Folder name'}</span>
            <LiveInput value={folder.name} mono onChange={(v) => editSel((t, id) => renameFolder(t, id, v))} label="Folder name" />
            <span className="field-hint">→ {isRoot ? outline.root : `${outline.root}/${pathOf(folder.id)}`}</span>
          </label>
          {!isRoot && (
            <label className="field">
              <span className="field-label">Move into</span>
              <select value="" onChange={(e) => e.target.value && editSel((t, id) => moveFolderTo(t, id, e.target.value))} aria-label="Move folder into">
                <option value="">Choose a folder…</option>
                {folders
                  .filter((x) => !inside.has(x.folder.id) && x.folder.id !== parentId)
                  .map((x) => (
                    <option key={x.folder.id} value={x.folder.id}>
                      {x.depth ? x.path.join(' / ') : 'Package folder'}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {issueFor(folder.id).map((i) => (
            <p key={i.text} className={i.level === 'error' ? 'xp-err' : 'xp-warn'}>
              {i.text}
            </p>
          ))}

          <h4>Items in this folder</h4>
          {!folder.items.length && <p className="muted">No items — add an output below.</p>}
          {folder.items.map((it) => {
            const m = outputMeta(it.output);
            const ip = plan?.items.find((x) => x.item.id === it.id);
            return (
              <div className="xp-item" key={it.id}>
                <div className="xp-item-head">
                  <strong>{m.label}</strong> <span className="muted">{m.format}</span>
                  <span className="grow" />
                  <select value={folder.id} onChange={(e) => edit((t) => moveItemTo(t, it.id, e.target.value))} aria-label="Move item to folder" title="Move to folder">
                    {folders.map((x) => (
                      <option key={x.folder.id} value={x.folder.id}>
                        {x.depth ? x.path.join(' / ') : 'Package folder'}
                      </option>
                    ))}
                  </select>
                  <button className="icon-btn" title="Remove item" onClick={() => edit((t) => removeItem(t, it.id))}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
                <LiveInput value={it.pattern} mono onChange={(v) => edit((t) => updateItem(t, it.id, { pattern: v }))} label={`${m.label} file name`} />
                {m.drawings && (
                  <div className="chips xp-groups">
                    {DRAWING_GROUPS.map((g) => {
                      const on = it.drawings?.includes(g) ?? false;
                      return (
                        <button
                          key={g}
                          className={`chip ${on ? 'on' : ''}`}
                          onClick={() => {
                            const cur = new Set<DrawingGroup>(it.drawings ?? []);
                            if (on) cur.delete(g);
                            else cur.add(g);
                            edit((t) => updateItem(t, it.id, { drawings: DRAWING_GROUPS.filter((x) => cur.has(x)) }));
                          }}
                        >
                          {DRAWING_GROUP_LABEL[g]}
                        </button>
                      );
                    })}
                    <span className="muted">{it.drawings?.length ? '' : 'all sheets'}</span>
                  </div>
                )}
                {issueFor(it.id).map((i) => (
                  <p key={i.text} className={i.level === 'error' ? 'xp-err' : 'xp-warn'}>
                    {i.text}
                  </p>
                ))}
                <ul className="xp-paths">
                  {!plan && <li className="muted">The file names show once the sizes are calculated.</li>}
                  {ip?.skip && <li className="muted">Skipped for this project: {ip.skip}</li>}
                  {ip?.files.slice(0, 3).map((f) => (
                    <li key={f.path} className="mono">
                      {f.path}
                    </li>
                  ))}
                  {ip && ip.files.length > 3 && <li className="muted">… {ip.files.length - 3} more</li>}
                </ul>
              </div>
            );
          })}
          <label className="field">
            <span className="field-label">Add an output to this folder</span>
            <select
              value=""
              aria-label="Add output"
              onChange={(e) => {
                const v = e.target.value as OutputId;
                if (v) editSel((t, id) => addItem(t, id, v).template);
              }}
            >
              <option value="">Choose…</option>
              {CATEGORIES.map((c) => (
                <optgroup key={c} label={c}>
                  {OUTPUTS.filter((o) => o.category === c).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} ({o.format})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <TokenHelp open={props.tokensOpen} setOpen={props.setTokensOpen} />
        </div>
      </div>
    </div>
  );
}

function TokenHelp({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }): ReactNode {
  return (
    <div className="xp-tokens">
      <button className="link-btn" onClick={() => setOpen(!open)}>
        {open ? 'Hide tokens' : 'Tokens for names…'}
      </button>
      {open && (
        <>
          <p className="muted">
            Use them in folder and file names. An empty token takes one neighbouring <code>-</code>, <code>_</code> or space with it. <code>/</code> makes sub-folders. Characters Windows does
            not allow (<code>{'<>:"/\\|?*'}</code>) are replaced by <code>_</code>; the extension is added when the name has none.
          </p>
          <table className="xp-token-table">
            <tbody>
              {TOKENS.map((t) => (
                <tr key={t}>
                  <td className="mono">{`{${t}}`}</td>
                  <td>{TOKEN_HELP[t]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
