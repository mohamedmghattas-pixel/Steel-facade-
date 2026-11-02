import type { Project, SheetSize, SheetTemplate } from '../model/types';
import type { DerivedModel, Part } from '../derive/model';
import { Sheet } from './dims';
import { drawFrame, drawRevisionTable, frameRect, packColumns, REV_H } from './layout';
import { drawingNumber, fingerprint, partUsage, revisionState, type UsedIn } from './register';
import { SHEETS, STANDARDS, type StdProfile } from './standards';
import { activeTemplate, drawTemplateTitleBlock, templateBox } from './template';
import { applyEdits, hasEdits } from './edits';
import type { Drawing, DrawingKind, DrawingZone, Viewport } from './types';
import type { ZonePlan } from './zoning';

export interface DrawCtx {
  p: Project;
  dm: DerivedModel;
  std: StdProfile;
  usage: Map<string, UsedIn[]>;
  /** Assembly mark → GA drawing numbers that show it. */
  gaNumbers: string[];
  /** Sheet template (title block, logo, fixed notes) used for every sheet. */
  template: SheetTemplate;
  /** Zone plans of divided views, by view and sheet size (see zoning.ts). */
  zonePlans?: Map<string, ZonePlan | null>;
  /**
   * Measuring for the drawing index (onDemand.ts): generators build and pack their
   * blocks (tables, notes) on dry sheets but skip the views; `finalize` returns sheet
   * stubs without entities. Ids, numbers, titles and sheet counts are the same as
   * when the sheets are drawn, since what continues on further sheets depends on the
   * blocks only.
   */
  measure?: boolean;
  /** State shared by the generators of one project state (setting-out groups, anchor rows, phases …). */
  memo: Map<string, unknown>;
}

export function makeCtx(p: Project, dm: DerivedModel): DrawCtx {
  return {
    p,
    dm,
    std: STANDARDS[p.drawings.settings.standard] ?? STANDARDS.ISO,
    usage: partUsage(dm),
    gaNumbers: ['front', 'plan'].map((v) => drawingNumber(p, `ga-${v}`)),
    template: activeTemplate(p),
    zonePlans: new Map(),
    memo: new Map(),
  };
}

/** A value computed once per drawing context (shared by its measuring copy). */
export function memo<T>(ctx: DrawCtx, key: string, make: () => T): T {
  if (ctx.memo.has(key)) return ctx.memo.get(key) as T;
  const v = make();
  ctx.memo.set(key, v);
  return v;
}

/**
 * One drawing of the set (its first sheet and any continuation sheets), made on
 * demand. Families list their drawings as items in register order; `allDrawings`
 * makes all of them, the drawing index (onDemand.ts) measures them and makes one
 * when it is viewed or exported.
 */
export interface PlanItem {
  /** Id of the drawing's first sheet. */
  id: string;
  /** Makes the drawing (null: it has nothing to show); with a measuring context, its stub. */
  make: (ctx: DrawCtx) => Drawing | null;
  /**
   * What the drawing shows, as a string that changes whenever its content may (besides the
   * project-wide drawing settings and the sheet's own revisions and edits, which the index adds).
   * Absent: the whole derived model (GA, zone, sequence and section sheets).
   */
  dep?: () => string;
  /** Measuring needs the whole drawing anyway (its blocks depend on the geometry): make it in full. */
  full?: boolean;
  /**
   * Navigation (view sheets): the highest score an assembly instance (its main part ref)
   * can get on the drawing, known without drawing it — 3 its mark is placed, 2 listed in
   * the zone, 1 only drawn, 0 not shown (see navigation.ts). Absent: any instance may be marked.
   */
  bound?: (inst: string) => number;
}

/** 53-bit string hash (cyrb53), hex. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Hash of some JSON-serialisable values (dependency signatures). */
export const depHash = (...values: unknown[]) => hashString(JSON.stringify(values));

/** The measuring copy of a context (same caches). */
export const measuring = (ctx: DrawCtx): DrawCtx => (ctx.measure ? ctx : { ...ctx, measure: true });

/** A blank sheet; with a context its layout keeps clear of the template's title block. */
export function newSheet(size: SheetSize, ctx?: DrawCtx): Sheet {
  const s = SHEETS[size];
  const sh = new Sheet(s.w, s.h);
  if (ctx) {
    const box = templateBox(ctx.template, size);
    sh.tb = { w: box.w, h: box.h };
  }
  if (ctx?.measure) sh.dry = true;
  return sh;
}

