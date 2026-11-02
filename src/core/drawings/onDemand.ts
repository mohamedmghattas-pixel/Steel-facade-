/**
 * Drawings on demand (docs/DRAWING_STANDARDS.md, "Drawings on demand").
 *
 * Large facades have thousands of sheets; drawing all of them for every model
 * state froze the page and ran out of memory. Instead:
 *
 * - **The drawing index** (`drawingIndex`, `DrawingSet.index`) is the register:
 *   one entry per sheet with id, number, title, kind, zone, sheet n/N, size, the
 *   scale where it is known without drawing, revision and status. It is measured,
 *   not drawn: every generator builds and packs its blocks (tables, notes) on a
 *   dry sheet and skips the views (compose.ts `DrawCtx.measure`), so the sheet
 *   counts of continued tables and every id, number and title are exactly those of
 *   the drawn set. It can be built in slices that yield to the page (`indexAsync`).
 * - **Sheets** are made one drawing at a time (`drawSheet`, `DrawingSet.drawing`)
 *   and kept in an LRU cache with a size budget, keyed by the drawing id and a
 *   dependency signature: the project-wide drawing settings, what the drawing
 *   shows (the part, the assembly with its parts, the brackets of a setting-out
 *   plan, the rows of an anchor schedule; the whole derived model for GA, zone,
 *   sequence and section sheets), and its sheets' edits and revisions. After an
 *   edit only drawings whose signature changed are made again, and only when they
 *   are viewed or exported; undo finds the sheets of the earlier state.
 * - **Sheet facts** (fingerprint, scale, layout problems, small text, the assembly
 *   instances a view sheet shows) are kept for every sheet made, by the same
 *   signature without the revisions, so "changed since issue" stays known after an
 *   issue and after edits elsewhere. Unissued sheets are always "changed"; for
 *   issued ones the flag is known once the sheet has been made (on view, in a
 *   background pass, or by `ensureMeta`).
 * - **The register sheet** lists every sheet with its scale and status, so making
 *   it makes (one at a time) the sheets whose facts are not known yet.
 *
 * Pure: no DOM, no store.
 */
import type { DocStatus, DrawingRevision, Project } from '../model/types';
import type { Assembly, DerivedModel } from '../derive/model';
import { depHash, flattenSheets, makeCtx, measuring, type DrawCtx, type PlanItem } from './compose';
import { drawingFamilies, type DrawingFamily } from './families';
import { registerDrawings, type RegisterRow } from './registerDrawing';
import { revisionState } from './register';
import { hasEdits } from './edits';
import { checkSheetLayout } from './layoutCheck';
import { sheetHits, type SheetHit } from './navigation';
import type { Drawing, DrawingKind, DrawingZone } from './types';

/** One sheet of the drawing index (the register), without its entities. */
export interface SheetEntry {
  id: string;
  /** Id of the drawing's first sheet (the plan item that makes it). */
  drawing: string;
  kind: DrawingKind;
  number: string;
  mark: string;
  title: string;
  sheetSize: string;
  sheet: { w: number; h: number };
  /** Main scale: known without drawing for zone, setting-out, schedule and register sheets, else once the sheet is made. */
  scale?: string;
  sheetIndex?: number;
  sheetCount?: number;
  zone?: DrawingZone;
  /** Current revision index ("-" before the first issue) and the revisions of the sheet. */
  rev: string;
  revisions: DrawingRevision[];
  /** Manual edits are applied to the sheet. */
  edited?: boolean;
  /** Content differs from the last issued revision; undefined: issued, but not checked yet. */
  changed?: boolean;
  /** Document status (ISO 7200); undefined while `changed` is not known. */
  status?: DocStatus;
}

/** Facts of a made sheet, kept after the sheet itself has left the cache. */
export interface SheetMeta {
  fingerprint: string;
  scale: string;
  /** Layout problems (checkSheetLayout). */
  layout: number;
  notices?: string[];
  /** Texts below 2.5 mm outside the title block (QAF check): count and smallest height. */
  small: { count: number; min: number };
  /** View sheets: the assembly instances shown (main part ref → score and mark box, see navigation.ts). */
  hits?: Map<string, SheetHit>;
  entities: number;
}

