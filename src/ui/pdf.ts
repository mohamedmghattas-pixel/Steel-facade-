import type { Drawing } from '../core/drawings/types';
import { drawingToSvg } from '../core/drawings/render';
import { sheetsToPdf, type PdfBookOptions, type PdfSheet, type SvgPainter } from '../core/export/pdfBook';
import type { SvgPage } from '../core/reports/tablePages';

let host: HTMLDivElement | null = null;
let measureCanvas: HTMLCanvasElement | null = null;

/**
 * svg2pdf.js measures every centred or right-aligned text on a new canvas (and its
 * 2D context), which dominated the painting of large drawing sets. While it paints,
 * canvases asked for get one shared canvas instead: the measuring sets its font
 * before each measurement, so sharing gives the same widths.
 */
async function withSharedCanvas<T>(run: () => Promise<T>): Promise<T> {
  const doc = document;
  const create = doc.createElement;
  measureCanvas ??= create.call(doc, 'canvas') as HTMLCanvasElement;
  const shared = measureCanvas;
  doc.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
    return typeof tag === 'string' && tag.toLowerCase() === 'canvas' ? shared : create.call(this, tag, options);
  } as typeof doc.createElement;
  try {
    return await run();
  } finally {
    doc.createElement = create;
  }
}

/** Puts an SVG on a jsPDF page with svg2pdf.js (vector output); needs the DOM. */
export const svgPainter: SvgPainter = async (doc, svg, w, h) => {
  const { svg2pdf } = await import('svg2pdf.js');
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden';
    document.body.appendChild(host);
  }
  host.innerHTML = svg;
  const el = host.querySelector('svg');
  try {
    if (el) await withSharedCanvas(() => svg2pdf(el, doc, { x: 0, y: 0, width: w, height: h }));
  } finally {
    host.innerHTML = '';
  }
};

const toBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' });

/** Render drawings to a multi-page PDF (one sheet per drawing, vector output), with a bookmark per drawing when there are several. */
export async function drawingsToPdf(drawings: Drawing[], opts: PdfBookOptions = {}): Promise<Blob> {
  const marks = drawings.length > 1;
  const sheets: PdfSheet[] = drawings.map((d) => ({ svg: () => drawingToSvg(d), w: d.sheet.w, h: d.sheet.h, ...(marks ? { bookmark: { title: `${d.number}  ${d.title}` } } : {}) }));
  return toBlob(await sheetsToPdf(sheets, svgPainter, opts));
}

/** Vector PDF from SVG pages (mm), one PDF page per SVG page. */
export async function svgPagesToPdf(pages: SvgPage[], opts: PdfBookOptions = {}): Promise<Blob> {
  return toBlob(await sheetsToPdf(pages.map((pg) => ({ svg: () => pg.svg, w: pg.w, h: pg.h })), svgPainter, opts));
}
