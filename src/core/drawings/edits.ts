/**
 * Manual drawing edits, stored per drawing id in `project.drawings.edits` and
 * applied on top of the generated sheet (before it is fingerprinted, so edits
 * count as content):
 * - views and blocks moved as a whole (their dimensions move with them),
 * - dimension lines offset perpendicular to themselves (extension lines follow),
 * - generated items hidden,
 * - free notes, optionally with a leader line (ISO 128-22 leader with a short
 *   reference line and a closed filled arrowhead on the feature it points at),
 * - revision clouds (scalloped outline) tagged with a revision index (ISO 7200).
 *
 * Generated entities carry stable ids and groups (see EntTag), so edits survive
 * regeneration as long as the item still exists.
 */
import type { DrawingEdits, Project, Vec2 } from '../model/types';
import type { DEnt, Drawing } from './types';
import { Sheet } from './dims';
import { TEXT } from './standards';
import { entsBox, moveEnt, textExtent, type BBox } from './viewLayout';

export type DrawingNote = DrawingEdits['notes'][number];
export type DrawingCloud = DrawingEdits['clouds'][number];

export const emptyEdits = (): DrawingEdits => ({ views: {}, dims: {}, hidden: [], notes: [], clouds: [] });

/** Fills in missing keys (older or hand-written files). */
export function normEdits(e?: Partial<DrawingEdits> | null): DrawingEdits {
  return { views: e?.views ?? {}, dims: e?.dims ?? {}, hidden: e?.hidden ?? [], notes: e?.notes ?? [], clouds: e?.clouds ?? [] };
}

/** Does this edit set change anything? */
export function hasEdits(e: Partial<DrawingEdits> | undefined | null): boolean {
  if (!e) return false;
  return (
    Object.values(e.views ?? {}).some((v) => v && (v.x || v.y)) ||
    Object.values(e.dims ?? {}).some((v) => !!v) ||
    (e.hidden?.length ?? 0) > 0 ||
    (e.notes?.length ?? 0) > 0 ||
    (e.clouds?.length ?? 0) > 0
  );
}

/** Offsets a dimension entity along its axis; extension lines only stretch. */
function shiftDim(e: DEnt, axis: 'x' | 'y', d: number): DEnt {
  const v = axis === 'x' ? { x: d, y: 0 } : { x: 0, y: d };
  if (e.stretch && e.t === 'line') return { ...e, b: { x: e.b.x + v.x, y: e.b.y + v.y } };
  return moveEnt(e, v);
}

/** The generated entities with the edits applied, followed by the notes and clouds. */
export function applyEdits(ents: DEnt[], edits: Partial<DrawingEdits> | undefined | null): DEnt[] {
  if (!hasEdits(edits)) return ents;
  const e = normEdits(edits);
  const hidden = new Set(e.hidden);
  const out: DEnt[] = [];
  for (const en of ents) {
    if ((en.id && hidden.has(en.id)) || (en.group && hidden.has(en.group))) continue;
    let m = en;
    const v = en.group ? e.views[en.group] : undefined;
    if (v && (v.x || v.y)) m = moveEnt(m, v);
    const d = en.id && en.shift ? e.dims[en.id] : 0;
    if (d) m = shiftDim(m, en.shift!, d);
    out.push(m);
  }
  const s = new Sheet(0, 0, 'edits');
  for (const n of e.notes) drawNote(s, n);
  for (const c of e.clouds) drawCloud(s, c);
  return out.concat(s.ents);
}

// ---------------------------------------------------------------------------
// Notes and leaders

/** Line spacing of multi-line notes (ISO 3098: at least 10/7 of the lettering height). */
const LINE_SPACING = 1.6;

/** Lines of a note; `p` is the baseline start of the first line, further lines go down. */
export function noteLines(n: DrawingNote): string[] {
  return n.text.split(/\r?\n/).map((l) => l.trimEnd());
}

