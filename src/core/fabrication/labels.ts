/**
 * Part labels with a QR code and a Code 128 barcode, laid out on label sheets
 * (SVG pages in mm, converted to PDF by the UI).
 *
 * QR content: compact JSON {"p": project no., "m": part mark, "a": assembly,
 * "q": quantity, "i": piece number (per-piece labels only)}. Code 128 (set B)
 * carries the part mark. QR error correction level M, 4-module quiet zone.
 */
import qrcode from 'qrcode-generator';
import type { LabelLayout, Project } from '../model/types';
import { uniqueParts, type DerivedModel, type Part } from '../derive/model';
import { batchKey, batchName, batchOrder, partBatchId, partPhaseId, phaseName } from './batches';
import { code128Bars, encodeCode128B } from './code128';
import { pdfSafe, type SvgPage } from '../reports/tablePages';

export interface LabelLayoutDef {
  id: LabelLayout;
  name: string;
  page: { w: number; h: number };
  label: { w: number; h: number };
  cols: number;
  rows: number;
  /** Offset of the first label from the page's top-left corner, and the gaps between labels, mm. */
  left: number;
  top: number;
  gapX: number;
  gapY: number;
}

export const LABEL_LAYOUTS: Record<LabelLayout, LabelLayoutDef> = {
  'a4-3x8': { id: 'a4-3x8', name: 'A4, 3 × 8 labels 70 × 37 mm', page: { w: 210, h: 297 }, label: { w: 70, h: 37 }, cols: 3, rows: 8, left: 0, top: 0.5, gapX: 0, gapY: 0 },
  'a4-2x7': { id: 'a4-2x7', name: 'A4, 2 × 7 labels 99 × 38 mm', page: { w: 210, h: 297 }, label: { w: 99, h: 38 }, cols: 2, rows: 7, left: 4.75, top: 15.5, gapX: 2.5, gapY: 0 },
  'thermal-100x50': { id: 'thermal-100x50', name: 'Thermal roll, 100 × 50 mm', page: { w: 100, h: 50 }, label: { w: 100, h: 50 }, cols: 1, rows: 1, left: 0, top: 0, gapX: 0, gapY: 0 },
};

export interface LabelData {
  mark: string;
  assembly: string;
  name: string;
  profile: string;
  material: string;
  /** Length (linear parts) or width × height (plates), mm. */
  size: string;
  /** kg each */
  weight: number;
  finish: string;
  phase: string;
  batch: string;
  projectNo: string;
  /** Quantity the label stands for: the mark's total (per piece) or the count in its batch (per mark). */
  qty: number;
  /** Piece number (1-based) for per-piece labels. */
  piece?: number;
  payload: string;
}

const FINISH: Record<string, string> = { none: 'Black', hdg: 'HDG', paint: 'Paint', 'hdg+paint': 'HDG + paint' };

export function partSize(part: Part): string {
  return part.kind === 'plate' ? `${Math.round(part.length)} × ${Math.round(part.width)}` : `L ${Math.round(part.length)}`;
}

/** Compact QR payload. */
export function labelPayload(projectNo: string, mark: string, assembly: string, qty: number, piece?: number): string {
  const o: Record<string, string | number> = { p: projectNo, m: mark, a: assembly, q: qty };
  if (piece !== undefined) o.i = piece;
  return JSON.stringify(o);
}

/** Labels for every physical piece, or one per unique mark and delivery batch; ordered by batch then mark. */
export function labelItems(p: Project, dm: DerivedModel, per: 'piece' | 'mark' = 'piece'): LabelData[] {
  const projectNo = p.info.number || p.info.name;
  const out: { key: string; label: LabelData }[] = [];
  for (const { part, qty, refs } of uniqueParts(dm)) {
    const pieces = refs.map((r) => dm.partByRef.get(r)!).filter(Boolean);
    const byBatch = new Map<string, Part[]>();
    for (const pc of pieces) {
      const k = batchKey(p, partBatchId(p, pc));
      byBatch.set(k, [...(byBatch.get(k) ?? []), pc]);
    }
    const base = (pc: Part) => ({
      mark: part.mark,
      name: part.name,
      profile: part.profile,
      material: part.material,
      size: partSize(part),
      weight: part.mass,
      finish: FINISH[part.finish] ?? part.finish,
      phase: phaseName(p, partPhaseId(p, pc)),
      batch: batchName(p, partBatchId(p, pc)),
      projectNo,
    });
    if (per === 'piece') {
      pieces.forEach((pc, i) =>
        out.push({ key: batchKey(p, partBatchId(p, pc)), label: { ...base(pc), assembly: pc.assembly, qty, piece: i + 1, payload: labelPayload(projectNo, part.mark, pc.assembly, qty, i + 1) } }),
      );
    } else {
      for (const [k, list] of byBatch) {
        const asm = [...new Set(list.map((x) => x.assembly))].join(', ');
        out.push({ key: k, label: { ...base(list[0]), assembly: asm, qty: list.length, payload: labelPayload(projectNo, part.mark, asm, list.length) } });
      }
    }
  }
  const order = batchOrder(p, out.map((o) => o.key));
  return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)).map((o) => o.label);
}

