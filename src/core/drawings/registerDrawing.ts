/**
 * Drawing register (document list): every sheet in the set with its
 * identification number, title, type, size, scale, revision, date and status.
 */
import { drawTable, tableSize, type TableSpec } from './dims';
import { frameRect, notesBlock, packBlocks, REV_H } from './layout';
import { TEXT, generalNotes } from './standards';
import { DOC_TYPE, finalize, newSheet, type DrawCtx } from './compose';
import { drawingNumber, fingerprint, sheetLabel } from './register';
import type { Drawing } from './types';

const COLS: TableSpec['cols'] = [
  { head: 'Drawing no.', w: 38 },
  { head: 'Title', w: 74 },
  { head: 'Type', w: 32 },
  { head: 'Size', w: 10 },
  { head: 'Scale', w: 16 },
  { head: 'Rev', w: 10 },
  { head: 'Date', w: 20 },
  { head: 'Status', w: 26 },
];

export function registerDrawings(ctx: DrawCtx, set: Drawing[]): Drawing[] {
  const { p } = ctx;
  const size = p.drawings.settings.sheet;
  const f = frameRect(size);
  const rowH = 4.5;
  // The table is wider than the space beside the title column, so it must end above the revision table.
  const rowsPerSheet = Math.max(10, Math.floor((f.y1 - 4 - (f.y0 + ctx.template.height + REV_H + 8) - 5) / rowH) - 1);
  const pages = Math.max(1, Math.ceil((set.length + 1) / rowsPerSheet));
  const self = Array.from({ length: pages }, (_, i) => {
    const revs = p.drawings.revisions[`register-${i + 1}`] ?? [];
    return { number: drawingNumber(p, `register-${i + 1}`), title: `Drawing register${pages > 1 ? ` (${i + 1}/${pages})` : ''}`, kind: 'register' as const, sheetSize: size, scale: '—', rev: revs.at(-1)?.rev ?? '-', status: revs.at(-1)?.status ?? 'In preparation', revisions: revs };
  });
  const all = [...self, ...set];
  // The register's revision status follows the list of sheets, not their revisions.
  const listFp = fingerprint(set.map((d) => ({ t: 'text' as const, p: { x: 0, y: 0 }, text: `${sheetLabel(d)}|${d.title}|${d.kind}`, h: 1, layer: 'text' as const })));
  const out: Drawing[] = [];
  for (let i = 0; i < pages; i++) {
    const s = newSheet(size, ctx);
    const rows = all.slice(i * rowsPerSheet, (i + 1) * rowsPerSheet).map((d) => {
      const rev = d.revisions[d.revisions.length - 1] ?? null;
      return [sheetLabel(d), d.title, DOC_TYPE[d.kind], d.sheetSize, d.scale, d.rev, rev?.date ?? '', 'changed' in d && d.changed && rev ? `${d.status} *` : d.status];
    });
    const sheets = Object.fromEntries([...self.map((d, j) => [sheetLabel(d), `register-${j + 1}`] as const), ...set.map((d) => [sheetLabel(d), d.id] as const)]);
    const spec: TableSpec = { title: `Drawing register – ${set.length + pages} sheets`, cols: COLS, rows, rowH, nav: { col: 0, kind: 'sheet', sheets } };
    const sz = tableSize(spec);
    const top = f.y1 - 4;
    s.withTag({ group: 'table:drawing-register' }, () => drawTable(s, f.x0 + 4, top, spec));
    if (i === 0) {
      s.text({ x: f.x0 + 4, y: top - sz.h - 6 }, '* content changed since the last issued revision', TEXT.label, 'start');
      // Notes go above the title block when there is room beside the table.
      if (f.x0 + 4 + sz.w < f.x1 - s.tb.w - 4 || top - sz.h > f.y0 + s.tb.h + REV_H + 60) {
        packBlocks(s, size, [notesBlock('General notes', generalNotes(p, { kind: 'register', welded: false, hdg: false, paint: false, hollowClosed: false, plates: false, bolts: false }), s.tb.w)]);
      }
    }
    out.push(
      finalize(ctx, s, size, {
        id: `register-${i + 1}`,
        kind: 'register',
        mark: 'REGISTER',
        title: 'Drawing register',
        subtitle: `${p.info.name}`,
        scale: '—',
        sheetNo: `${i + 1}/${pages}`,
        fingerprint: listFp,
      }),
    );
  }
  return out;
}
