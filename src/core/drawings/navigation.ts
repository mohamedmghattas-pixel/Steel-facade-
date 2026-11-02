/**
 * Navigation between the 3D model and the drawing set (docs/ASSEMBLIES.md §4).
 *
 * Drawing entities carry navigation tags (`EntTag.nav`: assembly / part mark,
 * assembly instance, part ref, sheet) next to their geometry — data only, so
 * fingerprints do not change. From them and the derived model this module
 * builds an index:
 * - part mark → part drawing, assembly mark → assembly drawing;
 * - assembly instance (its main part ref) → the GA / zone / erection / section
 *   sheets that show it, best first (its mark placed > listed in the zone >
 *   only drawn), with the box of its mark for highlighting;
 * and answers the reverse questions: what a sheet stands for in 3D (all
 * instances of a mark, a zone's assemblies), and what a click on a mark,
 * balloon, list row or part outline selects.
 *
 * Pure: no DOM, no store. The index is cached per derived model (and drawing list).
 */
import type { PartRef } from '../connections/common';
import { assemblyByPart, type Assembly, type DerivedModel } from '../derive/model';
import type { DEnt, DrawNav, Drawing, DrawingKind } from './types';
import { entsBox, type BBox } from './viewLayout';
import { entDistance } from './edits';
import { sheetLabel } from './register';
import type { DrawingSet } from './onDemand';

/** A sheet that shows an assembly instance. */
export interface NavSheet {
  id: string;
  number: string;
  /** Identification number with the sheet of a multi-sheet drawing: "FS-001-ES-01 (2/3)". */
  label: string;
  kind: DrawingKind;
  title: string;
  /** 3 = its mark is placed on the sheet, 2 = listed in the sheet's zone, 1 = only drawn. */
  score: number;
  /** Paper box of the mark (or outline) to highlight. */
  box?: BBox;
}

export interface DrawingIndex {
  /** Part mark → part drawing id. */
  parts: Map<string, string>;
  /** Assembly mark → assembly drawing id (its first sheet). */
  assemblies: Map<string, string>;
  /** Assembly instance (main part ref) → sheets showing it, best first. */
  instances: Map<PartRef, NavSheet[]>;
  byId: Map<string, Drawing>;
}

/** Sheets that show the model in a view (GA, zone, erection, section / detail). */
export const VIEW_KINDS: ReadonlySet<DrawingKind> = new Set(['ga', 'sequence', 'setout', 'section']);
const KIND_RANK: Partial<Record<DrawingKind, number>> = { ga: 0, sequence: 1, setout: 2, section: 3 };

const isMarkEnt = (e: DEnt) => !!e.id && (e.id.startsWith('mark:') || e.id.startsWith('balloon:'));

/** How a view sheet shows an assembly instance: its score and the box of its mark (or outlines). */
export interface SheetHit {
  score: number;
  box?: BBox;
}

/**
 * The assembly instances a GA / zone / erection / section sheet shows (by main part
 * ref): 3 = its mark is placed, 2 = listed in the sheet's zone, 1 = only drawn.
 * Empty for other sheets. `byId`: assemblies by id (zone lists name them by id).
 */
export function sheetHits(d: Drawing, byId: ReadonlyMap<string, Assembly>): Map<PartRef, SheetHit> {
  const out = new Map<PartRef, SheetHit>();
  if (!VIEW_KINDS.has(d.kind)) return out;
  const hits = new Map<PartRef, { score: number; ents: DEnt[] }>();
  const hit = (inst: PartRef, score: number, e?: DEnt) => {
    const h = hits.get(inst);
    if (!h) hits.set(inst, { score, ents: e ? [e] : [] });
    else if (score > h.score) {
      h.score = score;
      h.ents = e ? [e] : [];
    } else if (score === h.score && e) h.ents.push(e);
  };
  for (const e of d.entities) {
    const inst = e.nav?.inst;
    if (inst) hit(inst, isMarkEnt(e) ? 3 : 1, e);
  }
  for (const id of d.zone?.assemblies ?? []) {
    const a = byId.get(id);
    if (a) hit(a.main, 2);
  }
  for (const [inst, h] of hits) out.set(inst, { score: h.score, ...(h.ents.length ? { box: entsBox(h.ents) } : {}) });
  return out;
}

