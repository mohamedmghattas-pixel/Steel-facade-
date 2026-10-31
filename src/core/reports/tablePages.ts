/**
 * Tabular documents (packing lists and similar) as SVG pages in mm, ready for
 * svg2pdf. Every document starts on a new page; long tables continue on the
 * next page with the header repeated; pages are numbered per document.
 */
import type { Row } from './bom';

export interface TableSection {
  title: string;
  head: string[];
  rows: Row[];
  /** Bold last row (totals). */
  footer?: Row;
  /** Relative column widths (default: from content). */
  widths?: number[];
}

export interface TableDoc {
  title: string;
  /** Lines under the title (project, batch, date …). */
  meta: string[];
  sections: TableSection[];
  /** Signature boxes printed after the last table (e.g. "Loaded by"). */
  signatures?: string[];
}

export interface SvgPage {
  w: number;
  h: number;
  svg: string;
}

const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const SUBST: Record<string, string> = { '≈': '~', '−': '-', '→': '->', '≤': '<=', '≥': '>=', '∞': 'inf', '✓': 'ok' };

/**
 * PDF standard fonts (Helvetica) only cover Windows-1252; anything else would be
 * garbled by svg2pdf / jsPDF, so it is replaced.
 */
export function pdfSafe(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 0x80 || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.includes(ch)) return ch;
      return SUBST[ch] ?? '?';
    })
    .join('');
}

const esc = (s: string) => pdfSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
const cellText = (v: string | number) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v);

function fit(text: string, width: number, size: number): string {
  const max = Math.max(2, Math.floor(width / (0.52 * size)));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function tablesToSvgPages(docs: TableDoc[], page: { w: number; h: number } = { w: 297, h: 210 }, footerText = ''): SvgPage[] {
  const M = 12;
  const font = 2.6;
  const rh = 5;
  const bottom = page.h - M - 6;
  const usable = page.w - 2 * M;
  const pages: { parts: string[]; doc: number }[] = [];
  const docPages: number[] = docs.map(() => 0);

  docs.forEach((doc, di) => {
    let cur: string[] = [];
    let y = 0;
    const newPage = () => {
      cur = [];
      pages.push({ parts: cur, doc: di });
      docPages[di]++;
      y = M + 6;
      cur.push(`<text x="${M}" y="${n2(y)}" font-size="5.5" font-weight="bold">${esc(doc.title)}</text>`);
      y += 2;
      for (const m of doc.meta) {
        y += 4.2;
        cur.push(`<text x="${M}" y="${n2(y)}" font-size="3">${esc(m)}</text>`);
      }
      y += 4;
    };
    newPage();
    for (const sec of doc.sections) {
      const cols = sec.head.length;
      const rel =
        sec.widths ??
        sec.head.map((h, c) => Math.min(40, Math.max(h.length * 0.8, 4, ...[...sec.rows, ...(sec.footer ? [sec.footer] : [])].map((r) => cellText(r[c] ?? '').length))));
      const total = rel.reduce((s, v) => s + v, 0) || 1;
      const widths = rel.map((v) => (v / total) * usable);
      const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((s, v) => s + v, 0));
      const numeric = sec.head.map((_, c) => sec.rows.length > 0 && sec.rows.every((r) => typeof r[c] === 'number' || r[c] === '' || r[c] === undefined));
      const drawRow = (r: Row, opts: { bold?: boolean; fill?: string }) => {
        if (opts.fill) cur.push(`<rect x="${M}" y="${n2(y)}" width="${n2(usable)}" height="${rh}" fill="${opts.fill}"/>`);
        for (let c = 0; c < cols; c++) {
          const t = fit(cellText(r[c] ?? ''), widths[c] - 2, font);
          const right = numeric[c] && !opts.fill;
          const x = right ? xs[c] + widths[c] - 1 : xs[c] + 1;
          cur.push(`<text x="${n2(x)}" y="${n2(y + rh - 1.5)}" font-size="${font}"${right ? ' text-anchor="end"' : ''}${opts.bold ? ' font-weight="bold"' : ''}>${esc(t)}</text>`);
        }
        cur.push(`<line x1="${M}" y1="${n2(y + rh)}" x2="${n2(M + usable)}" y2="${n2(y + rh)}" stroke="#999" stroke-width="0.15"/>`);
        y += rh;
      };
      const header = (cont: boolean) => {
        y += 3;
        cur.push(`<text x="${M}" y="${n2(y + 3)}" font-size="3.6" font-weight="bold">${esc(sec.title + (cont ? ' (continued)' : ''))}</text>`);
        y += 5;
        drawRow(sec.head, { bold: true, fill: '#e6e6e6' });
      };
      if (y + 8 + 2 * rh > bottom) newPage();
      header(false);
      if (!sec.rows.length) drawRow(['—'], {});
      for (const r of sec.rows) {
        if (y + rh > bottom) {
          newPage();
          header(true);
        }
        drawRow(r, {});
      }
      if (sec.footer) {
        if (y + rh > bottom) {
          newPage();
          header(true);
        }
        drawRow(sec.footer, { bold: true });
      }
    }
    if (doc.signatures?.length) {
      const bh = 16;
      if (y + bh + 8 > bottom) newPage();
      y += 8;
      const bw = usable / doc.signatures.length;
      doc.signatures.forEach((s, i) => {
        const x = M + i * bw;
        cur.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(bw - 4)}" height="${bh}" fill="none" stroke="#000" stroke-width="0.25"/>`);
        cur.push(`<text x="${n2(x + 1.5)}" y="${n2(y + 4)}" font-size="2.6">${esc(s)}</text>`);
        cur.push(`<text x="${n2(x + 1.5)}" y="${n2(y + bh - 1.5)}" font-size="2.2" fill="#666">Name / signature / date</text>`);
      });
      y += bh;
    }
  });

  const seen: number[] = docs.map(() => 0);
  return pages.map((pg) => {
    seen[pg.doc]++;
    const foot = `<text x="${M}" y="${n2(page.h - M + 2)}" font-size="2.4" fill="#444">${esc(footerText)}</text><text x="${n2(page.w - M)}" y="${n2(page.h - M + 2)}" font-size="2.4" fill="#444" text-anchor="end">Page ${seen[pg.doc]} of ${docPages[pg.doc]}</text>`;
    return {
      w: page.w,
      h: page.h,
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" width="${page.w}mm" height="${page.h}mm" viewBox="0 0 ${page.w} ${page.h}" font-family="Helvetica, Arial, sans-serif">` +
        `<rect x="0" y="0" width="${page.w}" height="${page.h}" fill="#fff"/>${pg.parts.join('')}${foot}</svg>`,
    };
  });
}
