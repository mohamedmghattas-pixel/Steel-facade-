/**
 * Profile sketcher: draw a custom cross-section (outline, holes, thin walls)
 * with its insertion point, see the section properties live and save it as a
 * project custom profile. Geometry lives in core/library/sketch.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Vec2 } from '../core/model/types';
import {
  INSERTION_PRESETS,
  deleteLoop,
  deleteVertex,
  emptySketch,
  insertVertex,
  insertionPreset,
  loopId,
  mirrorSketch,
  moveVertex,
  parseCoord,
  pickSegment,
  pickVertex,
  setAllFillets,
  setFillet,
  shapeProps,
  sketchFromDef,
  sketchPreview,
  sketchToDef,
  sketchToShape,
  snapPoint,
  updateLoop,
  type InsertionPreset,
  type Sketch,
  type SketchLoop,
  type SnapKind,
} from '../core/library/sketch';
import { MATERIALS, getMaterial } from '../core/library/materials';
import { STEEL_DENSITY, type ProfileDef } from '../core/library/profiles';
import { parseProfileDxf } from '../core/library/profileDxf';
import { useStore } from '../state/store';
import { pickFile } from '../state/storage';
import { askConfirm } from './askState';
import { Field, NumberInput, Segmented, Select } from './widgets';
import { closeSketcher, exportProfileDxf, exportProfileJsonOne, openSketcher, saveCustomProfile } from './profileActions';
import { useProfileUi, type SketcherOpen } from './profileUiState';
import './profiles.css';

type Tool = 'select' | 'poly' | 'hole' | 'rect' | 'circle' | 'wall' | 'insert';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: 'Select / move', key: 'S', hint: 'Drag a vertex to move it; click a line to select its loop; drag the background to pan.' },
  { id: 'wall', label: 'Thin wall', key: 'W', hint: 'Click the centre-line points; Enter or double-click ends an open wall, clicking the first point closes it.' },
  { id: 'poly', label: 'Polyline', key: 'P', hint: 'Click the outline points; click the first point or press Enter to close. The first closed loop is the outline, later ones are holes.' },
  { id: 'hole', label: 'Hole', key: 'H', hint: 'Click the points of a hole (void); click the first point or press Enter to close.' },
  { id: 'rect', label: 'Rectangle', key: 'R', hint: 'Click two opposite corners.' },
  { id: 'circle', label: 'Circle', key: 'C', hint: 'Click the centre, then a point on the circle (a hole once there is an outline).' },
  { id: 'insert', label: 'Insertion point', key: 'I', hint: 'Click (with snaps) where the wire line runs through the section, or use the presets on the right.' },
];

const GRID_STEPS = [0.5, 1, 2, 5, 10, 25];
const f1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const f2 = (v: number) => (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Mounted once in App: shows the sketcher page while one is open. */
export function ProfileSketcherHost() {
  const open = useProfileUi((s) => s.sketcher);
  const key = useMemo(() => Math.random().toString(36), [open]);
  return open ? <ProfileSketcher key={key} open={open} /> : null;
}

