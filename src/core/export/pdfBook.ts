/**
 * Multi-page vector PDFs from SVG pages with jsPDF: one page per sheet, page
 * size per sheet, optional bookmarks (PDF outline) grouped by heading. The SVG
 * is put on the page by a painter: svg2pdf.js in the browser (ui/pdf.ts), a
 * stand-in in tests (svg2pdf needs a DOM).
 */
import type { jsPDF } from 'jspdf';

/** Draw one SVG (sheet size w × h mm) on the current page of `doc`. */
export type SvgPainter = (doc: jsPDF, svg: string, w: number, h: number) => Promise<void>;

export interface PdfSheet {
  /** SVG markup in mm (rendered on demand, so big sets are not held in memory as SVG). */
  svg: () => string;
  w: number;
  h: number;
  /** Bookmark of this page; pages of the same `group` are nested under one group bookmark. */
  bookmark?: { title: string; group?: string };
}

export interface PdfBookOptions {
  /** Document title (PDF info dictionary). */
  title?: string;
  /** Deflate the page content streams (default true). */
  compress?: boolean;
  /** Called after each page; return false to stop (the PDF is then not finished). */
  onPage?: (index: number, total: number) => boolean | void;
}

const orient = (s: { w: number; h: number }) => (s.w >= s.h ? 'landscape' : 'portrait');

const NEAR_ASCII: Record<string, string> = { '–': '-', '—': '-', '−': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*', '×': 'x', '→': '->', '≤': '<=', '≥': '>=', '≈': '~', '€': 'EUR' };

/** Bookmark titles: Latin-1 only (PDFDocEncoding agrees with it there); anything else is replaced. */
export function bookmarkText(s: string): string {
  return [...s].map((ch) => (ch.codePointAt(0)! < 0x7f || (ch.codePointAt(0)! >= 0xa0 && ch.codePointAt(0)! <= 0xff) ? ch : (NEAR_ASCII[ch] ?? '?'))).join('');
}

export class PdfCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

export async function sheetsToPdf(sheets: PdfSheet[], paint: SvgPainter, opts: PdfBookOptions = {}): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const first = sheets[0] ?? { w: 210, h: 297 };
  const doc = new jsPDF({ orientation: orient(first), unit: 'mm', format: [first.w, first.h], compress: opts.compress !== false });
  if (opts.title) doc.setProperties({ title: opts.title, creator: 'FacadeSteel' });
  let group = null as { name: string; node: unknown } | null;
  let marked = false;
  for (const [i, s] of sheets.entries()) {
    if (i > 0) doc.addPage([s.w, s.h], orient(s));
    await paint(doc, s.svg(), s.w, s.h);
    const bm = s.bookmark;
    if (bm) {
      marked = true;
      let parent: unknown = null;
      if (bm.group) {
        if (group?.name !== bm.group) group = { name: bm.group, node: doc.outline.add(null, bookmarkText(bm.group), { pageNumber: i + 1 }) };
        parent = group.node;
      } else group = null;
      doc.outline.add(parent, bookmarkText(bm.title), { pageNumber: i + 1 });
    }
    if (opts.onPage?.(i, sheets.length) === false) throw new PdfCancelled();
  }
  if (marked) doc.setDisplayMode('fullpage', 'continuous', 'UseOutlines');
  return new Uint8Array(doc.output('arraybuffer'));
}

/** Number of pages of a PDF (counts page objects; enough for the PDFs written here). */
export function pdfPageCount(bytes: Uint8Array): number {
  const s = new TextDecoder('latin1').decode(bytes);
  return (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

/** Bookmark titles of a PDF written by jsPDF (outline items, in file order). */
export function pdfOutlineTitles(bytes: Uint8Array): string[] {
  const s = new TextDecoder('latin1').decode(bytes);
  const out: string[] = [];
  for (const m of s.matchAll(/\/Title \(((?:\\.|[^\\)])*)\)\s*\/Parent/g)) out.push(m[1].replace(/\\(.)/g, '$1'));
  return out;
}