export function drawNote(s: Sheet, n: DrawingNote) {
  const h = n.h && n.h > 0 ? n.h : TEXT.small;
  const lines = noteLines(n);
  s.withTag({ id: n.id }, () => {
    lines.forEach((t, i) => s.text({ x: n.p.x, y: n.p.y - i * h * LINE_SPACING }, t, h, 'start', 'text'));
    if (!n.leader) return;
    const w = Math.max(1, ...lines.map((l) => textExtent(l, h)));
    const mid = n.p.y + h * 0.4;
    const toLeft = n.leader.x < n.p.x + w / 2;
    const start = { x: toLeft ? n.p.x - 1 : n.p.x + w + 1, y: mid };
    const shoulder = { x: start.x + (toLeft ? -3 : 3), y: mid };
    s.line(start, shoulder, 'dim');
    s.line(shoulder, n.leader, 'dim');
    const L = Math.hypot(n.leader.x - shoulder.x, n.leader.y - shoulder.y);
    if (L > 0.5) s.arrow(n.leader, { x: (n.leader.x - shoulder.x) / L, y: (n.leader.y - shoulder.y) / L });
  });
}

// ---------------------------------------------------------------------------
// Revision clouds

const signedArea = (pts: Vec2[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

/**
 * Scalloped outline of a closed polygon: circular arcs of about `arc` mm chord
 * bulging outwards (sagitta 0.4 × chord), sampled as a closed polyline.
 */
export function cloudPath(pts: Vec2[], arc = 8): Vec2[] {
  if (pts.length < 2) return [];
  const sgn = signedArea(pts) >= 0 ? 1 : -1;
  const out: Vec2[] = [];
  const m = 6;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const along = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const outward = { x: sgn * along.y, y: -sgn * along.x };
    const k = Math.max(1, Math.round(len / arc));
    const c = len / k;
    const hS = 0.4 * c;
    const R = (c * c) / 4 / (2 * hS) + hS / 2;
    const th = Math.asin(Math.min(1, c / (2 * R)));
    for (let j = 0; j < k; j++) {
      const p0 = { x: a.x + along.x * c * j, y: a.y + along.y * c * j };
      const mid = { x: p0.x + (along.x * c) / 2, y: p0.y + (along.y * c) / 2 };
      const ctr = { x: mid.x + outward.x * (hS - R), y: mid.y + outward.y * (hS - R) };
      for (let q = 0; q < m; q++) {
        const phi = -th + (2 * th * q) / m;
        out.push({
          x: ctr.x + R * (Math.cos(phi) * outward.x + Math.sin(phi) * along.x),
          y: ctr.y + R * (Math.cos(phi) * outward.y + Math.sin(phi) * along.y),
        });
      }
    }
  }
  return out;
}

/** Revision cloud with its revision triangle (index inside) at the top-right corner. */
export function drawCloud(s: Sheet, c: DrawingCloud) {
  const path = cloudPath(c.pts);
  if (path.length < 3) return;
  s.withTag({ id: c.id }, () => {
    s.poly(path, true, 'medium');
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of c.pts) {
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const cx = x1 + 3;
    const cy = y1 + 3;
    s.poly(
      [
        { x: cx - 3.5, y: cy - 2.02 },
        { x: cx + 3.5, y: cy - 2.02 },
        { x: cx, y: cy + 4.04 },
      ],
      true,
      'medium',
    );
    s.text({ x: cx, y: cy - 1.4 }, c.rev || '?', TEXT.label, 'middle', 'text', 0, true);
  });
}

/** Rectangle corners (counter-clockwise) from two opposite corners. */
export function rectPts(a: Vec2, b: Vec2): Vec2[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

// ---------------------------------------------------------------------------
// Picking

export type PickKind = 'dim' | 'note' | 'cloud' | 'item' | 'group';

export interface PickHit {
  /** Item id under the pointer (dimension, balloon, note …), if any. */
  id?: string;
  /** Group (view / block) the item belongs to. */
  group?: string;
  kind: PickKind;
  /** Dimensions: the offset axis. */
  shift?: 'x' | 'y';
  /** Distance from the point, mm. */
  d: number;
}

export const isNoteId = (id: string | undefined) => !!id && id.startsWith('note:');
export const isCloudId = (id: string | undefined) => !!id && id.startsWith('cloud:');

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

function inPoly(pts: Vec2[], p: Vec2): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const boxDist = (b: BBox, p: Vec2) => Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1));