/** Sheets showing an instance, best first: by score, then GA › sequence › setting-out › section, then register order. */
export function sortNavSheets(list: NavSheet[], order: (id: string) => number) {
  list.sort((a, b) => b.score - a.score || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || order(a.id) - order(b.id));
}

/** Builds the index from a drawing set (allDrawings) and the derived model it was made from. */
export function buildDrawingIndex(dm: DerivedModel, drawings: Drawing[]): DrawingIndex {
  const idx: DrawingIndex = { parts: new Map(), assemblies: new Map(), instances: new Map(), byId: new Map() };
  const byId = new Map(dm.assemblies.map((a) => [a.id, a]));
  const order = new Map<string, number>();
  drawings.forEach((d, i) => {
    idx.byId.set(d.id, d);
    order.set(d.id, i);
    if (d.kind === 'part' && !idx.parts.has(d.mark)) idx.parts.set(d.mark, d.id);
    if (d.kind === 'assembly' && !idx.assemblies.has(d.mark)) idx.assemblies.set(d.mark, d.id);
    for (const [inst, h] of sheetHits(d, byId)) {
      const list = idx.instances.get(inst) ?? [];
      list.push({ id: d.id, number: d.number, label: sheetLabel(d), kind: d.kind, title: d.title, score: h.score, ...(h.box ? { box: h.box } : {}) });
      idx.instances.set(inst, list);
    }
  });
  for (const list of idx.instances.values()) sortNavSheets(list, (id) => order.get(id)!);
  return idx;
}

const indexCache = new WeakMap<DerivedModel, { drawings: Drawing[]; index: DrawingIndex }>();

/** The index of a drawing set, cached per derived model (rebuilt when the drawing list changes). */
export function drawingIndexFor(dm: DerivedModel, drawings: Drawing[]): DrawingIndex {
  const c = indexCache.get(dm);
  if (c && c.drawings === drawings) return c.index;
  const index = buildDrawingIndex(dm, drawings);
  indexCache.set(dm, { drawings, index });
  return index;
}

/**
 * Sheets showing an assembly instance (its main part ref), best first, from a
 * drawing set made on demand (onDemand.ts): the same list as the index of the
 * drawn set. Only the view sheets that can show the instance are made (their
 * navigation bound, see PlanItem.bound); with `best`, only as many as needed to
 * know the best one.
 */
export function instanceSheets(set: DrawingSet, inst: PartRef, o: { kinds?: readonly DrawingKind[]; best?: boolean } = {}): NavSheet[] {
  const idx = set.index();
  const kinds = new Set(o.kinds ?? VIEW_KINDS);
  const order = new Map<string, number>();
  idx.entries.forEach((e, i) => order.set(e.id, i));
  const cands = idx.entries
    .filter((e) => kinds.has(e.kind) && VIEW_KINDS.has(e.kind))
    .map((e) => ({ e, ub: set.bound(e.id, inst) }))
    .filter((c) => c.ub > 0)
    .sort((a, b) => b.ub - a.ub || (KIND_RANK[a.e.kind] ?? 9) - (KIND_RANK[b.e.kind] ?? 9) || order.get(a.e.id)! - order.get(b.e.id)!);
  const out: NavSheet[] = [];
  const rank = (s: { kind: DrawingKind; id: string }) => [KIND_RANK[s.kind] ?? 9, order.get(s.id)!] as const;
  const better = (a: { score: number; kind: DrawingKind; id: string }, b: NavSheet) => {
    if (a.score !== b.score) return a.score > b.score;
    const [ra, oa] = rank(a);
    const [rb, ob] = rank(b);
    return ra !== rb ? ra < rb : oa < ob;
  };
  for (const { e, ub } of cands) {
    if (o.best && out.length && !better({ score: ub, kind: e.kind, id: e.id }, out[0])) break;
    const h = set.ensureMeta(e.id)?.hits?.get(inst);
    if (!h) continue;
    const s: NavSheet = { id: e.id, number: e.number, label: sheetLabel(e), kind: e.kind, title: e.title, score: h.score, ...(h.box ? { box: h.box } : {}) };
    if (o.best) {
      if (!out.length || better(s, out[0])) out[0] = s;
    } else out.push(s);
  }
  if (!o.best) sortNavSheets(out, (id) => order.get(id)!);
  return out;
}