// ---------------------------------------------------------------------------
// QR

export interface QrMatrix {
  /** QR version 1–40 (size = 17 + 4 × version modules). */
  version: number;
  size: number;
  dark: (row: number, col: number) => boolean;
}

export function makeQr(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return { version: (size - 17) / 4, size, dark: (r, c) => qr.isDark(r, c) };
}

const n2 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const esc = (s: string) => pdfSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** QR as one SVG path (horizontal runs of dark modules), `size` mm square including a 4-module quiet zone. */
export function qrSvg(m: QrMatrix, x: number, y: number, size: number): string {
  const quiet = 4;
  const cell = size / (m.size + 2 * quiet);
  const d: string[] = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) {
        c++;
        continue;
      }
      let e = c;
      while (e < m.size && m.dark(r, e)) e++;
      d.push(`M${n2(x + (c + quiet) * cell)} ${n2(y + (r + quiet) * cell)}h${n2((e - c) * cell)}v${n2(cell)}h${n2(-(e - c) * cell)}z`);
      c = e;
    }
  }
  return `<path d="${d.join('')}" fill="#000"/>`;
}

/** Code 128 B as one SVG path, fitted into `width` mm including 10-module quiet zones. */
export function barcodeSvg(text: string, x: number, y: number, width: number, height: number): { svg: string; module: number } {
  const code = encodeCode128B(text);
  const quiet = 10;
  const module = width / (code.modules + 2 * quiet);
  const d = code128Bars(code)
    .map(([bx, bw]) => `M${n2(x + (bx + quiet) * module)} ${n2(y)}h${n2(bw * module)}v${n2(height)}h${n2(-bw * module)}z`)
    .join('');
  return { svg: `<path d="${d}" fill="#000"/>`, module };
}

/** Truncate text to roughly fit a width at a font size (Helvetica average advance ≈ 0.55 em). */
function fit(text: string, width: number, size: number): string {
  const max = Math.max(3, Math.floor(width / (0.55 * size)));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One label's SVG content in label coordinates (mm, y down). */
export function labelSvg(l: LabelData, w: number, h: number): string {
  const pad = h >= 45 ? 3 : 2;
  const qs = Math.min(h - 2 * pad, w * 0.4);
  const out: string[] = [];
  out.push(qrSvg(makeQr(l.payload), pad, (h - qs) / 2, qs));
  const x0 = pad + qs + 1.5;
  const tw = w - x0 - pad;
  const big = Math.min(h * 0.19, 9);
  const small = Math.min(h * 0.072, 3.4);
  const barH = Math.min(h * 0.17, 9);
  let y = pad + big * 0.8;
  out.push(`<text x="${n2(x0)}" y="${n2(y)}" font-size="${n2(big)}" font-weight="bold">${esc(fit(l.mark, tw, big))}</text>`);
  const lines = [
    `${l.profile} · ${l.size}`,
    `Asm ${l.assembly || '-'} · ${l.weight.toFixed(1)} kg`,
    `${l.material} · ${l.finish}`,
    `${l.phase ? `${l.phase} · ` : ''}${l.batch}`,
    `${l.projectNo}${l.piece ? ` · ${l.piece}/${l.qty}` : ` · qty ${l.qty}`}`,
  ];
  y += small * 0.4;
  for (const t of lines) {
    y += small * 1.18;
    out.push(`<text x="${n2(x0)}" y="${n2(y)}" font-size="${n2(small)}">${esc(fit(t, tw, small))}</text>`);
  }
  const barY = Math.min(h - pad - barH, y + small * 0.6);
  out.push(barcodeSvg(l.mark, x0 - 1, barY, tw + 1, Math.max(4, h - pad - barY)).svg);
  return out.join('');
}

/** Label sheets as SVG pages (mm). */
export function labelPages(labels: LabelData[], layout: LabelLayout): SvgPage[] {
  const L = LABEL_LAYOUTS[layout];
  const per = L.cols * L.rows;
  const pages: SvgPage[] = [];
  for (let i = 0; i < labels.length; i += per) {
    const chunk = labels.slice(i, i + per);
    const body = chunk
      .map((l, j) => {
        const col = j % L.cols;
        const row = Math.floor(j / L.cols);
        const x = L.left + col * (L.label.w + L.gapX);
        const y = L.top + row * (L.label.h + L.gapY);
        return `<g transform="translate(${n2(x)} ${n2(y)})">${labelSvg(l, L.label.w, L.label.h)}</g>`;
      })
      .join('\n');
    pages.push({
      w: L.page.w,
      h: L.page.h,
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" width="${L.page.w}mm" height="${L.page.h}mm" viewBox="0 0 ${L.page.w} ${L.page.h}" font-family="Helvetica, Arial, sans-serif">` +
        `<rect x="0" y="0" width="${L.page.w}" height="${L.page.h}" fill="#fff"/>${body}</svg>`,
    });
  }
  return pages;
}