/** Distance from `p` to an entity on paper (0 inside closed outlines, text boxes and images). */
export function entDistance(e: DEnt, p: Vec2): number {
  switch (e.t) {
    case 'line':
      return segDist(p, e.a, e.b);
    case 'circle': {
      const d = Math.hypot(p.x - e.c.x, p.y - e.c.y);
      return d <= e.r && (e.fill || e.r < 6) ? 0 : Math.abs(d - e.r);
    }
    case 'poly': {
      if (e.closed && e.pts.length >= 3 && inPoly(e.pts, p)) return 0;
      let best = Infinity;
      const n = e.pts.length;
      for (let i = 0; i < n - (e.closed ? 0 : 1); i++) best = Math.min(best, segDist(p, e.pts[i], e.pts[(i + 1) % n]));
      return best;
    }
    case 'text':
    case 'image':
      return boxDist(entsBox([e]), p);
  }
}

/**
 * The editable item nearest to `p` within `tol` mm. Items with their own id
 * (dimensions, notes, balloons …) win over bare view geometry; untagged
 * entities (frame, title block, revision table) cannot be picked.
 */
export function pickEntity(d: Drawing, p: Vec2, tol = 2): PickHit | null {
  let best: { e: DEnt; d: number } | null = null;
  for (const e of d.entities) {
    if (!e.id && !e.group) continue;
    const dist = entDistance(e, p);
    if (dist > tol) continue;
    // Prefer items over plain view geometry; then the nearest; then the one drawn last (on top).
    const score = dist - (e.id ? 1.5 : 0);
    const bs = best ? best.d - (best.e.id ? 1.5 : 0) : Infinity;
    if (!best || score <= bs) best = { e, d: dist };
  }
  if (!best) return null;
  const e = best.e;
  const kind: PickKind = isNoteId(e.id) ? 'note' : isCloudId(e.id) ? 'cloud' : e.id && e.shift ? 'dim' : e.id ? 'item' : 'group';
  return { id: e.id, group: e.group, kind, shift: e.shift, d: best.d };
}

/** Entities of an item (by id) or of a group. */
export function itemEntities(d: Drawing, key: { id?: string; group?: string }): DEnt[] {
  if (key.id) return d.entities.filter((e) => e.id === key.id);
  if (key.group) return d.entities.filter((e) => e.group === key.group);
  return [];
}

export function itemBox(d: Drawing, key: { id?: string; group?: string }): BBox | null {
  const ents = itemEntities(d, key);
  if (!ents.length) return null;
  return entsBox(ents);
}