/** The drawings of a part (by ref) from a drawing set made on demand: as drawingsForPart, the sheets only when asked. */
export function partDrawingsOf(set: DrawingSet, dm: DerivedModel, ref: PartRef, o: { sheets?: boolean } = {}): PartDrawings {
  const idx = set.index();
  const pt = dm.partByRef.get(ref);
  const a = assemblyByPart(dm).get(ref);
  return {
    partMark: pt?.mark,
    asmMark: a?.mark,
    part: pt ? idx.parts.get(pt.mark) : undefined,
    assembly: a ? idx.assemblies.get(a.mark) : undefined,
    sheets: a && o.sheets ? instanceSheets(set, a.main) : [],
    instance: a,
  };
}

export interface PartDrawings {
  partMark?: string;
  asmMark?: string;
  /** Part drawing id of the part's mark. */
  part?: string;
  /** Assembly drawing id of its assembly's mark. */
  assembly?: string;
  /** GA / zone / erection / section sheets showing its assembly, best first. */
  sheets: NavSheet[];
  instance?: Assembly;
}

/** The drawings of a part (by ref): its part drawing, its assembly's drawing and the sheets that show the assembly. */
export function drawingsForPart(index: DrawingIndex, dm: DerivedModel, ref: PartRef): PartDrawings {
  const pt = dm.partByRef.get(ref);
  const a = assemblyByPart(dm).get(ref);
  return {
    partMark: pt?.mark,
    asmMark: a?.mark,
    part: pt ? index.parts.get(pt.mark) : undefined,
    assembly: a ? index.assemblies.get(a.mark) : undefined,
    sheets: a ? (index.instances.get(a.main) ?? []) : [],
    instance: a,
  };
}

/** The best GA / zone sheet (else erection, section) that shows an assembly instance. */
export function bestSheet(index: DrawingIndex, inst: PartRef, kinds: DrawingKind[] = ['ga', 'sequence', 'setout', 'section']): NavSheet | undefined {
  return (index.instances.get(inst) ?? []).find((s) => kinds.includes(s.kind));
}

// ---------------------------------------------------------------------------
// Drawing → 3D

/** Orders instances by position (x, then z, then y of the main part), so "1 of N" steps along the facade. */
function byPosition(dm: DerivedModel, list: Assembly[]): Assembly[] {
  const o = (a: Assembly) => dm.partByRef.get(a.main)!.frame.origin;
  return [...list].sort((a, b) => o(a).x - o(b).x || o(a).z - o(b).z || o(a).y - o(b).y);
}

export interface SheetTargets {
  /** What the instances are: parts of one mark, assemblies of one mark, or the assemblies a view sheet shows. */
  kind: 'part' | 'assembly' | 'view';
  label: string;
  /** Every instance as its part refs (for "1 of N"). */
  instances: { label: string; refs: PartRef[] }[];
}

/**
 * What a sheet stands for in the 3D model: a part sheet — every part of its
 * mark; an assembly sheet — every assembly of its mark; a GA / zone / erection
 * / section sheet — the assemblies marked on it (or listed in its zone; on an
 * overall sheet of a divided view, everything drawn). Null for the register
 * and anchor schedules.
 */