export const DOC_TYPE: Record<DrawingKind, string> = {
  register: 'Drawing register',
  ga: 'General arrangement',
  assembly: 'Assembly drawing',
  part: 'Part drawing',
  section: 'Section / detail',
  setout: 'Setting-out plan',
  anchors: 'Anchor schedule',
  sequence: 'Erection sequence',
};

/**
 * Completes a sheet: applies the manual edits (moved views and dimensions,
 * hidden items, notes, revision clouds), fingerprints the content, then adds the
 * ISO 5457 frame, the revision table and the title block of the sheet template
 * (ISO 7200 by default).
 */
export interface SheetInfo {
  id: string;
  kind: DrawingKind;
  mark: string;
  title: string;
  subtitle: string;
  scale: string;
  sheetNo?: string;
  fingerprint?: string;
  /** Identification number, when it is not derivable from the id (numbered series). */
  number?: string;
  viewports?: Viewport[];
  zone?: DrawingZone;
}

/** Id of sheet `n` (≥ 2) of a multi-sheet drawing: "seq-floor-1#2". The first sheet keeps the drawing id. */
export const sheetId = (id: string, n: number) => (n > 1 ? `${id}#${n}` : id);

/**
 * Completes a drawing: its first sheet, plus continuation sheets for the blocks
 * that did not fit (`Sheet.overflow`) — tables and notes continue in columns on
 * sheet 2/N, 3/N … of the same drawing (ISO 7200: one identification number,
 * numbered sheets). Further sheets are returned in `continuation`.
 */
export function finalize(ctx: DrawCtx, s: Sheet, size: SheetSize, o: SheetInfo): Drawing {
  const more: Sheet[] = [];
  let rest = s.overflow;
  while (rest.length && more.length < 200) {
    const sh = newSheet(size, ctx);
    sh.name = s.name;
    const left = packColumns(sh, size, rest);
    if (left.length === rest.length && left[0] === rest[0]) break; // nothing placed: give up rather than loop
    more.push(sh);
    rest = left;
  }
  const count = 1 + more.length;
  if (ctx.measure) return stubSheets(ctx, s, size, o, count);
  if (count === 1) return finishSheet(ctx, s, size, o);
  const number = o.number ?? drawingNumber(ctx.p, o.id);
  const first = finishSheet(ctx, s, size, { ...o, number, sheetNo: `1/${count}` }, 1, count);
  first.continuation = more.map((sh, i) =>
    finishSheet(ctx, sh, size, { ...o, number, id: sheetId(o.id, i + 2), sheetNo: `${i + 2}/${count}`, fingerprint: undefined, viewports: undefined, subtitle: `${o.subtitle} · continued` }, i + 2, count),
  );
  return first;
}

/**
 * The sheets of a drawing as measured (ctx.measure): identification, title, size and
 * sheet n/N, without entities, fingerprint or revision state (the drawing index adds
 * those). Continuation sheets follow in `continuation` as for a drawn sheet.
 */
function stubSheets(ctx: DrawCtx, s: Sheet, size: SheetSize, o: SheetInfo, count: number): Drawing {
  const number = o.number ?? drawingNumber(ctx.p, o.id);
  const stub = (id: string, i: number): Drawing => ({
    id,
    kind: o.kind,
    number,
    mark: o.mark,
    title: o.title,
    sheetSize: size,
    sheet: { w: s.w, h: s.h },
    scale: o.scale,
    rev: '-',
    status: 'In preparation',
    revisions: [],
    fingerprint: '',
    changed: true,
    entities: [],
    ...(count > 1 ? { sheetIndex: i, sheetCount: count } : {}),
    ...(o.zone ? { zone: o.zone } : {}),
  });
  const first = stub(o.id, 1);
  if (count > 1) first.continuation = Array.from({ length: count - 1 }, (_, i) => stub(sheetId(o.id, i + 2), i + 2));
  return first;
}

