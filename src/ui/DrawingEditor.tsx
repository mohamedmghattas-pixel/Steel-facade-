/**
 * Interactive drawing editor (Drawings tab): the sheet preview with an overlay
 * for picking and dragging generated items (views, tables, dimension lines),
 * adding notes, leader notes and revision clouds, and placing section cuts and
 * detail callouts on GA sheets. Every change is one undoable `apply`.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useStore } from '../state/store';
import type { Drawing, Viewport } from '../core/drawings/types';
import type { GaCut, Vec2, Vec3 } from '../core/model/types';
import { drawingToSvg, entitiesToSvg } from '../core/drawings/render';
import {
  addCloud,
  addNote,
  hideItem,
  itemBox,
  itemEntities,
  moveGroup,
  moveMarkup,
  offsetDim,
  pickEntity,
  rectPts,
  resetEdits,
  unhideItem,
  type PickHit,
} from '../core/drawings/edits';
import { GA_AXES, nextCutLetter } from '../core/drawings/cuts';
import { nextRev } from '../core/drawings/register';
import { newId } from '../core/model/ops';
import { askConfirm, askText } from './askState';
import { Icon } from './icons';

type Tool = 'select' | 'note' | 'leader' | 'cloud' | 'section' | 'detail';

const HINT: Record<Tool, string> = {
  select: 'Click to select; drag a view, table or dimension line to move it (1 mm steps, Esc cancels). Delete hides the selected item.',
  note: 'Click where the note should start.',
  leader: 'Click the feature the leader points at, then where the note goes.',
  cloud: 'Drag a rectangle around the change.',
  section: 'Click the two ends of the cut line on the GA view (the section looks to the right of the line, from first to second point).',
  detail: 'Click the centre of the detail, then a point on its circle.',
};

const KIND_TEXT: Record<PickHit['kind'], string> = { dim: 'Dimension', note: 'Note', cloud: 'Revision cloud', item: 'Item', group: 'View / block' };

const snap = (v: number) => Math.round(v);

export function DrawingEditor({ drawing: d, onCuts }: { drawing: Drawing; onCuts?: () => void }) {
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const project = useStore((s) => s.project);
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<PickHit | null>(null);
  const [drag, setDrag] = useState<{ start: Vec2; delta: Vec2; hit: PickHit; mode: 'dim' | 'markup' | 'group' } | null>(null);
  const [pending, setPending] = useState<Vec2[]>([]);
  const [hover, setHover] = useState<Vec2 | null>(null);
  const [zoom, setZoom] = useState(1);
  const overlay = useRef<SVGSVGElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const svg = useMemo(() => drawingToSvg(d), [d]);
  const H = d.sheet.h;
  const isGa = d.kind === 'ga';
  const vp: Viewport | undefined = d.viewports?.[0];
  const hidden = project.drawings.edits?.[d.id]?.hidden ?? [];

  // A different sheet: drop the selection and any half-done input.
  useEffect(() => {
    setSel(null);
    setDrag(null);
    setPending([]);
    if (!isGa && (tool === 'section' || tool === 'detail')) setTool('select');
  }, [d.id, isGa, tool]);

  const toPaper = (e: { clientX: number; clientY: number }): Vec2 | null => {
    const svgEl = overlay.current;
    const m = svgEl?.getScreenCTM();
    if (!svgEl || !m) return null;
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const q = pt.matrixTransform(m.inverse());
    return { x: q.x, y: H - q.y };
  };
  const tol = () => {
    const w = overlay.current?.getBoundingClientRect().width ?? 1000;
    return Math.max(0.8, (7 * d.sheet.w) / w);
  };

  const commit = (label: string, fn: Parameters<typeof apply>[1]) => apply(`Drawing ${d.number}: ${label}`, fn);

  const toModel = (q: Vec2): Vec3 | null => {
    if (!vp) return null;
    const m = { x: (q.x - vp.origin.x) * vp.den, y: (q.y - vp.origin.y) * vp.den };
    const ax = GA_AXES[vp.view];
    return { x: ax.R.x * m.x + ax.U.x * m.y, y: ax.R.y * m.x + ax.U.y * m.y, z: ax.R.z * m.x + ax.U.z * m.y };
  };

  const finishTwoPoint = async (a: Vec2, b: Vec2) => {
    setPending([]);
    if (tool === 'leader') {
      const text = await askText('Note text', '', { title: 'Leader note', ok: 'Add note' });
      if (!text?.trim()) return;
      commit('add leader note', (p) => void addNote(p, d.id, { p: b, text: text.trim(), leader: a }));
      return;
    }
    const A = toModel(a);
    const B = toModel(b);
    if (!A || !B || !vp) return;
    const name = nextCutLetter(project);
    if (tool === 'section') {
      if (Math.hypot(b.x - a.x, b.y - a.y) < 3) return notify('The cut line is too short.', 'error');
      const cut: GaCut = { id: newId('cut'), name, kind: 'section', a: round3(A), b: round3(B), depth: 1000, scale: 0, view: vp.view };
      commit(`add section ${name}–${name}`, (p) => void (p.drawings.cuts ??= []).push(cut));
      notify(`Section ${name}–${name} added — its sheet is in the list (Sections). Edit depth and scale under Cuts.`);
    } else if (tool === 'detail') {
      const r = Math.round(Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z));
      if (r < 20) return notify('The detail circle is too small.', 'error');
      const cut: GaCut = { id: newId('cut'), name, kind: 'detail', a: round3(A), b: round3(A), depth: r, scale: 0, view: vp.view };
      commit(`add detail ${name}`, (p) => void (p.drawings.cuts ??= []).push(cut));
      notify(`Detail ${name} added — its sheet is in the list (Sections).`);
    }
    setTool('select');
  };

  const onDown = async (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    // No text selection or native drag while working on the sheet.
    e.preventDefault();
    host.current?.focus({ preventScroll: true });
    const q = toPaper(e);
    if (!q) return;
    if (tool === 'select') {
      const hit = pickEntity(d, q, tol());
      setSel(hit);
      if (!hit) return;
      const mode = hit.kind === 'dim' ? 'dim' : hit.kind === 'note' || hit.kind === 'cloud' ? 'markup' : hit.group ? 'group' : null;
      if (!mode) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ start: q, delta: { x: 0, y: 0 }, hit, mode });
      return;
    }
    if (tool === 'note') {
      const text = await askText('Note text', '', { title: 'Add note', ok: 'Add note' });
      if (text?.trim()) commit('add note', (p) => void addNote(p, d.id, { p: { x: snap(q.x), y: snap(q.y) }, text: text.trim() }));
      return;
    }
    if (tool === 'cloud') {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setPending([q]);
      setHover(q);
      return;
    }
    if (tool === 'section' || tool === 'detail') {
      if (!vp) return notify('Pick on a GA sheet.', 'error');
    }
    if (pending.length === 0) {
      setPending([q]);
      setHover(q);
    } else void finishTwoPoint(pending[0], q);
  };

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const q = toPaper(e);
    if (!q) return;
    if (drag) {
      let dx = snap(q.x - drag.start.x);
      let dy = snap(q.y - drag.start.y);
      if (drag.mode === 'dim') {
        if (drag.hit.shift === 'x') dy = 0;
        else dx = 0;
      }
      if (dx !== drag.delta.x || dy !== drag.delta.y) setDrag({ ...drag, delta: { x: dx, y: dy } });
      return;
    }
    if (pending.length) setHover(q);
  };

  const onUp = async (e: RPointerEvent<SVGSVGElement>) => {
    if (tool === 'cloud' && pending.length) {
      const q = toPaper(e) ?? pending[0];
      const a = pending[0];
      setPending([]);
      if (Math.abs(q.x - a.x) < 3 || Math.abs(q.y - a.y) < 3) return;
      const rev = await askText('Revision index shown in the cloud tag', nextRev(d.rev, project.drawings.settings.revisionScheme), { title: 'Revision cloud', ok: 'Add cloud' });
      if (rev === null) return;
      commit('add revision cloud', (p) => void addCloud(p, d.id, rectPts(a, q), rev.trim() || nextRev(d.rev, p.drawings.settings.revisionScheme)));
      return;
    }
    if (!drag) return;
    const { delta, hit, mode } = drag;
    setDrag(null);
    if (!delta.x && !delta.y) return;
    if (mode === 'dim' && hit.id) commit('offset dimension', (p) => offsetDim(p, d.id, hit.id!, hit.shift === 'x' ? delta.x : delta.y));
    else if (mode === 'markup' && hit.id) commit(`move ${hit.kind}`, (p) => moveMarkup(p, d.id, hit.id!, delta));
    else if (mode === 'group' && hit.group) commit(`move ${hit.group}`, (p) => moveGroup(p, d.id, hit.group!, delta));
  };

  const deleteSel = () => {
    if (!sel) return;
    const key = sel.id ?? sel.group;
    if (!key) return;
    commit(sel.kind === 'note' || sel.kind === 'cloud' ? `delete ${sel.kind}` : `hide ${key}`, (p) => hideItem(p, d.id, key));
    setSel(null);
  };

  const cancel = () => {
    setDrag(null);
    setPending([]);
    setHover(null);
    if (tool !== 'select') setTool('select');
    else setSel(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      cancel();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.stopPropagation();
      e.preventDefault();
      deleteSel();
    }
  };

  const reset = async () => {
    if (!(await askConfirm(`Remove all manual edits (moved views and dimensions, hidden items, notes and clouds) from ${d.number}?`, { title: 'Reset edits', ok: 'Reset' }))) return;
    commit('reset edits', (p) => resetEdits(p, d.id));
    setSel(null);
  };

  // Overlay content: selection boxes, drag preview, rubber bands.
  const Y = (y: number) => H - y;
  const boxRect = (b: { x0: number; y0: number; x1: number; y1: number } | null, cls: string, pad = 1) =>
    b && Number.isFinite(b.x0) ? <rect className={cls} x={b.x0 - pad} y={Y(b.y1 + pad)} width={b.x1 - b.x0 + 2 * pad} height={b.y1 - b.y0 + 2 * pad} /> : null;
  const selKey = sel ? (sel.kind === 'group' ? { group: sel.group } : { id: sel.id }) : null;
  const dragGroup = drag?.mode === 'group' ? drag.hit.group : undefined;
  const dragId = drag && drag.mode !== 'group' ? drag.hit.id : undefined;
  const dragSvg = useMemo(() => (dragGroup || dragId ? entitiesToSvg(itemEntities(d, { id: dragId, group: dragGroup }), H, '#2f7de1') : ''), [d, H, dragGroup, dragId]);
  const selBox = selKey ? itemBox(d, selKey) : null;
  const groupBox = sel?.group && sel.kind !== 'group' ? itemBox(d, { group: sel.group }) : null;
  const last = pending[0];

  return (
    <div className="dwg-editor" ref={host} tabIndex={0} onKeyDown={onKey}>
      <div className="dwg-toolbar">
        <div className="segmented" role="group" aria-label="Drawing tools">
          {(
            [
              ['select', 'Select'],
              ['note', 'Note'],
              ['leader', 'Leader note'],
              ['cloud', 'Revision cloud'],
              ...(isGa ? ([['section', 'Section cut'], ['detail', 'Detail']] as const) : []),
            ] as [Tool, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              className={tool === t ? 'on' : ''}
              onClick={() => {
                setTool(t);
                setPending([]);
                setSel(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {isGa && onCuts && (
          <button className="secondary-btn" onClick={onCuts} title="List, edit and add section cuts and details by coordinates">
            Cuts…
          </button>
        )}
        <button className="secondary-btn" disabled={!sel} onClick={deleteSel} title="Hide the selected item (notes and clouds are deleted)">
          <Icon name="trash" size={14} /> Delete
        </button>
        {hidden.length > 0 && (
          <button className="secondary-btn" onClick={() => commit('show hidden items', (p) => unhideItem(p, d.id))} title={hidden.join(', ')}>
            Show {hidden.length} hidden
          </button>
        )}
        <button className="secondary-btn" disabled={!d.edited} onClick={() => void reset()}>
          Reset edits
        </button>
        <div className="grow" />
        <div className="segmented" role="group" aria-label="Zoom">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} aria-label="Zoom out">
            −
          </button>
          <button type="button" className={zoom === 1 ? 'on' : ''} onClick={() => setZoom(1)}>
            Fit
          </button>
          <button type="button" onClick={() => setZoom((z) => Math.min(6, z * 1.25))} aria-label="Zoom in">
            +
          </button>
        </div>
      </div>
      <div className="dwg-hint">
        {sel && tool === 'select' ? (
          <>
            <strong>{KIND_TEXT[sel.kind]}</strong> {sel.id ?? sel.group}
            {sel.group && sel.kind !== 'group' ? ` in ${sel.group}` : ''} —{' '}
            {sel.kind === 'dim' ? 'drag to offset the dimension line' : sel.kind === 'note' || sel.kind === 'cloud' ? 'drag to move' : sel.group ? `drag to move ${sel.group}` : ''}; Delete to {sel.kind === 'note' || sel.kind === 'cloud' ? 'delete' : 'hide'}
          </>
        ) : (
          HINT[tool]
        )}
      </div>
      <div className="drawing-preview dwg-canvas">
        <div className="dwg-sheet" style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? 1100 : undefined }}>
          <div className="dwg-base" dangerouslySetInnerHTML={{ __html: svg }} />
          <svg
            ref={overlay}
            className={`dwg-overlay tool-${tool}`}
            viewBox={`0 0 ${d.sheet.w} ${H}`}
            onPointerDown={(e) => void onDown(e)}
            onPointerMove={onMove}
            onPointerUp={(e) => void onUp(e)}
            onPointerLeave={() => !drag && setHover(null)}
            aria-label="Drawing editor"
          >
            {groupBox && !drag && boxRect(groupBox, 'dwg-group', 2)}
            {selBox && !drag && boxRect(selBox, 'dwg-sel')}
            {drag && (drag.delta.x || drag.delta.y) ? <g transform={`translate(${drag.delta.x} ${-drag.delta.y})`} dangerouslySetInnerHTML={{ __html: dragSvg }} /> : null}
            {last && hover && tool === 'cloud' && boxRect({ x0: Math.min(last.x, hover.x), y0: Math.min(last.y, hover.y), x1: Math.max(last.x, hover.x), y1: Math.max(last.y, hover.y) }, 'dwg-rubber', 0)}
            {last && hover && (tool === 'leader' || tool === 'section') && <line className="dwg-rubber" x1={last.x} y1={Y(last.y)} x2={hover.x} y2={Y(hover.y)} />}
            {last && hover && tool === 'detail' && <circle className="dwg-rubber" cx={last.x} cy={Y(last.y)} r={Math.hypot(hover.x - last.x, hover.y - last.y)} />}
            {last && <circle className="dwg-point" cx={last.x} cy={Y(last.y)} r={0.9} />}
          </svg>
        </div>
      </div>
    </div>
  );
}

const round3 = (v: Vec3): Vec3 => ({ x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