export function sheetTargets(dm: DerivedModel, d: Drawing): SheetTargets | null {
  if (d.kind === 'part') {
    const refs = dm.parts.filter((pt) => pt.mark === d.mark);
    const by = assemblyByPart(dm);
    const sorted = [...refs].sort((a, b) => a.frame.origin.x - b.frame.origin.x || a.frame.origin.z - b.frame.origin.z || a.frame.origin.y - b.frame.origin.y);
    return { kind: 'part', label: `part ${d.mark}`, instances: sorted.map((pt) => ({ label: `${pt.mark} in ${by.get(pt.ref)?.mark ?? '?'}`, refs: [pt.ref] })) };
  }
  if (d.kind === 'assembly') {
    const list = byPosition(dm, dm.assemblies.filter((a) => a.mark === d.mark));
    return { kind: 'assembly', label: `assembly ${d.mark}`, instances: list.map((a) => ({ label: a.mark, refs: a.parts })) };
  }
  if (!VIEW_KINDS.has(d.kind)) return null;
  const by = assemblyByPart(dm);
  const mains = new Set<PartRef>();
  for (const e of d.entities) if (e.nav?.inst && isMarkEnt(e)) mains.add(e.nav.inst);
  const ids = new Set(d.zone?.assemblies ?? []);
  for (const a of dm.assemblies) if (ids.has(a.id)) mains.add(a.main);
  if (!mains.size) for (const e of d.entities) if (e.nav?.inst) mains.add(e.nav.inst);
  const found = new Set<Assembly>();
  for (const m of mains) {
    const a = by.get(m);
    if (a && a.main === m) found.add(a);
  }
  const list = byPosition(dm, [...found]);
  return { kind: 'view', label: d.zone ? `zone ${d.zone.index}` : d.kind === 'ga' ? 'the GA view' : 'the sheet', instances: list.map((a) => ({ label: a.mark, refs: a.parts })) };
}

/** A clickable navigation target of a sheet: entities with the same tag merged, with their paper box. */
export interface NavTarget {
  key: string;
  nav: DrawNav;
  kind: 'mark' | 'row' | 'outline' | 'sheet';
  box: BBox;
  ents: DEnt[];
}

export const navKey = (n: DrawNav) => [n.asm ?? '', n.part ?? '', n.inst ?? '', n.ref ?? '', n.sheet ?? ''].join('|');

const targetCache = new WeakMap<Drawing, NavTarget[]>();

/** Every navigation target of a sheet (marks and balloons, list rows, part outlines, sheet links), cached per sheet. */
export function navTargets(d: Drawing): NavTarget[] {
  const hit = targetCache.get(d);
  if (hit) return hit;
  const map = new Map<string, NavTarget>();
  for (const e of d.entities) {
    const n = e.nav;
    if (!n) continue;
    const kind: NavTarget['kind'] = n.sheet ? 'sheet' : isMarkEnt(e) ? 'mark' : n.ref && e.t === 'poly' ? 'outline' : 'row';
    const key = `${kind}|${navKey(n)}|${e.id ?? ''}|${kind === 'row' ? (e.group ?? '') : ''}`;
    const t = map.get(key);
    if (t) t.ents.push(e);
    else map.set(key, { key, nav: n, kind, box: { x0: 0, y0: 0, x1: 0, y1: 0 }, ents: [e] });
  }
  const out = [...map.values()];
  for (const t of out) {
    const b = entsBox(t.ents);
    // Rows: the full height of the table row around the text.
    t.box = t.kind === 'row' ? { x0: b.x0 - 0.8, y0: b.y0 - 1.2, x1: b.x1 + 0.8, y1: b.y1 + 1.2 } : { x0: b.x0 - 0.6, y0: b.y0 - 0.6, x1: b.x1 + 0.6, y1: b.y1 + 0.6 };
  }
  targetCache.set(d, out);
  return out;
}

