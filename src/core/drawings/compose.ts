import type { Project, SheetSize, SheetTemplate } from '../model/types';
import type { DerivedModel, Part } from '../derive/model';
import { Sheet } from './dims';
import { drawFrame, drawRevisionTable } from './layout';
import { drawingNumber, fingerprint, partUsage, revisionState, type UsedIn } from './register';
import { SHEETS, STANDARDS, type StdProfile } from './standards';
import { activeTemplate, drawTemplateTitleBlock } from './template';
import { applyEdits, hasEdits } from './edits';
import type { Drawing, DrawingKind, Viewport } from './types';

export interface DrawCtx {
  p: Project;
  dm: DerivedModel;
  std: StdProfile;
  usage: Map<string, UsedIn[]>;
  /** Assembly mark → GA drawing numbers that show it. */
  gaNumbers: string[];
  /** Sheet template (title block, logo, fixed notes) used for every sheet. */
  template: SheetTemplate;
}

export function makeCtx(p: Project, dm: DerivedModel): DrawCtx {
  return {
    p,
    dm,
    std: STANDARDS[p.drawings.settings.standard] ?? STANDARDS.ISO,
    usage: partUsage(dm),
    gaNumbers: ['front', 'plan'].map((v) => drawingNumber(p, `ga-${v}`)),
    template: activeTemplate(p),
  };
}

/** A blank sheet; with a context its layout keeps clear of the template's title block. */
export function newSheet(size: SheetSize, ctx?: DrawCtx): Sheet {
  const s = SHEETS[size];
  const sh = new Sheet(s.w, s.h);
  if (ctx) sh.tb = { w: ctx.template.width, h: ctx.template.height };
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
export function finalize(
  ctx: DrawCtx,
  s: Sheet,
  size: SheetSize,
  o: {
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
  },
): Drawing {
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