function ProfileSketcher({ open }: { open: SketcherOpen }) {
  const [sketch, setSketchRaw] = useState<Sketch>(open.sketch);
  const [past, setPast] = useState<Sketch[]>([]);
  const [future, setFuture] = useState<Sketch[]>([]);
  const [saved, setSaved] = useState<string>(JSON.stringify([open.sketch, open.name, open.family, open.material]));
  const [editing, setEditing] = useState<string | null>(open.editing);
  const [name, setName] = useState(open.name);
  const [family, setFamily] = useState(open.family);
  const [material, setMaterial] = useState(open.material);
  const [tool, setTool] = useState<Tool>(open.sketch.loops.length ? 'select' : 'wall');
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<{ p: Vec2; kind: SnapKind; px: Vec2 } | null>(null);
  const [view, setView] = useState({ cx: 0, cy: -50, scale: 2.5 });
  const [grid, setGrid] = useState(1);
  const [snaps, setSnaps] = useState({ grid: true, vertices: true, midpoints: true, axes: true });
  const [wallT, setWallT] = useState(2);
  const [bend, setBend] = useState(0);
  const [sel, setSel] = useState<{ id: string; i: number } | null>(null);
  const [selLoop, setSelLoop] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [typedErr, setTypedErr] = useState(false);
  const [dxfChoices, setDxfChoices] = useState<ProfileDef[]>([]);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: 'vertex' | 'pan'; start: Vec2; view?: typeof view; moved: boolean } | null>(null);
  const customDefs = useStore((s) => s.project.library.profiles) as unknown as ProfileDef[];

  const commit = useCallback(
    (next: Sketch) => {
      setPast((p) => [...p.slice(-99), sketch]);
      setFuture([]);
      setSketchRaw(next);
    },
    [sketch],
  );
  const undo = () => {
    if (draft.length) return setDraft((d) => d.slice(0, -1));
    const prev = past[past.length - 1];
    if (!prev) return;
    setFuture((f) => [sketch, ...f]);
    setPast((p) => p.slice(0, -1));
    setSketchRaw(prev);
    setSel(null);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setPast((p) => [...p, sketch]);
    setFuture((f) => f.slice(1));
    setSketchRaw(next);
  };

  // Canvas size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.max(200, el.clientWidth), h: Math.max(200, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const result = useMemo(() => sketchToShape(sketch), [sketch]);
  const preview = useMemo(() => sketchPreview(sketch), [sketch]);
  const density = material ? getMaterial(material).density : STEEL_DENSITY;
  const props = useMemo(() => (result.shape ? shapeProps(result.shape, density) : null), [result, density]);
  const hasOuter = preview.some((l) => l.role === 'outer');

  // Fit the view to the drawing.
  const fit = useCallback(() => {
    const pts = preview.flatMap((l) => l.pts);
    if (sketch.insertion) pts.push(sketch.insertion);
    if (!pts.length) return setView({ cx: 0, cy: -50, scale: Math.min(size.w, size.h) / 260 });
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const s = Math.min(size.w / Math.max(1, (x1 - x0) * 1.35), size.h / Math.max(1, (y1 - y0) * 1.35), 60);
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: s });
  }, [preview, sketch.insertion, size]);
  const fitted = useRef(false);

  // Screen ↔ drawing.
  const toPx = (q: Vec2): Vec2 => ({ x: (q.x - view.cx) * view.scale + size.w / 2, y: size.h / 2 - (q.y - view.cy) * view.scale });
  const toMm = (px: number, py: number): Vec2 => ({ x: view.cx + (px - size.w / 2) / view.scale, y: view.cy + (size.h / 2 - py) / view.scale });
  const evPx = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const tol = 9 / view.scale;
  const snap = (raw: Vec2, shift = false) =>
    snapPoint(raw, sketch, {
      grid: snaps.grid ? grid : 0,
      tol,
      vertices: snaps.vertices,
      midpoints: snaps.midpoints,
      axes: snaps.axes,
      from: shift ? null : (draft[draft.length - 1] ?? null),
      extra: draft,
    });

  // Wheel zoom about the cursor (non-passive so the page does not scroll).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const x = v.cx + (px - size.w / 2) / v.scale;
        const y = v.cy + (size.h / 2 - py) / v.scale;
        const s = Math.min(400, Math.max(0.05, v.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
        return { cx: x - (px - size.w / 2) / s, cy: y - (size.h / 2 - py) / s, scale: s };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size]);

  // ---------------------------------------------------------------------------
  // Drawing

  const role = (): 'outer' | 'hole' => (hasOuter ? 'hole' : 'outer');
  const finish = (pts: Vec2[], closed: boolean) => {
    if (tool === 'wall') {
      if (pts.length < 2 || (closed && pts.length < 3)) return setDraft([]);
      const loop: SketchLoop = { id: loopId(), kind: 'wall', closed, t: wallT, pts: pts.map((q, i) => ({ x: q.x, y: q.y, ...(bend > 0 && (closed || (i > 0 && i < pts.length - 1)) ? { r: bend } : {}) })) };
      commit({ ...sketch, loops: [...sketch.loops, loop] });
      setSelLoop(loop.id);
    } else if (tool === 'poly' || tool === 'hole') {
      if (pts.length < 3) return setDraft([]);
      const loop: SketchLoop = { id: loopId(), kind: 'poly', role: tool === 'hole' ? 'hole' : role(), pts: pts.map((q) => ({ x: q.x, y: q.y })) };
      commit({ ...sketch, loops: [...sketch.loops, loop] });
      setSelLoop(loop.id);
    }
    setDraft([]);
  };
  const addPoint = (q: Vec2) => {
    if (tool === 'insert') {
      commit({ ...sketch, insertion: { x: q.x, y: q.y } });
      return;
    }
    if (tool === 'rect') {
      if (!draft.length) return setDraft([q]);
      const a = draft[0];
      if (Math.abs(q.x - a.x) < 1e-6 || Math.abs(q.y - a.y) < 1e-6) return;
      const [x0, x1] = [Math.min(a.x, q.x), Math.max(a.x, q.x)];
      const [y0, y1] = [Math.min(a.y, q.y), Math.max(a.y, q.y)];
      const loop: SketchLoop = { id: loopId(), kind: 'poly', role: role(), pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
      commit({ ...sketch, loops: [...sketch.loops, loop] });
      setSelLoop(loop.id);
      return setDraft([]);
    }
    if (tool === 'circle') {
      if (!draft.length) return setDraft([q]);
      const r = Math.hypot(q.x - draft[0].x, q.y - draft[0].y);
      if (r > 1e-6) {
        const loop: SketchLoop = { id: loopId(), kind: 'circle', role: role(), c: draft[0], r };
        commit({ ...sketch, loops: [...sketch.loops, loop] });
        setSelLoop(loop.id);
      }
      return setDraft([]);
    }
    if (tool === 'poly' || tool === 'hole' || tool === 'wall') {
      const first = draft[0];
      if (first && draft.length >= (tool === 'wall' ? 3 : 3) && Math.hypot(q.x - first.x, q.y - first.y) < 1e-6) return finish(draft, true);
      const last = draft[draft.length - 1];
      if (last && Math.hypot(q.x - last.x, q.y - last.y) < 1e-6) return;
      setDraft([...draft, q]);
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const px = evPx(e);
    const raw = toMm(px.x, px.y);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (e.button === 1 || e.button === 2 || (tool === 'select' && e.button === 0 && !pickVertex(sketch, raw, tol) && !pickSegment(sketch, raw, tol))) {
      if (tool === 'select' && e.button === 0) {
        setSel(null);
        setSelLoop(null);
      }
      drag.current = { kind: 'pan', start: px, view, moved: false };
      return;
    }
    if (e.button !== 0) return;
    if (tool === 'select') {
      const v = pickVertex(sketch, raw, tol);
      if (v) {
        setSel(v);
        setSelLoop(v.id);
        setPast((p) => [...p.slice(-99), sketch]);
        setFuture([]);
        drag.current = { kind: 'vertex', start: px, moved: false };
        return;
      }
      const s = pickSegment(sketch, raw, tol);
      if (s) {
        setSelLoop(s.id);
        setSel(null);
        if (e.altKey) commit(insertVertex(sketch, s.id, s.i, snap(s.at).p));
      }
      return;
    }
    addPoint(snap(raw, e.shiftKey).p);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const px = evPx(e);
    const raw = toMm(px.x, px.y);
    const d = drag.current;
    if (d?.kind === 'pan' && d.view) {
      d.moved = true;
      setView({ ...d.view, cx: d.view.cx - (px.x - d.start.x) / d.view.scale, cy: d.view.cy + (px.y - d.start.y) / d.view.scale });
      return;
    }
    const s = snap(raw, e.shiftKey);
    setCursor({ ...s, px });
    if (d?.kind === 'vertex' && sel) {
      d.moved = true;
      // Snap to other points, not to the vertex being moved.
      const others = { ...sketch, loops: sketch.loops.map((l) => (l.id === sel.id && l.kind !== 'circle' ? { ...l, pts: l.pts.filter((_, k) => k !== sel.i) } : l)) } as Sketch;
      const q = snapPoint(raw, others, { grid: snaps.grid ? grid : 0, tol, vertices: snaps.vertices, midpoints: snaps.midpoints, axes: snaps.axes });
      setSketchRaw(moveVertex(sketch, sel.id, sel.i, q.p));
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'vertex' && !d.moved) setPast((p) => p.slice(0, -1));
  };

  const applyTyped = () => {
    const last = draft[draft.length - 1] ?? (sel ? vertexAt(sketch, sel) : null);
    const q = parseCoord(typed, last);
    if (!q) return setTypedErr(true);
    setTypedErr(false);
    setTyped('');
    if (tool === 'select') {
      if (sel) commit(moveVertex(sketch, sel.id, sel.i, q));
      return;
    }
    addPoint(q);
  };

  // Keyboard: the sketcher owns the keys while it is open (the model's shortcuts must not fire).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      return redo();
    }
    if (mod) return;
    if (e.key === 'Enter') {
      if (draft.length) finish(draft, tool !== 'wall');
      return;
    }
    if (e.key === 'Escape') {
      if (draft.length) setDraft([]);
      else if (sel || selLoop) {
        setSel(null);
        setSelLoop(null);
      } else setTool('select');
      return;
    }
    if (e.key === 'Backspace' && draft.length) return setDraft((d) => d.slice(0, -1));
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel) {
        commit(deleteVertex(sketch, sel.id, sel.i));
        setSel(null);
      } else if (selLoop) {
        commit(deleteLoop(sketch, selLoop));
        setSelLoop(null);
      }
      return;
    }
    if (k === 'f') return fit();
    const tl = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (tl) {
      setTool(tl.id);
      setDraft([]);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  // ---------------------------------------------------------------------------
  // Actions

  const dirty = JSON.stringify([sketch, name, family, material]) !== saved;
  const close = async () => {
    if (dirty && sketch.loops.length && !(await askConfirm('Close the sketcher? Unsaved changes to this profile are lost.', { title: 'Profile sketcher', ok: 'Close without saving' }))) return;
    closeSketcher();
  };
  const currentDef = (): ProfileDef | null => {
    try {
      return sketchToDef(sketch, { name: name.trim() || 'Custom profile', family, material: material || undefined });
    } catch {
      return null;
    }
  };
  const save = async () => {
    if (!name.trim()) return useStore.getState().notify('Give the profile a name first (top right).', 'error');
    const def = currentDef();
    if (!def) return useStore.getState().notify(result.errors[0] ?? 'The sketch is not a valid section yet.', 'error');
    if (await saveCustomProfile(def, editing)) {
      setEditing(def.name);
      setSaved(JSON.stringify([sketch, name, family, material]));
    }
  };
  const importDxf = async () => {
    const f = await pickFile('.dxf');
    if (!f) return;
    try {
      const r = parseProfileDxf(await f.text(), { fileName: f.name });
      const ok = r.profiles.filter((x) => !x.error).map((x) => x.def);
      if (!ok.length) return useStore.getState().notify(`No closed outline found in ${f.name}${r.notes[0] ? `: ${r.notes[0]}` : ''}.`, 'error');
      setDxfChoices(ok.length > 1 ? ok : []);
      loadDef(ok[0]);
    } catch (e) {
      useStore.getState().notify(`Could not read ${f.name}: ${(e as Error).message}`, 'error');
    }
  };
  const loadDef = (def: ProfileDef) => {
    const sk = sketchFromDef(def);
    if (!sk) return;
    commit(sk);
    if (!name.trim() || dxfChoices.some((d) => d.name === name)) setName(def.name);
    setSel(null);
    setSelLoop(null);
    fitted.current = false;
  };
  // Fit once the canvas has its size, and after loading a profile.
  useEffect(() => {
    if (!fitted.current && size.w !== 800) {
      fitted.current = true;
      fit();
    }
  });

  const setPreset = (id: InsertionPreset) => result.shape && commit({ ...sketch, insertion: insertionPreset(result.shape, id) });
  const loop = sketch.loops.find((l) => l.id === selLoop);
  const vtx = sel ? vertexAt(sketch, sel) : null;
  const vtxR = sel && loop && loop.kind !== 'circle' ? (loop.pts[sel.i]?.r ?? 0) : 0;
  const polyNames = customDefs.filter((d) => d.shape?.type === 'POLY').map((d) => d.name);

  // ---------------------------------------------------------------------------
  // Render helpers

  const pathOf = (pts: Vec2[], closed: boolean) => (pts.length ? `M${pts.map((q) => toPx(q)).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('L')}${closed ? 'Z' : ''}` : '');
  const gridLines = useMemo(() => {
    const out: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const d = steps.find((s) => s * view.scale >= 9) ?? 1000;
    const major = d * (d === 2 || d === 20 || d === 200 ? 5 : 10);
    const m0 = toMm(0, size.h);
    const m1 = toMm(size.w, 0);
    for (let x = Math.ceil(m0.x / d) * d; x <= m1.x && out.length < 600; x += d) {
      const px = (x - view.cx) * view.scale + size.w / 2;
      out.push({ x1: px, y1: 0, x2: px, y2: size.h, major: Math.abs(x / major - Math.round(x / major)) < 1e-6 });
    }
    for (let y = Math.ceil(m0.y / d) * d; y <= m1.y && out.length < 1200; y += d) {
      const py = size.h / 2 - (y - view.cy) * view.scale;
      out.push({ x1: 0, y1: py, x2: size.w, y2: py, major: Math.abs(y / major - Math.round(y / major)) < 1e-6 });
    }
    return { lines: out, step: d };
  }, [view, size]);
  const axisX = toPx({ x: 0, y: 0 });
  const vertices = sketch.loops.flatMap((l) => (l.kind === 'circle' ? [{ id: l.id, i: 0, p: l.c, r: 0 }, { id: l.id, i: 1, p: { x: l.c.x + l.r, y: l.c.y }, r: 0 }] : l.pts.map((p, i) => ({ id: l.id, i, p, r: p.r ?? 0 }))));
  const ins = sketch.insertion ? toPx(sketch.insertion) : null;
  const rubber = draft.length && cursor ? (tool === 'rect' ? rectPts(draft[0], cursor.p) : tool === 'circle' ? circlePts(draft[0], Math.hypot(cursor.p.x - draft[0].x, cursor.p.y - draft[0].y)) : [...draft, cursor.p]) : draft;
  const hint = TOOLS.find((x) => x.id === tool)!.hint;

  return (
    <div className="sk-page" role="dialog" aria-label="Profile sketcher">
      <header className="sk-head">
        <h2>Profile sketcher{editing ? ` — ${editing}` : ' — new profile'}</h2>
        <div className="sk-head-tools">
          {polyNames.length > 0 && (
            <select
              aria-label="Open a custom profile"
              value=""
              onChange={async (e) => {
                const n = e.target.value;
                if (!n) return;
                if (dirty && sketch.loops.length && !(await askConfirm(`Open ${n}? Unsaved changes to this sketch are lost.`, { title: 'Profile sketcher', ok: 'Open' }))) return;
                openSketcher(n);
              }}
            >
              <option value="">Open custom profile…</option>
              {polyNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
          <button className="secondary-btn" onClick={() => void importDxf()} title="Load an outline from a DXF file">
            Import DXF…
          </button>
          {dxfChoices.length > 1 && (
            <select aria-label="Profile from the DXF" onChange={(e) => loadDef(dxfChoices[Number(e.target.value)])}>
              {dxfChoices.map((d, i) => (
                <option key={i} value={i}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <span className="sk-sep" />
          <button className="secondary-btn" disabled={!past.length && !draft.length} onClick={undo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button className="secondary-btn" disabled={!future.length} onClick={redo} title="Redo (Ctrl+Y)">
            Redo
          </button>
          <button className="secondary-btn" disabled={!sketch.loops.length} onClick={() => commit(mirrorSketch(sketch, { axis: 'x', at: 0 }))} title="Mirror about the vertical axis x = 0 (draw half, mirror the rest)">
            Mirror ⇆
          </button>
          <button className="secondary-btn" disabled={!sketch.loops.length} onClick={() => commit(mirrorSketch(sketch, { axis: 'y', at: 0 }))} title="Mirror about the horizontal axis y = 0">
            Mirror ⇅
          </button>
          <button className="secondary-btn" onClick={fit} title="Fit the drawing (F)">
            Fit
          </button>
          <button
            className="link-btn"
            disabled={!sketch.loops.length}
            onClick={async () => (await askConfirm('Clear the drawing?', { title: 'Profile sketcher', ok: 'Clear' })) && commit({ ...emptySketch(), insertion: sketch.insertion })}
          >
            Clear
          </button>
          <button className="icon-btn" onClick={() => void close()} aria-label="Close sketcher" title="Close">
            ×
          </button>
        </div>
      </header>
      <div className="sk-body">
        <nav className="sk-tools" aria-label="Sketch tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`sk-tool ${tool === t.id ? 'on' : ''}`}
              title={`${t.label} (${t.key})`}
              onClick={() => {
                setTool(t.id);
                setDraft([]);
              }}
            >
              <span className="sk-key">{t.key}</span> {t.label}
            </button>
          ))}
          {tool === 'wall' && (
            <div className="sk-toolopts">
              <Field label="Wall thickness">
                <NumberInput value={wallT} unit="mm" min={0.1} onChange={setWallT} />
              </Field>
              <Field label="Inner bend radius">
                <NumberInput value={bend} unit="mm" min={0} onChange={setBend} />
              </Field>
            </div>
          )}
          <div className="sk-toolopts">
            <Field label="Snap grid">
              <Select value={String(grid)} options={GRID_STEPS.map((g) => ({ value: String(g), label: `${g} mm` }))} onChange={(v) => setGrid(Number(v))} />
            </Field>
            {(['grid', 'vertices', 'midpoints', 'axes'] as const).map((k) => (
              <label key={k} className="sk-check">
                <input type="checkbox" checked={snaps[k]} onChange={(e) => setSnaps({ ...snaps, [k]: e.target.checked })} /> {k === 'axes' ? 'axes / origin' : k}
              </label>
            ))}
            <p className="muted sk-small">Shift: no ortho lock. Alt+click a line: add a vertex. Wheel: zoom, drag background / right button: pan.</p>
          </div>
        </nav>
        <div className="sk-canvas-wrap" ref={wrapRef}>
          <svg
            ref={svgRef}
            className={`sk-canvas tool-${tool}`}
            width={size.w}
            height={size.h}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            onDoubleClick={() => draft.length >= 2 && finish(draft.slice(0, draft.length), tool !== 'wall')}
            onContextMenu={(e) => e.preventDefault()}
          >
            <g className="sk-grid">
              {gridLines.lines.map((l, i) => (
                <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={l.major ? 'major' : ''} />
              ))}
            </g>
            <line className="sk-axis" x1={axisX.x} y1={0} x2={axisX.x} y2={size.h} />
            <line className="sk-axis" x1={0} y1={axisX.y} x2={size.w} y2={axisX.y} />
            {props && (
              <g className="sk-box">
                <rect x={toPx({ x: props.box.minX, y: props.box.maxY }).x} y={toPx({ x: props.box.minX, y: props.box.maxY }).y} width={props.box.w * view.scale} height={props.box.h * view.scale} />
                {[0, 0.5, 1].flatMap((fx) => [0, 0.5, 1].map((fy) => toPx({ x: props.box.minX + fx * props.box.w, y: props.box.minY + fy * props.box.h }))).map((q, i) => (
                  <circle key={i} cx={q.x} cy={q.y} r={2.5} />
                ))}
              </g>
            )}
            <path className="sk-fill" fillRule="evenodd" d={preview.filter((l) => l.role !== 'centre').map((l) => pathOf(l.pts, true)).join(' ')} />
            {preview.map((l, i) =>
              l.role === 'centre' ? (
                <path key={i} className={`sk-centre ${l.id === selLoop ? 'sel' : ''}`} d={pathOf(l.pts, l.closed)} />
              ) : (
                <path key={i} className={`sk-edge ${l.role} ${l.id === selLoop ? 'sel' : ''}`} d={pathOf(l.pts, true)} />
              ),
            )}
            {props && (
              <g className="sk-centroid" transform={`translate(${toPx(props.centroid).x},${toPx(props.centroid).y})`}>
                <circle r={5} />
                <line x1={-5} y1={0} x2={5} y2={0} />
                <line x1={0} y1={-5} x2={0} y2={5} />
                <title>Centroid</title>
              </g>
            )}
            {vertices.map((v) => {
              const q = toPx(v.p);
              const on = sel && sel.id === v.id && sel.i === v.i;
              return (
                <g key={`${v.id}:${v.i}`}>
                  <rect className={`sk-vtx ${on ? 'on' : ''}`} x={q.x - 3.5} y={q.y - 3.5} width={7} height={7} />
                  {v.r > 0 && (
                    <text className="sk-label" x={q.x + 6} y={q.y - 6}>
                      R{f1(v.r)}
                    </text>
                  )}
                </g>
              );
            })}
            {rubber.length > 0 && <path className="sk-rubber" d={pathOf(rubber, tool === 'rect' || tool === 'circle')} />}
            {draft.map((q, i) => {
              const p = toPx(q);
              return <rect key={i} className="sk-vtx draft" x={p.x - 3} y={p.y - 3} width={6} height={6} />;
            })}
            {ins && (
              <g className="sk-ins" transform={`translate(${ins.x},${ins.y})`}>
                <circle r={7} />
                <line x1={-12} y1={0} x2={12} y2={0} />
                <line x1={0} y1={-12} x2={0} y2={12} />
                <title>Insertion point (wire line)</title>
              </g>
            )}
            {cursor && tool !== 'select' && (
              <g className={`sk-snap ${cursor.kind}`} transform={`translate(${toPx(cursor.p).x},${toPx(cursor.p).y})`}>
                <rect x={-5} y={-5} width={10} height={10} />
                {cursor.kind !== 'grid' && cursor.kind !== 'none' && (
                  <text x={8} y={-8}>
                    {cursor.kind}
                  </text>
                )}
              </g>
            )}
          </svg>
          <div className="sk-status">
            <span className="mono">{cursor ? `x ${f2(cursor.p.x)}  y ${f2(cursor.p.y)} mm` : ' '}</span>
            <span className="muted">grid {gridLines.step} mm</span>
            <span className="sk-hint">{hint}</span>
          </div>
          <div className="sk-legend" aria-hidden="true">
            x → member local y · y ↑ member local z (mullions: towards +Y, the building side) · rotate members 180° to flip
          </div>
          <form
            className="sk-typed"
            onSubmit={(e) => {
              e.preventDefault();
              applyTyped();
            }}
          >
            <label htmlFor="sk-typed">{tool === 'select' ? 'Move vertex to' : tool === 'insert' ? 'Insertion point' : 'Point'}</label>
            <input
              id="sk-typed"
              className={typedErr ? 'err' : ''}
              value={typed}
              placeholder="x,y   @dx,dy   @L<angle"
              onChange={(e) => {
                setTyped(e.target.value);
                setTypedErr(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setTyped('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <button className="secondary-btn" type="submit">
              Enter
            </button>
            {draft.length > 0 && (
              <button className="secondary-btn" type="button" onClick={() => finish(draft, tool !== 'wall')}>
                {tool === 'wall' ? 'Finish wall' : 'Close loop'}
              </button>
            )}
          </form>
        </div>
        <aside className="sk-side">
          <section>
            <Field label="Profile name">
              <input value={name} placeholder="e.g. Alu mullion 50x150" onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="row2">
              <Field label="Family">
                <input value={family} onChange={(e) => setFamily(e.target.value)} />
              </Field>
              <Field label="Material">
                <Select value={material} options={[{ value: '', label: 'Steel (member material)' }, ...MATERIALS.map((m) => ({ value: m.name, label: m.name }))]} onChange={setMaterial} />
              </Field>
            </div>
          </section>
          <section>
            <h4>Insertion point (wire line)</h4>
            <div className="sk-ins-grid">
              {INSERTION_PRESETS.filter((p) => p.id !== 'centroid').map((p) => (
                <button key={p.id} className="chip" disabled={!result.shape} title={p.label} aria-label={`Insertion point: ${p.label.toLowerCase()}`} onClick={() => setPreset(p.id)}>
                  <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
                    <rect x="2" y="2" width="18" height="12" className="sk-pre-box" />
                    <circle cx={p.id[1] === 'l' ? 2 : p.id[1] === 'r' ? 20 : 11} cy={p.id[0] === 't' ? 2 : p.id[0] === 'b' ? 14 : 8} r="2.6" className="sk-pre-dot" />
                  </svg>
                </button>
              ))}
            </div>
            <div className="btn-row">
              <button className="chip" disabled={!result.shape} onClick={() => setPreset('centroid')}>
                Centroid
              </button>
              <button className={`chip ${tool === 'insert' ? 'on' : ''}`} onClick={() => setTool('insert')}>
                Pick on drawing
              </button>
              <button className="chip" disabled={!sketch.insertion} onClick={() => commit({ ...sketch, insertion: null })}>
                None
              </button>
            </div>
            <div className="row2">
              <Field label="x">
                <NumberInput value={sketch.insertion?.x} unit="mm" onChange={(v) => commit({ ...sketch, insertion: { x: v, y: sketch.insertion?.y ?? 0 } })} />
              </Field>
              <Field label="y">
                <NumberInput value={sketch.insertion?.y} unit="mm" onChange={(v) => commit({ ...sketch, insertion: { x: sketch.insertion?.x ?? 0, y: v } })} />
              </Field>
            </div>
          </section>
          {loop && (
            <section className="sk-sel">
              <h4>
                {loop.kind === 'wall' ? 'Thin wall' : loop.kind === 'circle' ? 'Circle' : 'Polyline'}
                <button className="link-btn" onClick={() => (commit(deleteLoop(sketch, loop.id)), setSelLoop(null), setSel(null))}>
                  Delete
                </button>
              </h4>
              {loop.kind !== 'wall' && (
                <Segmented<'outer' | 'hole'> value={loop.role} options={[{ value: 'outer', label: 'Outline' }, { value: 'hole', label: 'Hole' }]} onChange={(v) => commit(updateLoop(sketch, loop.id, { role: v }))} />
              )}
              {loop.kind === 'wall' && (
                <div className="row2">
                  <Field label="Thickness">
                    <NumberInput value={loop.t} unit="mm" min={0.1} onChange={(v) => commit(updateLoop(sketch, loop.id, { t: v }))} />
                  </Field>
                  <Field label="Ends">
                    <Segmented<string> value={loop.closed ? 'closed' : 'open'} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} onChange={(v) => commit(updateLoop(sketch, loop.id, { closed: v === 'closed' }))} />
                  </Field>
                </div>
              )}
              {loop.kind === 'circle' && (
                <Field label="Radius">
                  <NumberInput value={loop.r} unit="mm" min={0.01} onChange={(v) => commit(updateLoop(sketch, loop.id, { r: v }))} />
                </Field>
              )}
              {loop.kind !== 'circle' && (
                <Field label={loop.kind === 'wall' ? 'All bends: inner radius' : 'All corners: fillet radius'}>
                  <NumberInput value={undefined} unit="mm" min={0} onChange={(v) => commit(setAllFillets(sketch, loop.id, v))} />
                </Field>
              )}
              {sel && vtx && loop.kind !== 'circle' && (
                <>
                  <p className="muted sk-small">Vertex {sel.i + 1} of {loop.pts.length}</p>
                  <div className="row3">
                    <Field label="x">
                      <NumberInput value={vtx.x} unit="mm" onChange={(v) => commit(moveVertex(sketch, sel.id, sel.i, { x: v, y: vtx.y }))} />
                    </Field>
                    <Field label="y">
                      <NumberInput value={vtx.y} unit="mm" onChange={(v) => commit(moveVertex(sketch, sel.id, sel.i, { x: vtx.x, y: v }))} />
                    </Field>
                    <Field label={loop.kind === 'wall' ? 'Bend r' : 'Fillet r'}>
                      <NumberInput value={vtxR} unit="mm" min={0} onChange={(v) => commit(setFillet(sketch, sel.id, sel.i, v))} />
                    </Field>
                  </div>
                  <button className="link-btn" onClick={() => (commit(deleteVertex(sketch, sel.id, sel.i)), setSel(null))}>
                    Delete vertex
                  </button>
                </>
              )}
            </section>
          )}
          <section>
            <h4>Section properties</h4>
            {props ? (
              <dl className="sk-props">
                <dt>Box b × h</dt>
                <dd>
                  {f1(props.box.w)} × {f1(props.box.h)} mm
                </dd>
                <dt>Area A</dt>
                <dd>{f2(props.area / 100)} cm²</dd>
                <dt>Mass</dt>
                <dd>
                  {f2(props.mass)} kg/m <span className="muted">({material || 'steel'})</span>
                </dd>
                <dt>Centroid</dt>
                <dd>
                  {f1(props.centroid.x)}, {f1(props.centroid.y)} mm
                </dd>
                <dt>Iy / Iz</dt>
                <dd>
                  {f2(props.Iy / 1e4)} / {f2(props.Iz / 1e4)} cm⁴
                </dd>
                <dt>Wy / Wz</dt>
                <dd>
                  {f2(props.Wy / 1e3)} / {f2(props.Wz / 1e3)} cm³
                </dd>
                <dt>iy / iz</dt>
                <dd>
                  {f1(props.iy ?? 0)} / {f1(props.iz ?? 0)} mm
                </dd>
                <dt>Surface</dt>
                <dd>{props.surface.toFixed(3)} m²/m</dd>
              </dl>
            ) : (
              <p className="muted">Draw a closed outline to see the properties.</p>
            )}
            {result.errors.map((m, i) => (
              <p key={`e${i}`} className="warning">
                {m}
              </p>
            ))}
            {result.shape &&
              result.warnings.map((m, i) => (
                <p key={`w${i}`} className="muted sk-small">
                  {m}
                </p>
              ))}
            <p className="muted sk-small">Iy about the horizontal centroid axis (member local y), Iz about the vertical one; W to the extreme fibre.</p>
          </section>
          <footer className="sk-actions">
            <button className="primary-btn" disabled={!result.shape} onClick={() => void save()}>
              {editing ? (name.trim() && name.trim() !== editing ? `Save as ${name.trim()} (rename)` : 'Update profile') : 'Save as custom profile'}
            </button>
            <div className="btn-row">
              <button className="secondary-btn" disabled={!result.shape} onClick={() => currentDef() && exportProfileDxf(currentDef()!)}>
                Export DXF
              </button>
              <button className="secondary-btn" disabled={!result.shape} onClick={() => currentDef() && exportProfileJsonOne(currentDef()!)}>
                Export JSON
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </div>
  );
}

function vertexAt(s: Sketch, v: { id: string; i: number }): Vec2 | null {
  const l = s.loops.find((x) => x.id === v.id);
  if (!l) return null;
  if (l.kind === 'circle') return v.i === 0 ? l.c : { x: l.c.x + l.r, y: l.c.y };
  const p = l.pts[v.i];
  return p ? { x: p.x, y: p.y } : null;
}

function rectPts(a: Vec2, b: Vec2): Vec2[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}

function circlePts(c: Vec2, r: number): Vec2[] {
  return Array.from({ length: 48 }, (_, i) => ({ x: c.x + r * Math.cos((i / 48) * 2 * Math.PI), y: c.y + r * Math.sin((i / 48) * 2 * Math.PI) }));
}