const inBox = (b: BBox, q: { x: number; y: number }) => q.x >= b.x0 && q.x <= b.x1 && q.y >= b.y0 && q.y <= b.y1;

/**
 * The navigation target under a paper point: a mark, balloon, row or sheet
 * link whose box contains it (smallest first), else the nearest part outline
 * within `tol` mm.
 */
export function pickNav(d: Drawing, q: { x: number; y: number }, tol = 1.5): NavTarget | null {
  let best: NavTarget | null = null;
  let area = Infinity;
  for (const t of navTargets(d)) {
    if (t.kind === 'outline' || !inBox(t.box, q)) continue;
    const a = (t.box.x1 - t.box.x0) * (t.box.y1 - t.box.y0);
    if (a < area) {
      area = a;
      best = t;
    }
  }
  if (best) return best;
  let bd = tol;
  for (const t of navTargets(d)) {
    if (t.kind !== 'outline') continue;
    for (const e of t.ents) {
      const dd = entDistance(e, q);
      if (dd <= bd) {
        bd = dd;
        best = t;
      }
    }
  }
  return best;
}

/** What to highlight on a sheet: an assembly instance or a part instance, else every place a mark appears. */
export interface NavHighlight {
  inst?: PartRef;
  ref?: PartRef;
  asm?: string;
  part?: string;
}

/**
 * Targets of a sheet that show a highlight: the instance's mark (and the part's
 * outline) when given; else marks, balloons and rows of the part mark, else of
 * the assembly mark.
 */
export function highlightTargets(d: Drawing, h: NavHighlight): NavTarget[] {
  const ts = navTargets(d);
  if (h.inst || h.ref) {
    const own = ts.filter((t) => (h.inst && t.kind === 'mark' && t.nav.inst === h.inst) || (h.ref && t.kind === 'outline' && t.nav.ref === h.ref));
    if (own.length) return own;
  }
  if (h.part) {
    const ps = ts.filter((t) => t.kind !== 'outline' && t.nav.part === h.part && (!h.asm || !t.nav.asm || t.nav.asm === h.asm));
    if (ps.length) return ps;
  }
  if (h.asm) return ts.filter((t) => t.kind !== 'outline' && t.nav.asm === h.asm && !t.nav.part);
  return [];
}

export interface NavSelection {
  /** Parts to select (Part mode). */
  refs: PartRef[];
  /** Their assemblies (Assembly mode, and for "1 of N"). */
  assemblies: Assembly[];
}

/**
 * What a click on a navigation target selects in 3D: a part outline — that
 * part; a GA / erection mark — that assembly instance; a balloon or parts-list
 * row — every part of that mark (within assemblies of the sheet's assembly mark
 * when it has some); an assembly row — every assembly of that mark.
 */
export function navSelection(dm: DerivedModel, n: DrawNav): NavSelection {
  const by = assemblyByPart(dm);
  if (n.ref && dm.partByRef.has(n.ref)) {
    const a = by.get(n.ref);
    return { refs: [n.ref], assemblies: a ? [a] : [] };
  }
  if (n.inst) {
    const a = by.get(n.inst);
    if (a && a.main === n.inst) return { refs: [...a.parts], assemblies: [a] };
  }
  if (n.part) {
    let parts = dm.parts.filter((pt) => pt.mark === n.part);
    if (n.asm && parts.some((pt) => pt.assembly === n.asm)) parts = parts.filter((pt) => pt.assembly === n.asm);
    const refs = parts.map((pt) => pt.ref);
    return { refs, assemblies: byPosition(dm, [...new Set(refs.map((r) => by.get(r)).filter((a): a is Assembly => !!a))]) };
  }
  if (n.asm) {
    const list = byPosition(dm, dm.assemblies.filter((a) => a.mark === n.asm));
    return { refs: list.flatMap((a) => a.parts), assemblies: list };
  }
  return { refs: [], assemblies: [] };
}
