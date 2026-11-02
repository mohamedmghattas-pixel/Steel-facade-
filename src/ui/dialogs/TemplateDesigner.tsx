/**
 * Sheet templates (Drawing settings → Sheet template → Design…):
 * - the designer: a canvas of the title block where lines, rectangles, texts
 *   (fixed or a field), field cells and the logo area are drawn, moved and resized
 *   by dragging (1 mm snap), with their properties below; every change is one
 *   undo step through store.apply;
 * - the template list: new from the default, duplicate, delete, set active,
 *   JSON import / export, and the client's own title block imported from DXF
 *   with a review (units, size, preview with sample data, the field each text
 *   shows, logo upload in a picked rectangle).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, Segmented, Select, TextInput } from '../widgets';
import {
  DEFAULT_TEMPLATE,
  DEFAULT_TEMPLATE_ID,
  FIELD_SOURCES,
  FREE_TEMPLATE_MAX,
  TEMPLATE_TEXT_HEIGHTS,
  TITLE_BLOCK_UNITS,
  drawTitleBlockAt,
  entitiesToSvg,
  hasFreeContent,
  importScale,
  newTemplate,
  parseTemplates,
  readTitleBlockDxf,
  sampleTitleData,
  templateTextValue,
  textPlaceholders,
  titleBlockSummary,
  titleBlockTemplate,
  type TitleBlockDxf,
  type TitleData,
} from '../../core/drawings';
import { Sheet, textWidth } from '../../core/drawings/dims';
import { newId } from '../../core/model/ops';
import type { Project, SheetTemplate, TemplateGraphic, TemplateLineWeight, TemplateText, Vec2 } from '../../core/model/types';
import { download, pickFile, safeName } from '../../state/storage';
import { askConfirm } from '../askState';
import { Icon } from '../icons';
import './templateDesigner.css';

const TEXT_H = ['1.8', '2.5', '3.5', '5', '7'];
const MAX_LOGO = 400_000;
const LW_OPTS: { value: TemplateLineWeight; label: string }[] = [
  { value: 'thin', label: '0.25 mm (thin)' },
  { value: 'medium', label: '0.35 mm' },
  { value: 'wide', label: '0.5 mm (wide)' },
  { value: 'frame', label: '0.7 mm (frame)' },
];
/** What a free text can show: fixed text, text with placeholders, or a field. */
const TEXT_SOURCES = [
  { value: 'text:', label: 'Fixed text' },
  { value: 'fmt:', label: 'Text with {PLACEHOLDERS}' },
  ...FIELD_SOURCES.filter((f) => f.value !== 'text:' && f.value !== 'logo'),
];

function readDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

/** Asks for a logo image; null when cancelled or not usable (the user is told why). */
async function pickLogo(notify: (t: string, k?: 'info' | 'error') => void): Promise<string | null> {
  const f = await pickFile('.png,.svg,.jpg,.jpeg,image/png,image/svg+xml,image/jpeg');
  if (!f) return null;
  if (f.size > MAX_LOGO) {
    notify('Logo files up to 400 KB, please — they are embedded in every sheet.', 'error');
    return null;
  }
  const url = await readDataUrl(f);
  if (!url.startsWith('data:image/')) {
    notify('Choose a PNG, JPEG or SVG image.', 'error');
    return null;
  }
  return url;
}

const projectionOf = (p: Project) => (p.drawings.settings.standard === 'ASME' ? 'third' : 'first');

/** SVG markup (entities only) of a title block at full size, bottom-left at the origin. */
function blockMarkup(p: Project, t: SheetTemplate, d: TitleData): string {
  const s = new Sheet(0, 0);
  drawTitleBlockAt(s, 0, 0, p, t, d, projectionOf(p));
  return entitiesToSvg(s.ents, t.height);
}

// ---------------------------------------------------------------------------
// Geometry of the designer: selection, hit test, moves

type Kind = 'graphic' | 'text' | 'field' | 'logo';
interface Sel {
  kind: Kind;
  i: number;
}
type Tool = 'select' | 'line' | 'rect' | 'text' | 'field' | 'logo';
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const boxOf = (pts: Vec2[]): Box => ({ x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) });
const rectBox = (x: number, y: number, w: number, h: number): Box => ({ x0: Math.min(x, x + w), y0: Math.min(y, y + h), x1: Math.max(x, x + w), y1: Math.max(y, y + h) });

/** The text a free text shows with sample data (what the canvas draws). */
function shownText(p: Project, tx: TemplateText, d: TitleData): string {
  if (tx.source === 'projection') return 'XXXXXX';
  const v = templateTextValue(p, tx.source, d) || '—';
  if (!tx.maxW) return v;
  const max = Math.max(2, Math.floor(tx.maxW / (tx.h * 0.72)));
  return v.length > max ? v.slice(0, max) : v;
}