export interface SheetIndex {
  /** Every sheet in register order. */
  entries: SheetEntry[];
  byId: Map<string, SheetEntry>;
  /** Part mark → part drawing id; assembly mark → assembly drawing id. */
  parts: Map<string, string>;
  assemblies: Map<string, string>;
}

export interface IndexProgress {
  /** Drawing family being measured ("ga-front", "setout" …, "register"). */
  family: string;
  /** Sheets listed so far. */
  sheets: number;
}

// ---------------------------------------------------------------------------
// Caches shared by all project states

/** Rough heap size of a made sheet (entities dominate). */
const sheetBytes = (d: Drawing) => 2000 + d.entities.length * 180;

/** LRU cache of made drawings (all sheets of one drawing per entry), by size. */
export class SheetCache {
  private map = new Map<string, { sheets: Drawing[]; bytes: number }>();
  bytes = 0;
  hits = 0;
  misses = 0;
  constructor(public budget: number) {}
  get(key: string): Drawing[] | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.sheets;
  }
  peek(key: string): Drawing[] | undefined {
    return this.map.get(key)?.sheets;
  }
  set(key: string, sheets: Drawing[]) {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.map.delete(key);
    }
    const bytes = sheets.reduce((t, d) => t + sheetBytes(d), 0);
    this.map.set(key, { sheets, bytes });
    this.bytes += bytes;
    this.trim();
  }
  /** Evicts least recently used drawings beyond the budget (always keeps the newest). */
  trim() {
    for (const [k, e] of this.map) {
      if (this.bytes <= this.budget || this.map.size <= 1) break;
      this.map.delete(k);
      this.bytes -= e.bytes;
    }
  }
  get size() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

/** Made sheets, by drawing and dependency signature (default budget ≈ 200 MB). */
export const sheetCache = new SheetCache(200 * 1024 * 1024);

/** Facts of made sheets by sheet id and content signature (small: kept for many more sheets than the cache holds). */
const factCache = new Map<string, Omit<SheetMeta, 'layout'>>();
/** Layout problem counts by sheet id and full signature (the title block and revision table count). */
const layoutCache = new Map<string, number>();
const FACTS_MAX = 400_000;
const putBounded = <V>(m: Map<string, V>, k: string, v: V) => {
  m.delete(k);
  m.set(k, v);
  if (m.size > FACTS_MAX) for (const key of m.keys()) {
    m.delete(key);
    if (m.size <= FACTS_MAX * 0.9) break;
  }
};

/** Forget every cached sheet and fact (tests, memory pressure). */
export function clearDrawingCaches() {
  sheetCache.clear();
  factCache.clear();
  layoutCache.clear();
  sets.length = 0;
}

/** Statistics of the sheet cache (for the UI and tests). */
export const drawingCacheStats = () => ({ drawings: sheetCache.size, bytes: sheetCache.bytes, hits: sheetCache.hits, misses: sheetCache.misses, facts: factCache.size, made: madeCount });

let madeCount = 0;

const objIds = new WeakMap<object, number>();
let nextObjId = 0;
const oid = (o: object) => {
  let v = objIds.get(o);
  if (v === undefined) objIds.set(o, (v = ++nextObjId));
  return v;
};

