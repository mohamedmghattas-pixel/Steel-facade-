import type { Project, SheetSize } from '../model/types';
import type { DerivedModel, Part } from '../derive/model';
import { Sheet } from './dims';
import { drawFrame, drawRevisionTable, drawTitleBlock } from './layout';
import { drawingNumber, fingerprint, partUsage, revisionState, type UsedIn } from './register';
import { SHEETS, STANDARDS, type StdProfile } from './standards';
import type { Drawing, DrawingKind } from './types';

export interface DrawCtx {
  p: Project;
  dm: DerivedModel;
  std: StdProfile;
  usage: Map<string, UsedIn[]>;
  /** Assembly mark → GA drawing numbers that show it. */
  gaNumbers: string[];
}

export function makeCtx(p: Project, dm: DerivedModel): DrawCtx {
  return {
    p,
    dm,
    std: STANDARDS[p.drawings.settings.standard] ?? STANDARDS.ISO,
    usage: partUsage(dm),
    gaNumbers: ['front', 'plan'].map((v) => drawingNumber(p, `ga-${v}`)),
  };
}

export function newSheet(size: SheetSize): Sheet {
  const s = SHEETS[size];
  return new Sheet(s.w, s.h);
}

export const DOC_TYPE: Record<DrawingKind, string> = {
  register: 'Drawing register',
  ga: 'General arrangement',
  assembly: 'Assembly drawing',
  part: 'Part drawing',
};

/**
 * Completes a sheet: fingerprints the content, then adds the ISO 5457 frame,
 * the revision table and the ISO 7200 title block.
 */
export function finalize(
  ctx: DrawCtx,
  s: Sheet,
  size: SheetSize,
  o: { id: string; kind: DrawingKind; mark: string; title: string; subtitle: string; scale: string; sheetNo?: string; fingerprint?: string },
): Drawing {
  const fp = o.fingerprint ?? fingerprint(s.ents);
  const rs = revisionState(ctx.p, o.id, fp);
  const number = drawingNumber(ctx.p, o.id);
  const last = rs.revisions[rs.revisions.length - 1];
  const set = ctx.p.drawings.settings;
  drawRevisionTable(s, size, rs.revisions);
  drawTitleBlock(
    s,
    size,
    ctx.p,
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
    entities: s.ents,
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
  return ctx.dm.parts.some((o) => o.weldedTo === pt.ref && o.kind === 'plate');
}