export interface EditableItem {
  key: string;
  kind: PickKind;
  group?: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** Every editable item and group of a sheet, with its extent (for listing and the assistant). */
export function editableItems(d: Drawing): EditableItem[] {
  const map = new Map<string, { kind: PickKind; group?: string; ents: DEnt[] }>();
  for (const e of d.entities) {
    if (e.group) {
      const g = map.get(e.group) ?? { kind: 'group' as PickKind, ents: [] };
      g.ents.push(e);
      map.set(e.group, g);
    }
    if (e.id) {
      const kind: PickKind = isNoteId(e.id) ? 'note' : isCloudId(e.id) ? 'cloud' : e.shift ? 'dim' : 'item';
      const it = map.get(e.id) ?? { kind, group: e.group, ents: [] };
      it.ents.push(e);
      map.set(e.id, it);
    }
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  return [...map].map(([key, v]) => {
    const b = entsBox(v.ents);
    return { key, kind: v.kind, group: v.group, box: { x0: r(b.x0), y0: r(b.y0), x1: r(b.x1), y1: r(b.y1) } };
  });
}

// ---------------------------------------------------------------------------
// Mutators (on a project draft inside `apply`)

let seq = 0;
/** Unique id for a note / cloud ("note:…", "cloud:…"). */
export function markupId(kind: 'note' | 'cloud'): string {
  seq = (seq + 1) % 1e6;
  return `${kind}:${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** The edits of a drawing, created when missing. */
export function editsOf(p: Project, drawingId: string): DrawingEdits {
  p.drawings.edits ??= {};
  const e = normEdits(p.drawings.edits[drawingId]);
  p.drawings.edits[drawingId] = e;
  return e;
}

/** Drops the edit entry when nothing is left in it. */
export function tidyEdits(p: Project, drawingId: string) {
  const e = p.drawings.edits?.[drawingId];
  if (!e) return;
  for (const [k, v] of Object.entries(e.views)) if (!v || (!v.x && !v.y)) delete e.views[k];
  for (const [k, v] of Object.entries(e.dims)) if (!v) delete e.dims[k];
  if (!hasEdits(e)) delete p.drawings.edits[drawingId];
}

const r1 = (v: number) => Math.round(v);

export function moveGroup(p: Project, drawingId: string, group: string, d: Vec2) {
  const e = editsOf(p, drawingId);
  const cur = e.views[group] ?? { x: 0, y: 0 };
  e.views[group] = { x: r1(cur.x + d.x), y: r1(cur.y + d.y) };
  tidyEdits(p, drawingId);
}

export function offsetDim(p: Project, drawingId: string, dimId: string, delta: number) {
  const e = editsOf(p, drawingId);
  e.dims[dimId] = r1((e.dims[dimId] ?? 0) + delta);
  tidyEdits(p, drawingId);
}

export function hideItem(p: Project, drawingId: string, key: string) {
  const e = editsOf(p, drawingId);
  if (isNoteId(key)) e.notes = e.notes.filter((n) => n.id !== key);
  else if (isCloudId(key)) e.clouds = e.clouds.filter((c) => c.id !== key);
  else if (!e.hidden.includes(key)) e.hidden.push(key);
  tidyEdits(p, drawingId);
}

export function unhideItem(p: Project, drawingId: string, key?: string) {
  const e = editsOf(p, drawingId);
  e.hidden = key ? e.hidden.filter((h) => h !== key) : [];
  tidyEdits(p, drawingId);
}

export function addNote(p: Project, drawingId: string, note: Omit<DrawingNote, 'id'> & { id?: string }): string {
  const e = editsOf(p, drawingId);
  const id = note.id ?? markupId('note');
  e.notes.push({ ...note, id, p: { x: r1(note.p.x), y: r1(note.p.y) }, leader: note.leader ? { x: r1(note.leader.x), y: r1(note.leader.y) } : undefined });
  if (!e.notes[e.notes.length - 1].leader) delete e.notes[e.notes.length - 1].leader;
  return id;
}

export function addCloud(p: Project, drawingId: string, pts: Vec2[], rev: string): string {
  const e = editsOf(p, drawingId);
  const id = markupId('cloud');
  e.clouds.push({ id, pts: pts.map((q) => ({ x: r1(q.x), y: r1(q.y) })), rev });
  return id;
}

/** Moves a note (its leader end stays on the feature) or a cloud. */
export function moveMarkup(p: Project, drawingId: string, id: string, d: Vec2) {
  const e = editsOf(p, drawingId);
  const n = e.notes.find((x) => x.id === id);
  if (n) n.p = { x: r1(n.p.x + d.x), y: r1(n.p.y + d.y) };
  const c = e.clouds.find((x) => x.id === id);
  if (c) c.pts = c.pts.map((q) => ({ x: r1(q.x + d.x), y: r1(q.y + d.y) }));
}

export function resetEdits(p: Project, drawingId: string) {
  if (p.drawings.edits) delete p.drawings.edits[drawingId];
}