function textBox(p: Project, tx: TemplateText, d: TitleData): Box {
  const w = Math.max(2, textWidth(shownText(p, tx, d), tx.h));
  const x0 = tx.anchor === 'middle' ? -w / 2 : tx.anchor === 'end' ? -w : 0;
  const r = ((tx.rot ?? 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return boxOf(
    [
      [x0, 0],
      [x0 + w, 0],
      [x0, tx.h],
      [x0 + w, tx.h],
    ].map(([x, y]) => ({ x: tx.x + x * c - y * s, y: tx.y + x * s + y * c })),
  );
}

function graphicBox(g: TemplateGraphic): Box {
  switch (g.t) {
    case 'line':
      return boxOf([g.a, g.b]);
    case 'rect':
      return rectBox(g.x, g.y, g.w, g.h);
    case 'poly':
      return boxOf(g.pts);
    case 'circle':
      return { x0: g.c.x - g.r, y0: g.c.y - g.r, x1: g.c.x + g.r, y1: g.c.y + g.r };
  }
}

const fieldBox = (t: SheetTemplate, i: number): Box => {
  const g = t.grid ?? 1;
  const f = t.fields[i];
  return rectBox(f.col * g, f.row * g, f.w * g, f.h * g);
};

function selBox(p: Project, t: SheetTemplate, s: Sel, d: TitleData): Box | null {
  if (s.kind === 'graphic' && t.graphics?.[s.i]) return graphicBox(t.graphics[s.i]);
  if (s.kind === 'text' && t.texts?.[s.i]) return textBox(p, t.texts[s.i], d);
  if (s.kind === 'field' && t.fields[s.i]) return fieldBox(t, s.i);
  if (s.kind === 'logo' && t.logoRect) return rectBox(t.logoRect.x, t.logoRect.y, t.logoRect.w, t.logoRect.h);
  return null;
}

function segDist(q: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(q.x - a.x - u * dx, q.y - a.y - u * dy);
}
const inBox = (q: Vec2, b: Box, pad = 0) => q.x >= b.x0 - pad && q.x <= b.x1 + pad && q.y >= b.y0 - pad && q.y <= b.y1 + pad;

function graphicHit(g: TemplateGraphic, q: Vec2, tol: number): boolean {
  switch (g.t) {
    case 'line':
      return segDist(q, g.a, g.b) <= tol;
    case 'rect': {
      const c = [
        { x: g.x, y: g.y },
        { x: g.x + g.w, y: g.y },
        { x: g.x + g.w, y: g.y + g.h },
        { x: g.x, y: g.y + g.h },
      ];
      return (g.fill && inBox(q, graphicBox(g))) || c.some((a, i) => segDist(q, a, c[(i + 1) % 4]) <= tol);
    }
    case 'poly':
      for (let i = 0; i + 1 < g.pts.length + (g.closed ? 1 : 0); i++) if (segDist(q, g.pts[i], g.pts[(i + 1) % g.pts.length]) <= tol) return true;
      return !!g.fill && inBox(q, graphicBox(g));
    case 'circle': {
      const r = Math.hypot(q.x - g.c.x, q.y - g.c.y);
      return Math.abs(r - g.r) <= tol || (!!g.fill && r <= g.r);
    }
  }
}

/** What is under a point: texts first, then linework, the logo area and field cells. */
function hitTest(p: Project, t: SheetTemplate, q: Vec2, tol: number, d: TitleData): Sel | null {
  const texts = t.texts ?? [];
  for (let i = texts.length - 1; i >= 0; i--) if (inBox(q, textBox(p, texts[i], d), tol * 0.5)) return { kind: 'text', i };
  const gs = t.graphics ?? [];
  for (let i = gs.length - 1; i >= 0; i--) if (graphicHit(gs[i], q, tol)) return { kind: 'graphic', i };
  if (t.logoRect && inBox(q, rectBox(t.logoRect.x, t.logoRect.y, t.logoRect.w, t.logoRect.h))) return { kind: 'logo', i: 0 };
  // The smallest cell under the point.
  let best: Sel | null = null;
  let area = Infinity;
  t.fields.forEach((_, i) => {
    const b = fieldBox(t, i);
    const a = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (inBox(q, b) && a < area) {
      area = a;
      best = { kind: 'field', i };
    }
  });
  return best;
}

type Handle = 'a' | 'b' | 'sw' | 'se' | 'ne' | 'nw';

/** Resize handles of a selection, mm. */
function handles(t: SheetTemplate, s: Sel): { h: Handle; p: Vec2 }[] {
  const corners = (b: Box): { h: Handle; p: Vec2 }[] => [
    { h: 'sw', p: { x: b.x0, y: b.y0 } },
    { h: 'se', p: { x: b.x1, y: b.y0 } },
    { h: 'ne', p: { x: b.x1, y: b.y1 } },
    { h: 'nw', p: { x: b.x0, y: b.y1 } },
  ];
  if (s.kind === 'graphic') {
    const g = t.graphics?.[s.i];
    if (g?.t === 'line')
      return [
        { h: 'a', p: g.a },
        { h: 'b', p: g.b },
      ];
    if (g?.t === 'rect') return corners(graphicBox(g));
    return [];
  }
  if (s.kind === 'field' && t.fields[s.i]) return corners(fieldBox(t, s.i));
  if (s.kind === 'logo' && t.logoRect) return corners(rectBox(t.logoRect.x, t.logoRect.y, t.logoRect.w, t.logoRect.h));
  return [];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Moves a selection by (dx, dy) mm on a copy of the template. */
function moved(t: SheetTemplate, s: Sel, dx: number, dy: number): SheetTemplate {
  const x = structuredClone(t);
  const P = (q: Vec2) => ({ x: r3(q.x + dx), y: r3(q.y + dy) });
  if (s.kind === 'graphic' && x.graphics?.[s.i]) {
    const g = x.graphics[s.i];
    if (g.t === 'line') x.graphics[s.i] = { ...g, a: P(g.a), b: P(g.b) };
    else if (g.t === 'rect') x.graphics[s.i] = { ...g, x: r3(g.x + dx), y: r3(g.y + dy) };
    else if (g.t === 'poly') x.graphics[s.i] = { ...g, pts: g.pts.map(P) };
    else x.graphics[s.i] = { ...g, c: P(g.c) };
  } else if (s.kind === 'text' && x.texts?.[s.i]) {
    const tx = x.texts[s.i];
    x.texts[s.i] = { ...tx, x: r3(tx.x + dx), y: r3(tx.y + dy) };
  } else if (s.kind === 'field' && x.fields[s.i]) {
    const g = x.grid ?? 1;
    const f = x.fields[s.i];
    x.fields[s.i] = { ...f, col: r3(Math.round((f.col * g + dx) / g)), row: r3(Math.round((f.row * g + dy) / g)) };
  } else if (s.kind === 'logo' && x.logoRect) x.logoRect = { ...x.logoRect, x: r3(x.logoRect.x + dx), y: r3(x.logoRect.y + dy) };
  return x;
}

/** Drags a handle of a selection to q (mm) on a copy of the template. */
function resized(t: SheetTemplate, s: Sel, h: Handle, q: Vec2): SheetTemplate {
  const x = structuredClone(t);
  const corner = (b: Box): Box => {
    const n = { ...b };
    if (h === 'sw' || h === 'nw') n.x0 = q.x;
    else n.x1 = q.x;
    if (h === 'sw' || h === 'se') n.y0 = q.y;
    else n.y1 = q.y;
    return { x0: Math.min(n.x0, n.x1), y0: Math.min(n.y0, n.y1), x1: Math.max(n.x0, n.x1), y1: Math.max(n.y0, n.y1) };
  };
  if (s.kind === 'graphic' && x.graphics?.[s.i]) {
    const g = x.graphics[s.i];
    if (g.t === 'line') x.graphics[s.i] = h === 'a' ? { ...g, a: q } : { ...g, b: q };
    else if (g.t === 'rect') {
      const b = corner(graphicBox(g));
      x.graphics[s.i] = { ...g, x: b.x0, y: b.y0, w: Math.max(0.5, b.x1 - b.x0), h: Math.max(0.5, b.y1 - b.y0) };
    }
  } else if (s.kind === 'field' && x.fields[s.i]) {
    const g = x.grid ?? 1;
    const b = corner(fieldBox(x, s.i));
    const f = x.fields[s.i];
    x.fields[s.i] = { ...f, col: Math.round(b.x0 / g), row: Math.round(b.y0 / g), w: Math.max(1, Math.round((b.x1 - b.x0) / g)), h: Math.max(1, Math.round((b.y1 - b.y0) / g)) };
  } else if (s.kind === 'logo' && x.logoRect) {
    const b = corner(rectBox(x.logoRect.x, x.logoRect.y, x.logoRect.w, x.logoRect.h));
    x.logoRect = { x: b.x0, y: b.y0, w: Math.max(1, b.x1 - b.x0), h: Math.max(1, b.y1 - b.y0) };
  }
  return x;
}

function removed(t: SheetTemplate, s: Sel): SheetTemplate {
  const x = structuredClone(t);
  if (s.kind === 'graphic') x.graphics?.splice(s.i, 1);
  else if (s.kind === 'text') x.texts?.splice(s.i, 1);
  else if (s.kind === 'field') x.fields.splice(s.i, 1);
  else delete x.logoRect;
  return x;
}

const KIND_LABEL: Record<Kind, string> = { graphic: 'Line', text: 'Text', field: 'Field cell', logo: 'Logo area' };

// ---------------------------------------------------------------------------
// Canvas

interface Drag {
  mode: 'move' | 'resize' | 'draw';
  /** Snapped start point, mm. */
  start: Vec2;
  handle?: Handle;
  base: SheetTemplate;
  moved: boolean;
  /**
   * Pointer at the start (client px, exact mm, px per mm): later points follow the pointer's
   * movement, so the drag stays right when the dialog re-centres as the properties appear.
   */
  at: { cx: number; cy: number; q: Vec2; kx: number; ky: number };
}

/**
 * The title block at full size with sample data, editable: select, move and resize
 * by dragging; the drawing tools add lines, rectangles, texts, field cells and the
 * logo area. Positions snap to 1 mm (field cells to the template grid).
 */
function TemplateCanvas({
  t,
  sel,
  setSel,
  tool,
  setTool,
  commit,
}: {
  t: SheetTemplate;
  sel: Sel | null;
  setSel: (s: Sel | null) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  commit: (label: string, next: SheetTemplate) => void;
}) {
  const project = useStore((s) => s.project);
  const sample = useMemo(() => sampleTitleData(project), [project]);
  const [draft, setDraft] = useState<SheetTemplate | null>(null);
  const [rubber, setRubber] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const view = draft ?? t;
  const W = view.width;
  const H = view.height;
  const m = Math.max(3, W * 0.02);
  const markup = useMemo(() => blockMarkup(project, view, sample), [project, view, sample]);
  const hs = Math.max(1, W / 100);

  const toMm = (e: { clientX: number; clientY: number }): Vec2 => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: H - pt.y };
  };
  const snap = (q: Vec2): Vec2 => ({ x: Math.round(q.x), y: Math.round(q.y) });
  const startAt = (e: { clientX: number; clientY: number }, q: Vec2): Drag['at'] => {
    const ctm = svgRef.current?.getScreenCTM();
    return { cx: e.clientX, cy: e.clientY, q, kx: ctm && ctm.a > 0 ? ctm.a : 1, ky: ctm && ctm.d > 0 ? ctm.d : 1 };
  };
  const tolMm = () => {
    const ctm = svgRef.current?.getScreenCTM();
    return ctm && ctm.a > 0 ? 5 / ctm.a : 1;
  };

  const down = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    svgRef.current?.parentElement?.focus();
    const q = toMm(e);
    const sq = snap(q);
    if (tool !== 'select') {
      if (tool === 'text') {
        const x = structuredClone(t);
        (x.texts ??= []).push({ x: sq.x, y: sq.y, h: 2.5, source: 'text:Text' });
        commit('add text', x);
        setSel({ kind: 'text', i: x.texts.length - 1 });
        setTool('select');
        return;
      }
      drag.current = { mode: 'draw', start: sq, base: t, moved: false, at: startAt(e, q) };
      setRubber({ a: sq, b: sq });
      return;
    }
    const tol = tolMm();
    if (sel) {
      const h = handles(t, sel).find((x) => Math.hypot(x.p.x - q.x, x.p.y - q.y) <= Math.max(tol, hs));
      if (h) {
        drag.current = { mode: 'resize', start: sq, handle: h.h, base: t, moved: false, at: startAt(e, q) };
        return;
      }
    }
    const hit = hitTest(project, t, q, tol, sample);
    setSel(hit);
    if (hit) drag.current = { mode: 'move', start: sq, base: t, moved: false, at: startAt(e, q) };
  };

  const move = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const q = { x: d.at.q.x + (e.clientX - d.at.cx) / d.at.kx, y: d.at.q.y - (e.clientY - d.at.cy) / d.at.ky };
    const sq = snap(q);
    if (d.mode === 'draw') {
      setRubber({ a: d.start, b: sq });
      d.moved = d.moved || sq.x !== d.start.x || sq.y !== d.start.y;
      return;
    }
    if (!sel) return;
    // Moves go in whole millimetres; handles snap to the 1 mm grid.
    const dx = Math.round(q.x - d.at.q.x);
    const dy = Math.round(q.y - d.at.q.y);
    if (!dx && !dy && !d.moved) return;
    d.moved = true;
    setDraft(d.mode === 'move' ? moved(d.base, sel, dx, dy) : resized(d.base, sel, d.handle!, sq));
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'draw') {
      const r = rubber;
      setRubber(null);
      if (!r || !d.moved) return;
      const b = rectBox(r.a.x, r.a.y, r.b.x - r.a.x, r.b.y - r.a.y);
      const x = structuredClone(t);
      if (tool === 'line') {
        (x.graphics ??= []).push({ t: 'line', a: r.a, b: r.b, lw: 'medium' });
        commit('add line', x);
        setSel({ kind: 'graphic', i: x.graphics.length - 1 });
      } else if (tool === 'rect' && b.x1 - b.x0 >= 1 && b.y1 - b.y0 >= 1) {
        (x.graphics ??= []).push({ t: 'rect', x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, lw: 'medium' });
        commit('add rectangle', x);
        setSel({ kind: 'graphic', i: x.graphics.length - 1 });
      } else if (tool === 'field' && b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2) {
        const g = x.grid ?? 1;
        x.fields.push({ label: 'Label', source: 'drawing.number', col: Math.round(b.x0 / g), row: Math.round(b.y0 / g), w: Math.max(1, Math.round((b.x1 - b.x0) / g)), h: Math.max(1, Math.round((b.y1 - b.y0) / g)) });
        commit('add field', x);
        setSel({ kind: 'field', i: x.fields.length - 1 });
      } else if (tool === 'logo' && b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2) {
        x.logoRect = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
        commit('logo area', x);
        setSel({ kind: 'logo', i: 0 });
      }
      return;
    }
    if (draft && d.moved) commit(d.mode === 'move' ? `move ${KIND_LABEL[sel?.kind ?? 'graphic'].toLowerCase()}` : `resize ${KIND_LABEL[sel?.kind ?? 'graphic'].toLowerCase()}`, draft);
    setDraft(null);
  };

  const key = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (tool !== 'select' || sel) {
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        setTool('select');
        setSel(null);
      }
      return;
    }
    // Keys typed on the canvas do not reach the 3D view's shortcuts.
    e.stopPropagation();
    if (!sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      commit(`delete ${KIND_LABEL[sel.kind].toLowerCase()}`, removed(t, sel));
      setSel(null);
      return;
    }
    const step = e.shiftKey ? 5 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const a = arrows[e.key];
    if (a) {
      e.preventDefault();
      commit(`move ${KIND_LABEL[sel.kind].toLowerCase()}`, moved(t, sel, a[0], a[1]));
    }
  };

  // The selection may vanish (undo, delete elsewhere).
  useEffect(() => {
    if (sel && !selBox(project, t, sel, sample)) setSel(null);
  }, [project, t, sel, sample, setSel]);

  const Y = (y: number) => H - y;
  const box = sel ? selBox(project, view, sel, sample) : null;
  const pad = 0.6;
  const cursor = tool === 'select' ? 'default' : 'crosshair';
  return (
    <div className="tpl-canvas" tabIndex={0} onKeyDown={key} data-testid="tpl-canvas">
      <svg
        ref={svgRef}
        viewBox={`${-m} ${-m} ${W + 2 * m} ${H + 2 * m}`}
        style={{ cursor }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        fontFamily="Arial, Helvetica, sans-serif"
      >
        <rect x={-m} y={-m} width={W + 2 * m} height={H + 2 * m} fill="#f4f4f4" />
        <rect x={0} y={0} width={W} height={H} fill="#fff" />
        <g dangerouslySetInnerHTML={{ __html: markup }} />
        {view.logoRect && !view.logo && (
          <g className="tpl-logo-slot">
            <rect x={view.logoRect.x} y={Y(view.logoRect.y + view.logoRect.h)} width={view.logoRect.w} height={view.logoRect.h} />
            <text x={view.logoRect.x + view.logoRect.w / 2} y={Y(view.logoRect.y + view.logoRect.h / 2) + 1} fontSize={Math.min(3.5, view.logoRect.h / 2)} textAnchor="middle">
              LOGO
            </text>
          </g>
        )}
        {box && (
          <rect className="tpl-sel" x={box.x0 - pad} y={Y(box.y1 + pad)} width={box.x1 - box.x0 + 2 * pad} height={box.y1 - box.y0 + 2 * pad} vectorEffect="non-scaling-stroke" />
        )}
        {sel &&
          handles(view, sel).map((h) => <rect key={h.h} className="tpl-handle" x={h.p.x - hs / 2} y={Y(h.p.y) - hs / 2} width={hs} height={hs} vectorEffect="non-scaling-stroke" />)}
        {rubber &&
          (tool === 'line' ? (
            <line className="tpl-rubber" x1={rubber.a.x} y1={Y(rubber.a.y)} x2={rubber.b.x} y2={Y(rubber.b.y)} vectorEffect="non-scaling-stroke" />
          ) : (
            <rect
              className="tpl-rubber"
              x={Math.min(rubber.a.x, rubber.b.x)}
              y={Y(Math.max(rubber.a.y, rubber.b.y))}
              width={Math.abs(rubber.b.x - rubber.a.x)}
              height={Math.abs(rubber.b.y - rubber.a.y)}
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties of the selection

function SelectionProps({ t, sel, edit, setSel }: { t: SheetTemplate; sel: Sel; edit: (label: string, fn: (x: SheetTemplate) => void) => void; setSel: (s: Sel | null) => void }) {
  const notify = useStore((s) => s.notify);
  const del = (
    <button
      className="secondary-btn"
      onClick={() => {
        edit(`delete ${KIND_LABEL[sel.kind].toLowerCase()}`, (x) => Object.assign(x, removed(x, sel)));
        setSel(null);
      }}
    >
      <Icon name="trash" size={14} /> Delete
    </button>
  );
  if (sel.kind === 'text') {
    const tx = t.texts?.[sel.i];
    if (!tx) return null;
    const set = (label: string, fn: (y: TemplateText) => void) => edit(label, (x) => x.texts?.[sel.i] && fn(x.texts[sel.i]));
    const kind = tx.source.startsWith('text:') ? 'text:' : tx.source.startsWith('fmt:') ? 'fmt:' : tx.source;
    const body = kind === 'text:' ? tx.source.slice(5) : kind === 'fmt:' ? tx.source.slice(4) : '';
    return (
      <div className="tpl-props" data-testid="tpl-props">
        <Field label="Shows">
          <Select
            value={kind}
            options={TEXT_SOURCES}
            onChange={(v) =>
              set('text value', (y) => {
                y.source = v === 'text:' || v === 'fmt:' ? `${v}${body || (kind === 'text:' || kind === 'fmt:' ? '' : (y.origin ?? 'Text'))}` : v;
              })
            }
          />
        </Field>
        {(kind === 'text:' || kind === 'fmt:') && (
          <Field label={kind === 'fmt:' ? 'Text ({PROJECT}, {DRAWING_NO} … are filled per sheet)' : 'Text'}>
            <TextInput value={body} onChange={(v) => set('text', (y) => void (y.source = `${kind}${v}`))} />
          </Field>
        )}
        <Field label="Height (ISO 3098)">
          <Select value={String(tx.h)} options={[...new Set([...TEMPLATE_TEXT_HEIGHTS.map(String), String(tx.h)])].map((v) => ({ value: v, label: `${v} mm` }))} onChange={(v) => set('text height', (y) => void (y.h = Number(v)))} />
        </Field>
        <Field label="Alignment">
          <Segmented
            value={tx.anchor ?? 'start'}
            options={[
              { value: 'start', label: 'Left' },
              { value: 'middle', label: 'Centre' },
              { value: 'end', label: 'Right' },
            ]}
            onChange={(v) => set('text alignment', (y) => (v === 'start' ? delete y.anchor : (y.anchor = v)))}
          />
        </Field>
        <Field label="Bold · rotation">
          <span className="row-inline">
            <input type="checkbox" checked={!!tx.bold} onChange={(e) => set('text bold', (y) => (e.target.checked ? (y.bold = true) : delete y.bold))} />
            <Select value={String(tx.rot ?? 0)} options={['0', '90', '180', '270'].map((v) => ({ value: v, label: `${v}°` }))} onChange={(v) => set('text rotation', (y) => (Number(v) ? (y.rot = Number(v)) : delete y.rot))} />
          </span>
        </Field>
        <Field label="Position x · y · longest" hint="Baseline point, mm from the bottom left; longer values are shortened with …">
          <span className="row-inline">
            <NumberInput value={tx.x} unit="mm" onChange={(v) => set('text x', (y) => void (y.x = v))} />
            <NumberInput value={tx.y} unit="mm" onChange={(v) => set('text y', (y) => void (y.y = v))} />
            <NumberInput value={tx.maxW ?? 0} unit="mm" min={0} onChange={(v) => set('text width', (y) => (v > 0 ? (y.maxW = v) : delete y.maxW))} />
          </span>
        </Field>
        {tx.origin && <p className="muted">From the DXF: {tx.origin}</p>}
        {del}
      </div>
    );
  }
  if (sel.kind === 'graphic') {
    const g = t.graphics?.[sel.i];
    if (!g) return null;
    const set = (label: string, fn: (y: TemplateGraphic) => void) => edit(label, (x) => x.graphics?.[sel.i] && fn(x.graphics[sel.i]));
    return (
      <div className="tpl-props" data-testid="tpl-props">
        <Field label={g.t === 'line' ? 'Line' : g.t === 'rect' ? 'Rectangle' : g.t === 'circle' ? 'Circle' : 'Polyline'}>
          <Select value={g.lw ?? 'medium'} options={LW_OPTS} onChange={(v) => set('line weight', (y) => void (y.lw = v))} />
        </Field>
        {g.t !== 'line' && (
          <Field label="Filled">
            <input type="checkbox" checked={!!g.fill} onChange={(e) => set('fill', (y) => (y.t !== 'line' ? (e.target.checked ? (y.fill = true) : delete y.fill) : undefined))} />
          </Field>
        )}
        {g.t === 'line' && (
          <Field label="From x · y → to x · y">
            <span className="row-inline">
              <NumberInput value={g.a.x} onChange={(v) => set('line', (y) => y.t === 'line' && (y.a = { ...y.a, x: v }))} />
              <NumberInput value={g.a.y} onChange={(v) => set('line', (y) => y.t === 'line' && (y.a = { ...y.a, y: v }))} />
              <NumberInput value={g.b.x} onChange={(v) => set('line', (y) => y.t === 'line' && (y.b = { ...y.b, x: v }))} />
              <NumberInput value={g.b.y} onChange={(v) => set('line', (y) => y.t === 'line' && (y.b = { ...y.b, y: v }))} />
            </span>
          </Field>
        )}
        {g.t === 'rect' && (
          <Field label="x · y · width · height">
            <span className="row-inline">
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <NumberInput key={k} value={g[k]} min={k === 'w' || k === 'h' ? 0.5 : undefined} onChange={(v) => set('rectangle', (y) => y.t === 'rect' && (y[k] = v))} />
              ))}
            </span>
          </Field>
        )}
        {del}
      </div>
    );
  }
  if (sel.kind === 'field') {
    const fd = t.fields[sel.i];
    if (!fd) return null;
    const set = (label: string, fn: (f: SheetTemplate['fields'][number]) => void) => edit(label, (x) => x.fields[sel.i] && fn(x.fields[sel.i]));
    const fixed = fd.source.startsWith('text:');
    return (
      <div className="tpl-props" data-testid="tpl-props">
        <Field label="Label">
          <TextInput value={fd.label} onChange={(v) => set('field label', (f) => void (f.label = v))} />
        </Field>
        <Field label="Value">
          <span className="row-inline">
            <Select value={fixed ? 'text:' : fd.source} options={FIELD_SOURCES} onChange={(v) => set('field value', (f) => void (f.source = v === 'text:' ? 'text:' + (fixed ? fd.source.slice(5) : '') : v))} />
            {fixed && <TextInput value={fd.source.slice(5)} placeholder="Fixed text" onChange={(v) => set('field text', (f) => void (f.source = `text:${v}`))} />}
          </span>
        </Field>
        <Field label="Height · bold">
          <span className="row-inline">
            <Select value={String(fd.textH ?? 2.5)} options={TEXT_H.map((v) => ({ value: v, label: `${v} mm` }))} onChange={(v) => set('field text height', (f) => void (f.textH = Number(v)))} />
            <input type="checkbox" checked={!!fd.bold} onChange={(e) => set('field bold', (f) => void (f.bold = e.target.checked || undefined))} />
          </span>
        </Field>
        <Field label="Alignment">
          <Segmented
            value={fd.align ?? 'start'}
            options={[
              { value: 'start', label: 'Left' },
              { value: 'middle', label: 'Centre' },
              { value: 'end', label: 'Right' },
            ]}
            onChange={(v) => set('field alignment', (f) => (v === 'start' ? delete f.align : (f.align = v)))}
          />
        </Field>
        {del}
      </div>
    );
  }
  const r = t.logoRect;
  if (!r) return null;
  return (
    <div className="tpl-props" data-testid="tpl-props">
      <Field label="Logo area x · y · width · height" hint="The logo is fitted into it, keeping its aspect">
        <span className="row-inline">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <NumberInput key={k} value={r[k]} min={k === 'w' || k === 'h' ? 1 : undefined} onChange={(v) => edit('logo area', (x) => x.logoRect && (x.logoRect[k] = v))} />
          ))}
        </span>
      </Field>
      <button
        className="secondary-btn"
        onClick={async () => {
          const url = await pickLogo(notify);
          if (url) edit('logo', (x) => void (x.logo = url));
        }}
      >
        {t.logo ? 'Replace logo…' : 'Logo…'}
      </button>
      {del}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Designer dialog

/**
 * Sheet templates: list (default, company templates, imported title blocks) and the
 * designer of the selected one; JSON import / export, title block import from DXF.
 */
export function TemplateDesignerDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const templates = project.drawings.templates ?? [];
  const [selId, setSelId] = useState<string>(project.drawings.activeTemplate ?? templates[0]?.id ?? DEFAULT_TEMPLATE_ID);
  const [sel, setSel] = useState<Sel | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [importing, setImporting] = useState<{ name: string; text: string } | null>(null);
  const t = templates.find((x) => x.id === selId) ?? DEFAULT_TEMPLATE;
  const builtIn = t.id === DEFAULT_TEMPLATE_ID;
  const active = (project.drawings.activeTemplate ?? DEFAULT_TEMPLATE_ID) === t.id;
  const sample = useMemo(() => sampleTitleData(project), [project]);
  const edit = (label: string, fn: (x: SheetTemplate) => void) =>
    apply(`Template: ${label}`, (p) => {
      const x = (p.drawings.templates ?? []).find((y) => y.id === t.id);
      if (x) fn(x);
    });
  const commit = (label: string, next: SheetTemplate) =>
    apply(`Template: ${label}`, (p) => {
      const i = (p.drawings.templates ?? []).findIndex((y) => y.id === next.id);
      if (i >= 0) p.drawings.templates[i] = structuredClone(next);
    });
  const select = (id: string) => {
    setSelId(id);
    setSel(null);
    setTool('select');
  };
  const copy = () => {
    const id = newId('tpl');
    apply('New sheet template', (p) => void (p.drawings.templates ??= []).push(newTemplate(id, builtIn ? 'Company template' : `${t.name} (copy)`, t)));
    select(id);
  };
  const importJson = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const list = parseTemplates(await f.text()).map((x) => ({ ...x, id: newId('tpl') }));
      apply('Import sheet templates', (p) => void (p.drawings.templates ??= []).push(...list));
      select(list[0].id);
      notify(`Imported ${list.length} template${list.length === 1 ? '' : 's'}.`);
    } catch (e) {
      notify(`Could not import: ${(e as Error).message}`, 'error');
    }
  };
  const importDxf = async () => {
    const f = await pickFile('.dxf');
    if (!f) return;
    setImporting({ name: f.name, text: await f.text() });
  };
  const uploadLogo = async () => {
    const url = await pickLogo(notify);
    if (!url) return;
    edit('logo', (x) => {
      x.logo = url;
      if (x.logoRect || x.fields.some((fd) => fd.source === 'logo')) return;
      // The logo takes the legal owner's cell, else a new cell (grid templates) or area (free ones) at the bottom left.
      const owner = x.fields.find((fd) => fd.source === 'owner');
      if (owner) owner.source = 'logo';
      else if (x.graphics?.length || x.texts?.length) x.logoRect = { x: 1, y: 1, w: 40, h: Math.min(10, x.height - 2) };
      else x.fields.push({ label: '', source: 'logo', col: 0, row: 0, w: Math.round(40 / (x.grid ?? 1)), h: Math.round(10 / (x.grid ?? 1)) });
    });
  };
  if (importing)
    return (
      <TitleBlockImportDialog
        file={importing}
        onClose={() => setImporting(null)}
        onSaved={(id) => {
          setImporting(null);
          select(id);
        }}
      />
    );
  const g = t.grid ?? 1;
  // Size limits (as sanitizeTemplate): free content (imported / drawn blocks) or a grid of fields.
  const lim = hasFreeContent(t) ? { w0: 40, w1: FREE_TEMPLATE_MAX.w, h0: 5, h1: FREE_TEMPLATE_MAX.h } : { w0: 60, w1: 400, h0: 10, h1: 150 };
  const tools: { id: Tool; label: string; title: string; icon?: string }[] = [
    { id: 'select', label: 'Select', title: 'Select, move (drag) and resize (corner handles); arrow keys nudge 1 mm, Delete removes', icon: 'select' },
    { id: 'line', label: 'Line', title: 'Drag to draw a line', icon: 'line' },
    { id: 'rect', label: 'Rectangle', title: 'Drag to draw a rectangle' },
    { id: 'text', label: 'Text', title: 'Click to place a text (fixed, or a field filled per sheet)' },
    { id: 'field', label: 'Field cell', title: 'Drag a cell with a label and a value (drawn with cell lines)', icon: 'table' },
    { id: 'logo', label: 'Logo area', title: 'Drag the rectangle the logo is fitted into' },
  ];
  return (
    <Modal
      title="Sheet templates"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted">{active ? 'Used for every sheet.' : 'Not in use.'}</span>
          {!active && (
            <button className="primary-btn" onClick={() => apply('Sheet template', (p) => void (p.drawings.activeTemplate = builtIn ? undefined : t.id))}>
              Use for all sheets
            </button>
          )}
        </>
      }
    >
      <div className="tpl-designer">
        <div className="tpl-list">
          {[DEFAULT_TEMPLATE, ...templates].map((x) => (
            <button key={x.id} className={x.id === t.id ? 'on' : ''} onClick={() => select(x.id)}>
              {x.name}
              {(project.drawings.activeTemplate ?? DEFAULT_TEMPLATE_ID) === x.id ? ' ✓' : ''}
            </button>
          ))}
          <div className="btn-col">
            <button className="secondary-btn" onClick={copy}>
              <Icon name="plus" size={14} /> {builtIn ? 'New from default' : 'Duplicate'}
            </button>
            <button className="secondary-btn" onClick={() => void importDxf()} title="Your own title block from CAD: linework, texts, blocks with attributes; {PLACEHOLDERS} and attribute tags become fields">
              <Icon name="import" size={14} /> Import title block (DXF)
            </button>
            <button className="secondary-btn" onClick={() => void importJson()}>
              <Icon name="import" size={14} /> Import JSON
            </button>
            <button className="secondary-btn" onClick={() => download(`${safeName(t.name)}.sheet-template.json`, JSON.stringify(t, null, 1), 'application/json')}>
              <Icon name="export" size={14} /> Export JSON
            </button>
            {!builtIn && (
              <button
                className="secondary-btn"
                onClick={async () => {
                  if (!(await askConfirm(`Delete the template "${t.name}"?`, { title: 'Delete template', ok: 'Delete' }))) return;
                  apply('Delete sheet template', (p) => {
                    p.drawings.templates = (p.drawings.templates ?? []).filter((x) => x.id !== t.id);
                    if (p.drawings.activeTemplate === t.id) p.drawings.activeTemplate = undefined;
                  });
                  select(DEFAULT_TEMPLATE_ID);
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            )}
          </div>
        </div>
        <div className="tpl-edit">
          {builtIn ? (
            <>
              <div className="tpl-preview" dangerouslySetInnerHTML={{ __html: previewSvg(project, t, sample) }} />
              <p className="muted">The built-in ISO 7200 title block (180 × 40 mm) cannot be changed. Make a copy to design a company template, or import your own title block from DXF.</p>
            </>
          ) : (
            <>
              <div className="tpl-toolbar" role="toolbar">
                {tools.map((x) => (
                  <button key={x.id} className={`secondary-btn ${tool === x.id ? 'on' : ''}`} title={x.title} onClick={() => setTool(x.id)}>
                    {x.icon && <Icon name={x.icon} size={14} />} {x.label}
                  </button>
                ))}
                <span className="muted">{tool === 'select' ? 'Drag to move · corners resize · 1 mm snap' : 'Drag on the block'}</span>
              </div>
              <TemplateCanvas t={t} sel={sel} setSel={setSel} tool={tool} setTool={setTool} commit={commit} />
              <div className="tpl-props-slot">
                {sel ? <SelectionProps t={t} sel={sel} edit={edit} setSel={setSel} /> : <p className="muted tpl-hint">Select an item on the block to change it, or draw with the tools above. Undo with Ctrl+Z.</p>}
              </div>
              <div className="row3">
                <Field label="Name">
                  <TextInput value={t.name} onChange={(v) => edit('name', (x) => void (x.name = v))} />
                </Field>
                <Field label="Size (width × height)" hint="Bottom right of the frame; the revision table sits on top">
                  <span className="row-inline">
                    <NumberInput value={t.width} unit="mm" min={lim.w0} onChange={(v) => edit('width', (x) => void (x.width = Math.min(lim.w1, v)))} />
                    <NumberInput value={t.height} unit="mm" min={lim.h0} onChange={(v) => edit('height', (x) => void (x.height = Math.min(lim.h1, v)))} />
                  </span>
                </Field>
                <Field label="Grid cell · border · logo" hint="Field cells are in grid cells; row 0 is the bottom edge">
                  <span className="row-inline">
                    <NumberInput value={g} unit="mm" min={0.5} onChange={(v) => edit('grid', (x) => void (x.grid = v))} />
                    <label className="tpl-check" title="Outer border 0.7 mm (ISO 7200)">
                      <input type="checkbox" checked={t.border !== false} onChange={(e) => edit('border', (x) => void (x.border = e.target.checked))} /> 0.7
                    </label>
                    <button className="secondary-btn" onClick={() => void uploadLogo()}>
                      {t.logo ? 'Replace logo' : 'Logo…'}
                    </button>
                    {t.logo && (
                      <button className="icon-btn" title="Remove logo" onClick={() => edit('remove logo', (x) => void delete x.logo)}>
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </span>
                </Field>
              </div>
              {t.imported && (
                <p className="muted">
                  Imported from {t.imported.file || 'DXF'} ({t.imported.units}) on {t.imported.date}: {t.graphics?.length ?? 0} lines, {t.texts?.length ?? 0} texts.
                </p>
              )}
              <details className="tpl-table">
                <summary>Field cells as a table ({t.fields.length})</summary>
                <FieldTable t={t} edit={edit} />
              </details>
              <Field label="Fixed notes" hint="One per line — printed after the general notes on every sheet">
                <TemplateNotes value={t.notes} onChange={(v) => edit('notes', (x) => void (x.notes = v))} />
              </Field>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** SVG of a template's title block with sample data, for previews. */
function previewSvg(p: Project, t: SheetTemplate, d: TitleData): string {
  const m = 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-m} ${-m} ${t.width + 2 * m} ${t.height + 2 * m}" font-family="Arial, Helvetica, sans-serif"><rect x="${-m}" y="${-m}" width="${t.width + 2 * m}" height="${t.height + 2 * m}" fill="#fff"/>${blockMarkup(p, t, d)}</svg>`;
}

/** The grid fields as a table (precise entry). */
function FieldTable({ t, edit }: { t: SheetTemplate; edit: (label: string, fn: (x: SheetTemplate) => void) => void }) {
  return (
    <>
      <table className="tpl-fields">
        <thead>
          <tr>
            <th>Label</th>
            <th>Value</th>
            <th>Col</th>
            <th>Row</th>
            <th>W</th>
            <th>H</th>
            <th>Text</th>
            <th>Bold</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {t.fields.map((fd, i) => {
            const fixed = fd.source.startsWith('text:');
            const set = (label: string, fn: (f: SheetTemplate['fields'][number]) => void) => edit(label, (x) => x.fields[i] && fn(x.fields[i]));
            return (
              <tr key={i}>
                <td>
                  <TextInput value={fd.label} onChange={(v) => set('field label', (f) => void (f.label = v))} />
                </td>
                <td>
                  <span className="row-inline">
                    <Select value={fixed ? 'text:' : fd.source} options={FIELD_SOURCES} onChange={(v) => set('field value', (f) => void (f.source = v === 'text:' ? 'text:' + (fixed ? fd.source.slice(5) : '') : v))} />
                    {fixed && <TextInput value={fd.source.slice(5)} placeholder="Fixed text" onChange={(v) => set('field text', (f) => void (f.source = `text:${v}`))} />}
                  </span>
                </td>
                {(['col', 'row', 'w', 'h'] as const).map((k) => (
                  <td key={k} className="num">
                    <NumberInput value={fd[k]} min={0} onChange={(v) => set(`field ${k}`, (f) => void (f[k] = v))} />
                  </td>
                ))}
                <td className="txt">
                  <Select value={String(fd.textH ?? 2.5)} options={TEXT_H} onChange={(v) => set('field text height', (f) => void (f.textH = Number(v)))} />
                </td>
                <td>
                  <input type="checkbox" checked={!!fd.bold} onChange={(e) => set('field bold', (f) => void (f.bold = e.target.checked || undefined))} />
                </td>
                <td>
                  <button className="icon-btn" title="Remove field" onClick={() => edit('remove field', (x) => void x.fields.splice(i, 1))}>
                    <Icon name="close" size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        className="secondary-btn"
        onClick={() => edit('add field', (x) => void x.fields.push({ label: 'Label', source: 'text:', col: 0, row: 0, w: Math.round(30 / (x.grid ?? 1)), h: Math.round(8 / (x.grid ?? 1)) }))}
      >
        <Icon name="plus" size={14} /> Field
      </button>
    </>
  );
}

function TemplateNotes({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => {
        const list = text.split('\n').map((x) => x.trim()).filter(Boolean);
        if (list.join('\n') !== value.join('\n')) onChange(list);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Title block import from DXF: review

const SOURCE_LABEL = new Map(FIELD_SOURCES.map((f) => [f.value, f.label]));

/**
 * Review of a title block read from DXF: units, size, a preview with sample data,
 * every text with what it shows (a field filled per sheet, fixed, or left out), the
 * logo (upload, rectangle picked on the preview), name; saves a sheet template.
 */
export function TitleBlockImportDialog({ file, onClose, onSaved }: { file: { name: string; text: string }; onClose: () => void; onSaved: (id: string) => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const [units, setUnits] = useState<number | undefined>(undefined);
  const parsed = useMemo((): { imp: TitleBlockDxf } | { error: string } => {
    try {
      return { imp: readTitleBlockDxf(file.text, units ? { unitScale: units } : {}) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [file.text, units]);
  const imp = 'imp' in parsed ? parsed.imp : null;
  const [map, setMap] = useState<string[]>([]);
  const [scale, setScale] = useState(1);
  const [name, setName] = useState(file.name.replace(/\.dxf$/i, '') || 'Company title block');
  const [logo, setLogo] = useState<string | undefined>(undefined);
  const [logoRect, setLogoRect] = useState<{ x: number; y: number; w: number; h: number } | undefined>(undefined);
  const [border, setBorder] = useState(true);
  const [activate, setActivate] = useState(true);
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  // New units: the suggestions and the logo frame of the file again.
  useEffect(() => {
    setMap(imp ? imp.texts.map((t) => t.suggested) : []);
    setLogoRect(imp?.logoRect);
  }, [imp]);
  const k = imp ? importScale(imp, scale) : 1;
  const tpl = useMemo(() => (imp && map.length === imp.texts.length ? titleBlockTemplate(imp, 'preview', { name, map, scale, logo, logoRect, border, file: file.name }) : null), [imp, map, scale, logo, logoRect, border, name, file.name]);
  const sample = useMemo(() => sampleTitleData(project), [project]);
  const markup = useMemo(() => (tpl ? blockMarkup(project, tpl, sample) : ''), [project, tpl, sample]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [rubber, setRubber] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  if (!imp || !tpl)
    return (
      <Modal title="Import title block (DXF)" onClose={onClose}>
        <p className="warning">{'error' in parsed ? parsed.error : 'Reading the file…'}</p>
        <p className="muted">Export the title block from CAD as an ASCII DXF (any version), with only the title block in the drawing.</p>
      </Modal>
    );
  const W = tpl.width;
  const H = tpl.height;
  const m = Math.max(3, W * 0.02);
  const Y = (y: number) => H - y;
  const toMm = (e: { clientX: number; clientY: number }): Vec2 => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: Math.round(pt.x), y: Math.round(H - pt.y) };
  };
  const hl = hover !== null ? imp.texts[hover] : null;
  const unitOpts = [{ value: '0', label: `${imp.unitSource === 'insunits' || imp.unitSource === 'measurement' ? `From the file: ${imp.units}` : `Not in the file (assumed: ${imp.units})`}` }, ...TITLE_BLOCK_UNITS.map((u) => ({ value: String(u.value), label: u.label }))];
  const save = () => {
    const id = newId('tpl');
    const t = titleBlockTemplate(imp, id, { name: name.trim() || 'Company title block', map, scale, logo, logoRect, border, file: file.name });
    apply('Import title block', (p) => {
      (p.drawings.templates ??= []).push(t);
      if (activate) p.drawings.activeTemplate = id;
    });
    notify(`Title block "${t.name}" imported (${Math.round(t.width)} × ${Math.round(t.height)} mm)${activate ? ' and used for every sheet' : ''}.`);
    onSaved(id);
  };
  const live = map.filter((s) => s && s !== 'text:').length;
  return (
    <Modal
      title="Import title block (DXF)"
      wide
      onClose={onClose}
      footer={
        <>
          <label className="tpl-check">
            <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Use for all sheets
          </label>
          <button className="secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-btn" onClick={save} data-testid="tb-save">
            Save template
          </button>
        </>
      }
    >
      <div className="row3">
        <Field label="Units" hint={imp.insunits !== null ? `$INSUNITS = ${imp.insunits}` : imp.measurement !== null ? `$MEASUREMENT = ${imp.measurement}` : 'The file states no units'}>
          <Select value={String(units ?? 0)} options={unitOpts} onChange={(v) => setUnits(Number(v) || undefined)} />
        </Field>
        <Field label="Size" hint={`As drawn: ${Math.round(imp.width * 10) / 10} × ${Math.round(imp.height * 10) / 10} mm; it sits at the bottom right of the frame`}>
          <span className="row-inline">
            <NumberInput value={r1(imp.width * k)} unit="mm" min={10} onChange={(v) => setScale(v / imp.width)} />
            <span className="muted">× {r1(imp.height * k)} mm</span>
          </span>
        </Field>
        <Field label="Outer border" hint="0.7 mm like the ISO 7200 block; the DXF outline is then left out">
          <label className="tpl-check">
            <input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} /> Draw 0.7 mm
          </label>
        </Field>
      </div>
      {imp.notes.length > 0 && (
        <ul className="tb-notes">
          {imp.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="muted">
        {titleBlockSummary(imp)} {live} text{live === 1 ? '' : 's'} filled per sheet.
      </p>
      <div className={`tpl-canvas tb-preview ${picking ? 'picking' : ''}`} data-testid="tb-preview">
        <svg
          ref={svgRef}
          viewBox={`${-m} ${-m} ${W + 2 * m} ${H + 2 * m}`}
          fontFamily="Arial, Helvetica, sans-serif"
          onPointerDown={(e) => {
            if (!picking) return;
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            const q = toMm(e);
            setRubber({ a: q, b: q });
          }}
          onPointerMove={(e) => rubber && setRubber({ a: rubber.a, b: toMm(e) })}
          onPointerUp={() => {
            if (!rubber) return;
            const b = rectBox(rubber.a.x, rubber.a.y, rubber.b.x - rubber.a.x, rubber.b.y - rubber.a.y);
            setRubber(null);
            if (b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2) {
              setLogoRect({ x: b.x0 / k, y: b.y0 / k, w: (b.x1 - b.x0) / k, h: (b.y1 - b.y0) / k });
              setPicking(false);
            }
          }}
        >
          <rect x={-m} y={-m} width={W + 2 * m} height={H + 2 * m} fill="#f4f4f4" />
          <rect x={0} y={0} width={W} height={H} fill="#fff" />
          <g dangerouslySetInnerHTML={{ __html: markup }} />
          {tpl.logoRect && (
            <g className="tpl-logo-slot">
              <rect x={tpl.logoRect.x} y={Y(tpl.logoRect.y + tpl.logoRect.h)} width={tpl.logoRect.w} height={tpl.logoRect.h} />
              {!logo && (
                <text x={tpl.logoRect.x + tpl.logoRect.w / 2} y={Y(tpl.logoRect.y + tpl.logoRect.h / 2) + 1} fontSize={Math.min(3.5, tpl.logoRect.h / 2)} textAnchor="middle">
                  LOGO
                </text>
              )}
            </g>
          )}
          {hl &&
            hl.lines.map((l, i) => (
              <circle key={i} className="tb-hl" cx={l.x * k} cy={Y(l.y * k)} r={Math.max(1, hl.h * k * 0.6)} vectorEffect="non-scaling-stroke" />
            ))}
          {rubber && <rect className="tpl-rubber" x={Math.min(rubber.a.x, rubber.b.x)} y={Y(Math.max(rubber.a.y, rubber.b.y))} width={Math.abs(rubber.b.x - rubber.a.x)} height={Math.abs(rubber.b.y - rubber.a.y)} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="row-inline tb-logo">
        <span>Logo</span>
        <button
          className="secondary-btn"
          onClick={async () => {
            const url = await pickLogo(notify);
            if (!url) return;
            setLogo(url);
            if (!logoRect) setPicking(true);
          }}
        >
          {logo ? 'Replace logo…' : 'Upload PNG / SVG…'}
        </button>
        <button className={`secondary-btn ${picking ? 'on' : ''}`} onClick={() => setPicking(!picking)} title="Drag the rectangle on the preview">
          {picking ? 'Drag on the preview…' : 'Pick logo area'}
        </button>
        {logoRect && (
          <span className="muted">
            {r1(logoRect.w * k)} × {r1(logoRect.h * k)} mm at {r1(logoRect.x * k)}, {r1(logoRect.y * k)}{' '}
            <button className="link-btn" onClick={() => setLogoRect(undefined)}>
              remove
            </button>
          </span>
        )}
        {!logoRect && !logo && <span className="muted">DXF images are external files: upload the logo here.</span>}
      </div>
      <table className="tpl-fields tb-texts" data-testid="tb-texts">
        <thead>
          <tr>
            <th>Text in the DXF</th>
            <th>Kind</th>
            <th>Shows on every sheet</th>
          </tr>
        </thead>
        <tbody>
          {imp.texts.map((t, i) => {
            const text = t.lines.map((l) => l.text).join(' ⏎ ');
            const ph = textPlaceholders(text).length > 0;
            const opts = [
              { value: 'text:', label: 'Fixed text (as drawn)' },
              ...(ph ? [{ value: 'fmt:', label: 'Text with its placeholders filled' }] : []),
              { value: '', label: 'Leave out' },
              ...FIELD_SOURCES.filter((f) => f.value !== 'text:' && f.value !== 'logo').map((f) => ({ value: f.value, label: `Field: ${f.label}` })),
            ];
            const v = map[i] ?? t.suggested;
            return (
              <tr key={i} className={v && v !== 'text:' ? 'live' : v === '' ? 'out' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <td className="tb-text">
                  {text || <span className="muted">(empty)</span>}
                  {t.tag && <span className="tb-tag">{t.tag}</span>}
                </td>
                <td className="muted">{t.kind === 'ATTRIB' || t.kind === 'ATTDEF' ? 'attribute' : t.kind === 'MTEXT' ? 'MTEXT' : 'text'}</td>
                <td>
                  <Select
                    value={v}
                    options={opts}
                    onChange={(x) =>
                      setMap((prev) => {
                        const next = [...prev];
                        next[i] = x;
                        return next;
                      })
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!imp.texts.length && <p className="muted">No texts in the file: the title block is fixed linework. Add fields in the designer after saving.</p>}
      <Field label="Template name">
        <TextInput value={name} onChange={setName} />
      </Field>
      <p className="muted">
        Fields: {[...new Set(map.filter((s) => s && s !== 'text:' && s !== 'fmt:'))].map((s) => SOURCE_LABEL.get(s) ?? s).join(', ') || 'none'}
        {map.includes('fmt:') ? ', placeholders in texts' : ''}.
      </p>
    </Modal>
  );
}

const r1 = (v: number) => Math.round(v * 10) / 10;
