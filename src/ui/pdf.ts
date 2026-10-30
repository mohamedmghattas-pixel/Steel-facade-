import type { Drawing } from '../core/drawings/types';
import { drawingToSvg } from '../core/drawings/render';

/** Render drawings to a multi-page PDF (one sheet per drawing, vector output). */
export async function drawingsToPdf(drawings: Drawing[]): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const first = drawings[0]?.sheet ?? { w: 420, h: 297 };
  const orient = (s: { w: number; h: number }) => (s.w >= s.h ? 'landscape' : 'portrait');
  const doc = new jsPDF({ orientation: orient(first), unit: 'mm', format: [first.w, first.h] });
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden';
  document.body.appendChild(host);
  try {
    for (const [i, d] of drawings.entries()) {
      if (i > 0) doc.addPage([d.sheet.w, d.sheet.h], orient(d.sheet));
      host.innerHTML = drawingToSvg(d);
      const el = host.querySelector('svg');
      if (!el) continue;
      await svg2pdf(el, doc, { x: 0, y: 0, width: d.sheet.w, height: d.sheet.h });
    }
  } finally {
    host.remove();
  }
  return doc.output('blob');
}