/** One sheet: edits, fingerprint, frame, revision table and title block. */
function finishSheet(ctx: DrawCtx, s: Sheet, size: SheetSize, o: SheetInfo, sheetIndex?: number, sheetCount?: number): Drawing {
  const edits = ctx.p.drawings.edits?.[o.id];
  const edited = hasEdits(edits);
  if (edited) s.ents = applyEdits(s.ents, edits);
  // Edits count as content: a fixed fingerprint (the register) is combined with the edited content.
  const fp = o.fingerprint ? (edited ? fingerprint([{ t: 'text', p: { x: 0, y: 0 }, text: o.fingerprint, h: 1, layer: 'text' }, ...s.ents]) : o.fingerprint) : fingerprint(s.ents);
  const rs = revisionState(ctx.p, o.id, fp);
  const number = o.number ?? drawingNumber(ctx.p, o.id);
  const last = rs.revisions[rs.revisions.length - 1];
  const set = ctx.p.drawings.settings;
  drawRevisionTable(s, size, rs.revisions);
  drawTemplateTitleBlock(
    s,
    size,
    ctx.p,
    ctx.template,
    {
      title: o.title,
      subtitle: o.subtitle,
      number,
      rev: rs.rev,
      date: rs.date,
      status: rs.status,
      docType: DOC_TYPE[o.kind],
      scale: o.scale,
      sheetNo: o.sheetNo ?? '1/1',
      createdBy: last?.drawn || ctx.p.info.designer,
      checkedBy: last?.checked || set.checkedBy,
      approvedBy: last?.approved || set.approvedBy,
    },
    ctx.std.projection,
  );
  drawFrame(s, size);
  const views = edits?.views ?? {};
  const viewports = o.viewports?.map((v) => {
    const d = views[v.group];
    return d ? { ...v, origin: { x: v.origin.x + d.x, y: v.origin.y + d.y } } : v;
  });
  return {
    id: o.id,
    kind: o.kind,
    number,
    mark: o.mark,
    title: o.title,
    sheetSize: size,
    sheet: { w: s.w, h: s.h },
    scale: o.scale,
    rev: rs.rev,
    status: rs.status,
    revisions: rs.revisions,
    fingerprint: fp,
    changed: rs.changed,
    edited: edited || undefined,
    viewports,
    entities: s.ents,
    regions: sheetRegions(size, s.tb),
    ...(sheetCount && sheetCount > 1 ? { sheetIndex, sheetCount } : {}),
    ...(o.zone ? { zone: o.zone } : {}),
    ...(s.notices.length ? { notices: [...s.notices] } : {}),
  };
}

/** Every sheet of a list of drawings, continuation sheets after their first sheet. */
export function flattenSheets(ds: Drawing[]): Drawing[] {
  const out: Drawing[] = [];
  for (const d of ds) {
    const { continuation, ...first } = d;
    out.push(continuation ? (first as Drawing) : d, ...(continuation ?? []));
  }
  return out;
}

/** Reserved regions of a sheet: the frame, the title block (bottom right) and the revision table above it. */
export function sheetRegions(size: SheetSize, tb: { w: number; h: number }) {
  const f = frameRect(size);
  return {
    frame: f,
    titleBlock: { x0: f.x1 - tb.w, y0: f.y0, x1: f.x1, y1: f.y0 + tb.h },
    revisionTable: { x0: f.x1 - tb.w, y0: f.y0 + tb.h, x1: f.x1, y1: f.y0 + tb.h + REV_H },
  };
}

/** ISO 5261-style designation of a part: "SHS 100×100×5 – 3500", "PL10 – 160×150". */
export function designation(pt: Part): string {
  const prof = pt.profile.replace(/(\d)x(\d)/g, '$1×$2');
  if (pt.kind === 'plate') return `${prof} – ${Math.round(pt.length)}×${Math.round(pt.width)}`;
  return `${prof} – ${Math.round(pt.length)}`;
}

/** Does any assembly close this hollow part with welded plates (needs galvanizing vents)? */
export function closedByWelding(ctx: DrawCtx, pt: Part): boolean {
  if (pt.shape?.type !== 'RHS' && pt.shape?.type !== 'CHS') return false;
  const welded = memo(ctx, 'weldedPlates', () => {
    const set = new Set<string>();
    for (const o of ctx.dm.parts) if (o.weldedTo && o.kind === 'plate') set.add(o.weldedTo);
    return set;
  });
  return welded.has(pt.ref);
}
