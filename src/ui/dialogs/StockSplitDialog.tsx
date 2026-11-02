/**
 * Split at stock length (Modify): members longer than the stock bar of their
 * profile are divided at the transom junction nearest below the limit, with a
 * stack joint above / below the transom or on its centre line. Shows the counts
 * before applying and the planned joints in the 3D view. Core:
 * core/model/stockSplit.ts; actions: ui/stockSplitActions.ts.
 */
import { useEffect, useMemo } from 'react';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, Segmented } from '../widgets';
import { STOCK_JOINT_LABEL, maxPieceFor, stockFor, type StockJointAt } from '../../core/model/stockSplit';
import { closeStockSplit, planCurrentStockSplit, runStockSplit, stockSplitOptions, useStockSplit } from '../stockSplitActions';
import { zoomToMembers } from './SurfacePanel';
import './wireframe.css';

const JOINT_COLOR = 0x2dd4bf;
const ISSUE_COLOR = 0xef4444;
const r0 = (n: number) => Math.round(n).toLocaleString();
const LIST_LIMIT = 50;

export function StockSplitDialog() {
  const ui = useStockSplit();
  const project = useStore((s) => s.project);
  const notify = useStore((s) => s.notify);
  const open = ui.open;
  const { plan, error } = useMemo(() => {
    if (!open) return { plan: null, error: '' };
    try {
      return { plan: planCurrentStockSplit(stockSplitOptions(ui)), error: '' };
    } catch (e) {
      return { plan: null, error: (e as Error).message };
    }
  }, [open, project, ui]);

  // 3D preview: the joints (teal) and the members that cannot be divided (red).
  useEffect(() => {
    if (!open || !plan) return;
    const p = useStore.getState().project;
    const segments: number[] = [];
    const colors: number[] = [];
    const points: number[] = [];
    const pointColors: number[] = [];
    for (const it of plan.items) for (const c of it.cuts) points.push(c.at.x, c.at.y, c.at.z), pointColors.push(JOINT_COLOR);
    for (const u of plan.unresolved) {
      const m = p.members[u.member];
      const a = m && p.nodes[m.start]?.p;
      const b = m && p.nodes[m.end]?.p;
      if (!a || !b) continue;
      segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
      colors.push(ISSUE_COLOR);
    }
    useStore.getState().set({ wireOverlay: { segments, colors, points, pointColors } });
  }, [open, plan]);
  useEffect(() => () => useStore.getState().set({ wireOverlay: null }), []);
  if (!open) return null;

  const set = (patch: Partial<typeof ui>) => useStockSplit.setState(patch);
  const p = project;
  const mullions = Object.values(p.members).filter((m) => m.role === 'mullion').length;
  const selected = ui.members?.filter((id) => p.members[id]).length ?? 0;
  // Stock per profile of the members checked.
  const checked = (ui.members ?? Object.values(p.members).filter((m) => m.role === 'mullion').map((m) => m.id)).map((id) => p.members[id]).filter(Boolean);
  const profiles = [...new Set(checked.map((m) => `${m.profile ?? ''}|${m.material}`))].filter((k) => !k.startsWith('|')).slice(0, 4);
  const gapDefault = p.wireframe.settings.stackJointSize ?? 30;
  const apply = () => {
    try {
      const r = runStockSplit(stockSplitOptions(ui));
      if (r.plan.items.length) closeStockSplit();
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };
  const c = plan?.counts;
  return (
    <Modal
      title="Split at stock length"
      docked
      onClose={closeStockSplit}
      footer={
        <div className="btn-row wf-buttons">
          <button className="secondary-btn" onClick={closeStockSplit}>
            Cancel
          </button>
          <button className="primary-btn" disabled={!plan?.items.length} onClick={apply} data-testid="stock-split-apply">
            Split {plan?.counts.members ?? 0} member{plan?.counts.members === 1 ? '' : 's'}
          </button>
        </div>
      }
    >
      <p className="muted">
        Members longer than the stock bar of their profile are divided into pieces that fit, each cut at the transom junction nearest below the limit
        (from the lower end), as a stack joint. One undo step; run Auto-connect afterwards to splice the new joints.
      </p>
      <Field label="Members">
        <Segmented<'sel' | 'all'>
          value={ui.members ? 'sel' : 'all'}
          options={[
            ...(ui.members || useStore.getState().selection.members.length ? [{ value: 'sel' as const, label: `Selection (${selected || useStore.getState().selection.members.length})` }] : []),
            { value: 'all', label: `Every mullion (${mullions})` },
          ]}
          onChange={(v) => set({ members: v === 'all' ? null : useStore.getState().selection.members.filter((id) => p.members[id]) })}
        />
      </Field>
      <Field label="Stock length" hint={ui.length ? 'Bar length for every member' : "The longest bar for each member's profile: stock on hand (Project settings), else the standard stock lengths"}>
        <div className="row2">
          <Segmented<'auto' | 'given'>
            value={ui.length ? 'given' : 'auto'}
            options={[
              { value: 'auto', label: 'By profile' },
              { value: 'given', label: 'Length' },
            ]}
            onChange={(v) => set({ length: v === 'auto' ? null : Math.max(...p.settings.stockLengths, 6000) })}
          />
          {ui.length !== null && <NumberInput value={ui.length} unit="mm" min={1} onChange={(v) => set({ length: v })} />}
        </div>
      </Field>
      {!ui.length && profiles.length > 0 && (
        <ul className="muted ss-stock">
          {profiles.map((k) => {
            const [profile, material] = k.split('|');
            const s = stockFor(p, profile, material);
            return (
              <li key={k}>
                {profile}: {s ? `${r0(s.length)} mm bar (${s.source}) → pieces up to ${r0(maxPieceFor(p, s.length))} mm` : 'no stock length'}
              </li>
            );
          })}
          <li>
            End trims 2 × {r0(p.settings.endTrim)} mm and kerf {r0(p.settings.kerf)} mm come off each bar.
          </li>
        </ul>
      )}
      <Field label="Joint at the transom">
        <Segmented<StockJointAt>
          value={ui.at}
          options={[
            { value: 'top', label: 'Above', title: `Joint ${STOCK_JOINT_LABEL.top}: the transom stays on the piece below` },
            { value: 'bottom', label: 'Below', title: `Joint ${STOCK_JOINT_LABEL.bottom}: the transom stays on the piece above` },
            { value: 'centre', label: 'Centre line', title: `Joint ${STOCK_JOINT_LABEL.centre}: the transom ends move half the gap down onto the piece below` },
          ]}
          onChange={(at) => set({ at })}
        />
      </Field>
      <div className="row2">
        <Field label="Gap" hint={`Stack-joint gap (project: ${r0(gapDefault)} mm, Wireframe check → Rules)`}>
          <NumberInput value={ui.gap ?? gapDefault} unit="mm" min={0} onChange={(v) => set({ gap: v })} />
        </Field>
        <Field label="Clearance" hint="Above / below: between the transom (and its cleats) and the joint. About 100 mm keeps sleeve bolts clear of the cleat bolts.">
          <NumberInput value={ui.clearance} unit="mm" min={0} onChange={(v) => set({ clearance: v })} />
        </Field>
      </div>
      {error && <p className="warning">{error}</p>}
      {plan && c && (
        <>
          <table className="wf-summary" data-testid="stock-split-summary">
            <tbody>
              <tr>
                <td>Members checked</td>
                <td>{c.checked.toLocaleString()}</td>
              </tr>
              <tr className={c.over ? 'diff' : ''}>
                <td>Longer than the stock</td>
                <td>{c.over.toLocaleString()}</td>
              </tr>
              <tr className={c.members ? 'diff' : ''}>
                <td>Divided at transoms</td>
                <td>
                  {c.members.toLocaleString()} → {c.pieces.toLocaleString()} pieces
                </td>
              </tr>
              <tr className={c.unresolved ? 'diff' : ''}>
                <td>Left as they are (no transom in range)</td>
                <td>{c.unresolved.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          {plan.warnings.map((w) => (
            <p key={w} className="warning">
              {w}
            </p>
          ))}
          {plan.skipped.length > 0 && <p className="muted">{plan.skipped.length} selected member{plan.skipped.length === 1 ? ' is' : 's are'} not checked: {plan.skipped[0].reason}.</p>}
          {plan.unresolved.length > 0 && (
            <section className="wf-group review">
              <header>
                <span className="wf-dot" />
                <span className="wf-toggle">Not divided</span>
                <span className="wf-count">{plan.unresolved.length}</span>
                <button className="link-btn small" onClick={() => zoomToMembers(plan.unresolved.map((u) => u.member))}>
                  Show
                </button>
              </header>
              <ul>
                {plan.unresolved.slice(0, LIST_LIMIT).map((u) => (
                  <li key={u.member} className="info">
                    <span className="wf-dot" />
                    <span className="wf-text">
                      {r0(u.length)} mm (pieces up to {r0(u.maxPiece)} mm): {u.reason}.
                    </span>
                    <button className="icon-btn wf-zoom" title="Select and zoom to" aria-label="Zoom to" onClick={() => zoomToMembers([u.member], u.at)}>
                      ⌖
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {plan.items.length > 0 && (
            <section className="wf-group">
              <header>
                <span className="wf-dot" />
                <span className="wf-toggle">To divide</span>
                <span className="wf-count">{plan.items.length}</span>
                <button className="link-btn small" onClick={() => zoomToMembers(plan.items.map((i) => i.member))}>
                  Show
                </button>
              </header>
              <ul>
                {plan.items.slice(0, LIST_LIMIT).map((it) => (
                  <li key={it.member}>
                    <span className="wf-dot" />
                    <span className="wf-text">
                      {it.profile || 'Line'} {r0(it.length)} mm → {it.pieces.map(r0).join(' + ')} mm ({r0(it.stock)} mm {it.source} bar)
                    </span>
                    <button className="icon-btn wf-zoom" title="Select and zoom to" aria-label="Zoom to" onClick={() => zoomToMembers([it.member], it.cuts[0]?.at)}>
                      ⌖
                    </button>
                  </li>
                ))}
                {plan.items.length > LIST_LIMIT && <li className="info muted">… and {(plan.items.length - LIST_LIMIT).toLocaleString()} more</li>}
              </ul>
            </section>
          )}
          <p className="muted wf-legend">
            3D preview: <span style={{ color: '#2dd4bf' }}>● joint</span> · <span style={{ color: '#ef4444' }}>not divided</span>
          </p>
        </>
      )}
    </Modal>
  );
}