/** Sheet id without its "#n" (the id of the drawing's first sheet). */
export const drawingIdOf = (id: string) => id.replace(/#\d+$/, '');

/** Texts below 2.5 mm outside the title block (as the QAF check reads them). */
function smallTextOf(d: Drawing): { count: number; min: number } {
  const tbX = d.sheet.w - 10 - 190;
  const tbY = 10 + 80;
  let count = 0;
  let min = Infinity;
  for (const e of d.entities) {
    if (e.t !== 'text' || !e.text.trim()) continue;
    if (e.p.x >= tbX && e.p.y <= tbY) continue;
    if (e.h < 2.5 - 1e-6) {
      count++;
      min = Math.min(min, e.h);
    }
  }
  return { count, min: Number.isFinite(min) ? min : 0 };
}

// ---------------------------------------------------------------------------
// The drawing set of one project state

interface Planned {
  item: PlanItem;
  family: DrawingFamily;
}

const REGISTER = 'register';

/**
 * The drawing set of one project state, made on demand. Get it with `drawingSet(p, dm)`
 * (cached per state); `index()` lists the sheets, `drawing()` / `sheet()` make them.
 */
export class DrawingSet {
  readonly ctx: DrawCtx;
  private readonly mctx: DrawCtx;
  private readonly families: DrawingFamily[];
  private readonly famItems = new Map<string, Map<string, PlanItem>>();
  private readonly stubs = new Map<string, Drawing[]>();
  private readonly contentKeys = new Map<string, string>();
  private readonly fullKeys = new Map<string, string>();
  private idx?: SheetIndex;
  private running?: Generator<IndexProgress, SheetIndex>;
  private readonly global: string;
  private sheetEdits?: Map<string, string[]>;
  private asmById?: Map<string, Assembly>;
  /** Bumped whenever facts of a sheet become known (UI refresh). */
  version = 0;
  /** Layout problem counts of the sheets known so far (made, or found in the cache). */
  readonly layout = new Map<string, number>();

  constructor(
    readonly p: Project,
    readonly dm: DerivedModel,
  ) {
    this.ctx = makeCtx(p, dm);
    this.mctx = measuring(this.ctx);
    this.families = drawingFamilies(this.ctx);
    // Project-wide inputs of every sheet: title block fields, drawing settings, sheet template.
    this.global = depHash(p.info, p.drawings.settings, this.ctx.template);
  }

  // -- plan items ------------------------------------------------------------

  private itemsOf(f: DrawingFamily): Map<string, PlanItem> {
    let m = this.famItems.get(f.name);
    if (!m) {
      m = new Map(f.items().map((it) => [it.id, it]));
      this.famItems.set(f.name, m);
    }
    return m;
  }

  /** The plan item of a drawing (any of its sheet ids); undefined for the register and unknown ids. */
  private planned(id: string): Planned | undefined {
    const base = drawingIdOf(id);
    for (const family of this.families) {
      if (!family.has(base)) continue;
      const item = this.itemsOf(family).get(base);
      return item ? { item, family } : undefined;
    }
    return undefined;
  }

  /** Measured sheets of a drawing (stubs without entities). */
  private measure(it: PlanItem): Drawing[] {
    let st = this.stubs.get(it.id);
    if (st) return st;
    if (it.full) {
      // Made in full anyway: keep the sheets in the cache, and stubs for the index.
      const d = it.make(this.ctx);
      const sheets = d ? flattenSheets([d]) : [];
      if (d) this.store(it.id, sheets);
      st = sheets.map((x) => ({ ...x, entities: [], viewports: undefined, regions: undefined }));
    } else {
      const d = it.make(this.mctx);
      st = d ? flattenSheets([d]) : [];
    }
    this.stubs.set(it.id, st);
    return st;
  }

  // -- index -----------------------------------------------------------------

  private entryOf(d: Drawing, drawing: string): SheetEntry {
    const revisions = this.p.drawings.revisions[d.id] ?? [];
    const last = revisions[revisions.length - 1];
    const e: SheetEntry = {
      id: d.id,
      drawing,
      kind: d.kind,
      number: d.number,
      mark: d.mark,
      title: d.title,
      sheetSize: d.sheetSize,
      sheet: d.sheet,
      ...(d.scale ? { scale: d.scale } : {}),
      ...(d.sheetCount ? { sheetIndex: d.sheetIndex, sheetCount: d.sheetCount } : {}),
      ...(d.zone ? { zone: d.zone } : {}),
      rev: last ? last.rev : '-',
      revisions,
      ...(hasEdits(this.p.drawings.edits?.[d.id]) ? { edited: true } : {}),
      // Not issued yet: "changed" whatever the content (revisionState).
      ...(last ? {} : { changed: true, status: 'In preparation' as DocStatus }),
    };
    return e;
  }

  /** The drawing index, measured in full now (see indexAsync for a sliced build). */
  index(): SheetIndex {
    if (this.idx) return this.idx;
    const gen = (this.running ??= this.indexSteps());
    for (let r = gen.next(); !r.done; r = gen.next());
    return this.idx!;
  }

  /** The index if it has been built. */
  get ready(): SheetIndex | undefined {
    return this.idx;
  }

  /**
   * The index, measured in slices of about `slice` ms that yield to the page
   * between them (macrotasks), so a large model never blocks it for long.
   */
  async indexAsync(o: { slice?: number; signal?: AbortSignal; onProgress?: (p: IndexProgress) => void; yieldTo?: () => Promise<void> } = {}): Promise<SheetIndex> {
    if (this.idx) return this.idx;
    const gen = (this.running ??= this.indexSteps());
    const slice = o.slice ?? 25;
    const pause = o.yieldTo ?? yieldMacrotask;
    let t0 = now();
    for (;;) {
      if (this.idx) return this.idx;
      const r = gen.next();
      if (r.done) return this.idx!;
      if (now() - t0 > slice) {
        o.onProgress?.(r.value);
        await pause();
        if (o.signal?.aborted) throw new DOMExceptionLike('Aborted');
        t0 = now();
      }
    }
  }

  /** The index, one step per drawing measured (generator: drive it with next()). */
  *indexSteps(): Generator<IndexProgress, SheetIndex> {
    const entries: SheetEntry[] = [];
    for (const f of this.families) {
      yield { family: f.name, sheets: entries.length };
      if (f.prepare && !this.famItems.has(f.name)) for (const _ of f.prepare()) yield { family: f.name, sheets: entries.length };
      const items = this.itemsOf(f);
      yield { family: f.name, sheets: entries.length };
      for (const it of items.values()) {
        for (const d of this.measure(it)) entries.push(this.entryOf(d, it.id));
        yield { family: f.name, sheets: entries.length };
      }
    }
    // The register lists every sheet; its pages follow from their number.
    const reg = flattenSheets(registerDrawings(this.mctx, entries as unknown as RegisterRow[]));
    const regEntries = reg.map((d) => this.entryOf(d, drawingIdOf(d.id)));
    const all = [...regEntries, ...entries];
    const idx: SheetIndex = { entries: all, byId: new Map(all.map((e) => [e.id, e])), parts: new Map(), assemblies: new Map() };
    for (const e of all) {
      if (e.kind === 'part' && !idx.parts.has(e.mark)) idx.parts.set(e.mark, e.id);
      if (e.kind === 'assembly' && !idx.assemblies.has(e.mark)) idx.assemblies.set(e.mark, e.id);
    }
    this.idx = idx;
    this.running = undefined;
    // Facts known from earlier states (same content): fill in the flags of issued sheets.
    for (const e of all) if (e.changed === undefined || !e.scale) this.refresh(e, false);
    return idx;
  }

  // -- keys ------------------------------------------------------------------

  /** Sheet ids with revisions or edits, by drawing id (so continuation sheets count too). */
  private sheetsWithRecords(drawing: string): string[] {
    if (!this.sheetEdits) {
      const m = new Map<string, string[]>();
      const add = (id: string) => {
        const base = drawingIdOf(id);
        const l = m.get(base);
        if (!l) m.set(base, [id]);
        else if (!l.includes(id)) l.push(id);
      };
      for (const id of Object.keys(this.p.drawings.revisions)) add(id);
      for (const id of Object.keys(this.p.drawings.edits ?? {})) add(id);
      for (const l of m.values()) l.sort();
      this.sheetEdits = m;
    }
    return this.sheetEdits.get(drawing) ?? [];
  }

  /** What the content of a drawing depends on (no revisions): drives fingerprints and the other facts. */
  contentKey(drawing: string): string {
    let k = this.contentKeys.get(drawing);
    if (k) return k;
    let dep: string;
    if (drawing.startsWith(`${REGISTER}-`)) {
      // The register: every sheet's label, title, kind, size, scale and status.
      dep = depHash(REGISTER, this.registerRows().map((r) => [r.id, r.number, r.sheetIndex ?? 0, r.sheetCount ?? 0, r.title, r.kind, r.sheetSize, r.scale, r.rev, r.revisions.at(-1)?.date ?? '', r.status, r.changed]));
    } else {
      const pl = this.planned(drawing);
      dep = pl?.item.dep ? pl.item.dep() : `model:${oid(this.dm)}:${oid(this.p)}`;
    }
    const edits = this.sheetsWithRecords(drawing).map((id) => [id, this.p.drawings.edits?.[id] ?? null]);
    k = depHash(this.global, dep, edits);
    this.contentKeys.set(drawing, k);
    return k;
  }

  /** Content key plus the revisions of the drawing's sheets (title block, revision table): keys the made sheets. */
  fullKey(drawing: string): string {
    let k = this.fullKeys.get(drawing);
    if (k) return k;
    const revs = this.sheetsWithRecords(drawing).map((id) => [id, this.p.drawings.revisions[id] ?? null]);
    k = `${drawing}|${depHash(this.contentKey(drawing), revs)}`;
    this.fullKeys.set(drawing, k);
    return k;
  }

  // -- sheets ----------------------------------------------------------------

  /** Records a made drawing: cache, facts, index entries. */
  private store(drawing: string, sheets: Drawing[]) {
    madeCount++;
    sheetCache.set(this.fullKey(drawing), sheets);
    const ck = this.contentKey(drawing);
    const full = this.fullKey(drawing);
    for (const d of sheets) {
      const hits = sheetHits(d, (this.asmById ??= new Map(this.dm.assemblies.map((a) => [a.id, a]))));
      putBounded(factCache, `${d.id}|${ck}`, {
        fingerprint: d.fingerprint,
        scale: d.scale,
        ...(d.notices?.length ? { notices: d.notices } : {}),
        small: smallTextOf(d),
        ...(hits.size ? { hits } : {}),
        entities: d.entities.length,
      });
      const issues = checkSheetLayout(d).length;
      putBounded(layoutCache, `${d.id}|${full}`, issues);
      this.layout.set(d.id, issues);
      const e = this.idx?.byId.get(d.id);
      if (e) this.refresh(e, false);
    }
    this.version++;
  }

  /**
   * Every sheet of a drawing (given any of its sheet ids), made now unless cached.
   * Undefined for unknown ids.
   */
  drawing(id: string): Drawing[] | undefined {
    const base = drawingIdOf(id);
    const key = base.startsWith(`${REGISTER}-`) ? null : this.fullKey(base);
    if (key) {
      const hit = sheetCache.get(key);
      if (hit) return hit;
    }
    if (base.startsWith(`${REGISTER}-`)) return this.register(base);
    const pl = this.planned(base);
    if (!pl) return undefined;
    const d = pl.item.make(this.ctx);
    const sheets = d ? flattenSheets([d]) : [];
    this.store(base, sheets);
    return sheets;
  }

  /** One sheet, made now unless cached. */
  sheet(id: string): Drawing | undefined {
    return this.drawing(id)?.find((d) => d.id === id);
  }

  /** Is the sheet in the cache (no work to show it)? */
  cached(id: string): boolean {
    const base = drawingIdOf(id);
    if (base.startsWith(`${REGISTER}-`)) {
      if (!this.idx || this.idx.entries.some((e) => e.kind !== 'register' && !this.factsOf(e.id))) return false;
    }
    return !!sheetCache.peek(this.fullKey(base));
  }

  /** The register rows: every sheet but the register with its scale and status (all facts must be known). */
  private registerRows(): RegisterRow[] {
    const idx = this.index();
    return idx.entries
      .filter((e) => e.kind !== 'register')
      .map((e) => {
        const m = this.factsOf(e.id);
        const rs = revisionState(this.p, e.id, m?.fingerprint ?? '');
        return { id: e.id, kind: e.kind, number: e.number, title: e.title, sheetSize: e.sheetSize as Drawing['sheetSize'], scale: m?.scale ?? e.scale ?? '', rev: rs.rev, status: rs.status, revisions: rs.revisions, changed: rs.changed, sheetIndex: e.sheetIndex, sheetCount: e.sheetCount };
      });
  }

  /** The register sheets: makes (one at a time) every sheet whose facts are not known yet. */
  private register(base: string): Drawing[] | undefined {
    for (const _ of this.metaSteps()) void _;
    const rows = this.registerRows();
    const key = this.fullKey(base);
    const hit = sheetCache.get(key);
    if (hit) return hit;
    const sheets = flattenSheets(registerDrawings(this.ctx, rows));
    // All register drawings are made together; store each under its own key.
    const by = new Map<string, Drawing[]>();
    for (const d of sheets) {
      const b = drawingIdOf(d.id);
      by.set(b, [...(by.get(b) ?? []), d]);
    }
    for (const [b, list] of by) this.store(b, list);
    return by.get(base);
  }

  // -- facts -----------------------------------------------------------------

  private factsOf(id: string): Omit<SheetMeta, 'layout'> | undefined {
    const base = drawingIdOf(id);
    if (base.startsWith(`${REGISTER}-`) && !this.contentKeys.has(base)) {
      // The register's key needs every other sheet's facts.
      if (!this.idx || this.idx.entries.some((e) => e.kind !== 'register' && !this.factsOf(e.id))) return undefined;
    }
    return factCache.get(`${id}|${this.contentKey(base)}`);
  }

  /** Facts of a sheet if it has been made (in this or an earlier state with the same content). */
  meta(id: string): SheetMeta | undefined {
    const f = this.factsOf(id);
    if (!f) return undefined;
    const layout = layoutCache.get(`${id}|${this.fullKey(drawingIdOf(id))}`);
    if (layout !== undefined) this.layout.set(id, layout);
    return { ...f, layout: layout ?? -1 };
  }

  /** Facts of a sheet, making it when they are not known. */
  ensureMeta(id: string): SheetMeta | undefined {
    const m = this.meta(id);
    if (m && m.layout >= 0) return m;
    this.drawing(id);
    return this.meta(id);
  }

  /** Fills in the scale, "changed" and status of an index entry from the facts, when known. Returns true when they are. */
  refresh(e: SheetEntry, bump = true): boolean {
    const m = this.factsOf(e.id);
    if (!m) return e.changed !== undefined;
    if (!e.scale && m.scale) e.scale = m.scale;
    const rs = revisionState(this.p, e.id, m.fingerprint);
    e.changed = rs.changed;
    e.status = rs.status;
    if (bump) this.version++;
    return true;
  }

  /** The fingerprint and revision state of a sheet (makes it when not known). */
  state(id: string): { fingerprint: string; changed: boolean; status: DocStatus; rev: string } | undefined {
    const m = this.ensureMeta(id);
    if (!m) return undefined;
    const rs = revisionState(this.p, id, m.fingerprint);
    return { fingerprint: m.fingerprint, changed: rs.changed, status: rs.status, rev: rs.rev };
  }

  /**
   * Makes every sheet (of `ids`, default all but the register) whose facts are not known,
   * one drawing per step, cheapest families first. Yields the sheet ids done / to do.
   */
  *metaSteps(ids?: Iterable<string>): Generator<{ done: number; total: number; id: string }> {
    const idx = this.index();
    const want = ids ? [...ids] : idx.entries.filter((e) => e.kind !== 'register').map((e) => e.id);
    const todo = want.filter((id) => {
      const m = this.meta(id);
      return !m || m.layout < 0;
    });
    // Drawings that depend on the whole model are the slowest on large facades: last.
    const heavy = (id: string) => {
      const pl = this.planned(id);
      return pl && !pl.item.dep ? 1 : 0;
    };
    todo.sort((a, b) => heavy(a) - heavy(b));
    let done = 0;
    for (const id of todo) {
      const m = this.meta(id);
      if (!m || m.layout < 0) this.drawing(id);
      done++;
      yield { done, total: todo.length, id };
    }
  }

  /** Makes the sheets one after another (for exports): each is released to the LRU cache after use. */
  *sheets(ids?: Iterable<string>): Generator<Drawing> {
    const list = ids ? [...ids] : this.index().entries.map((e) => e.id);
    for (const id of list) {
      const d = this.sheet(id);
      if (d) yield d;
    }
  }

  /**
   * Is the sheet one of those that depend on the whole model (GA, zone, sequence, section)?
   * They are made again after every model edit and are the slowest on large facades.
   */
  heavy(id: string): boolean {
    const pl = this.planned(id);
    return !!pl && !pl.item.dep;
  }

  /** Can the sheet be made without the index's preparation (zone plans, slab brackets) of its family? */
  prepared(id: string): boolean {
    const base = drawingIdOf(id);
    if (base.startsWith(`${REGISTER}-`)) return !!this.idx;
    const f = this.families.find((x) => x.has(base));
    return !f || !f.prepare || this.famItems.has(f.name);
  }

  // -- navigation ------------------------------------------------------------

  /** Navigation bound of a sheet for an assembly instance (see PlanItem.bound). */
  bound(id: string, inst: string): number {
    const e = this.index().byId.get(id);
    if (!e) return 0;
    if (e.kind !== 'ga' && e.kind !== 'sequence' && e.kind !== 'setout' && e.kind !== 'section') return 0;
    const pl = this.planned(e.drawing);
    if (!pl) return 0;
    // Continuation sheets carry tables only (and the zone record of their drawing).
    if ((e.sheetIndex ?? 1) > 1) return e.zone && this.zoneMains(e).has(inst) ? 2 : 0;
    return pl.item.bound ? pl.item.bound(inst) : 3;
  }

  private zoneMainsOf = new Map<string, Set<string>>();
  /** Main part refs of the assemblies listed in a sheet's zone. */
  private zoneMains(e: SheetEntry): Set<string> {
    let m = this.zoneMainsOf.get(e.id);
    if (!m) {
      const by = (this.asmById ??= new Map(this.dm.assemblies.map((a) => [a.id, a])));
      m = new Set((e.zone?.assemblies ?? []).map((id) => by.get(id)?.main).filter((x): x is string => !!x));
      this.zoneMainsOf.set(e.id, m);
    }
    return m;
  }
}

/** Abort error without depending on the DOM. */
class DOMExceptionLike extends Error {
  name = 'AbortError';
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A macrotask (the page can paint and take input). MessageChannel avoids the 4 ms clamp of nested timers. */
export function yieldMacrotask(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Entry points

/** Drawing sets of the last few project states (undo / redo find theirs). */
const sets: DrawingSet[] = [];
const SETS_MAX = 4;

/** The drawing set of a project state (cached per project and derived model). */
export function drawingSet(p: Project, dm: DerivedModel): DrawingSet {
  const i = sets.findIndex((s) => s.p === p && s.dm === dm);
  if (i >= 0) {
    const s = sets[i];
    if (i !== sets.length - 1) {
      sets.splice(i, 1);
      sets.push(s);
    }
    return s;
  }
  const s = new DrawingSet(p, dm);
  sets.push(s);
  if (sets.length > SETS_MAX) sets.shift();
  return s;
}

/** The drawing index (register) of a project state: every sheet, without drawing them. */
export function drawingIndex(p: Project, dm: DerivedModel): SheetIndex {
  return drawingSet(p, dm).index();
}

/** One sheet of the set, made on demand (cached). Undefined for unknown ids. */
export function drawSheet(p: Project, dm: DerivedModel, id: string): Drawing | undefined {
  return drawingSet(p, dm).sheet(id);
}
