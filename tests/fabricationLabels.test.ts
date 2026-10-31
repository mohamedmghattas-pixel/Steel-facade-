import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import { sampleProject } from '../src/core/sample';
import { CODE128_PATTERNS, code128Bars, code128Checksum, code128Values, encodeCode128B } from '../src/core/fabrication/code128';
import { LABEL_LAYOUTS, labelItems, labelPages, labelPayload, makeQr } from '../src/core/fabrication/labels';
import { pdfSafe } from '../src/core/reports/tablePages';

describe('Code 128 (set B)', () => {
  it('has 107 distinct, well-formed symbol patterns', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((pat, v) => {
      const w = [...pat].map(Number);
      const total = w.reduce((s, x) => s + x, 0);
      expect(total).toBe(v === 106 ? 13 : 11);
      // Bars (odd positions from 1) always add up to an even number of modules.
      const bars = w.filter((_, i) => i % 2 === 0).reduce((s, x) => s + x, 0);
      expect(bars % 2).toBe(0);
    });
  });

  it('computes the check symbol: PJJ123C → 55', () => {
    // Start B 104 + P(48)·1 + J(42)·2 + J(42)·3 + 1(17)·4 + 2(18)·5 + 3(19)·6 + C(35)·7 = 879; 879 mod 103 = 55.
    expect(code128Values('PJJ123C')).toEqual([48, 42, 42, 17, 18, 19, 35]);
    expect(code128Checksum(code128Values('PJJ123C'))).toBe(55);
    expect(encodeCode128B('PJJ123C').check).toBe(55);
  });

  it('encodes a known string to the exact bar pattern', () => {
    // "A": Start B 211214, A (33) 111323, check (104 + 33) mod 103 = 34 → 131123, Stop 2331112.
    const c = encodeCode128B('A');
    expect(c.symbols).toEqual([104, 33, 34, 106]);
    expect(c.pattern).toBe('211214' + '111323' + '131123' + '2331112');
    expect(c.modules).toBe(11 * 3 + 13);
    const m1 = encodeCode128B('m1');
    expect(m1.check).toBe((104 + 77 * 1 + 17 * 2) % 103);
    expect(code128Bars(m1)).toHaveLength(3 * 4 + 4);
  });
});

describe('part labels', () => {
  const p = sampleProject();
  p.batches = [{ id: 'b1', name: 'Delivery 1' }];
  p.phases = [{ id: 'ph1', name: 'Phase 1', sequence: 1 }];
  for (const m of Object.values(p.members)) {
    m.batch = 'b1';
    m.phase = 'ph1';
  }
  const dm = deriveModel(p);

  it('makes one label per physical piece, or one per mark and batch', () => {
    const pieces = labelItems(p, dm, 'piece');
    expect(pieces).toHaveLength(dm.parts.length);
    const marks = labelItems(p, dm, 'mark');
    expect(marks.length).toBe(new Set(dm.parts.map((x) => x.mark)).size);
    expect(marks.reduce((s, l) => s + l.qty, 0)).toBe(dm.parts.length);
    const l = pieces[0];
    expect(l.batch).toBe('Delivery 1');
    expect(l.phase).toBe('Phase 1');
    expect(l.projectNo).toBe('FS-001');
    expect(JSON.parse(l.payload)).toEqual({ p: 'FS-001', m: l.mark, a: l.assembly, q: l.qty, i: 1 });
  });

  it('fits the QR payload in a small QR version', () => {
    const payload = labelPayload('FS-001-BLOCK-A', 'pl12', 'BK12', 120, 117);
    const qr = makeQr(payload);
    expect(qr.version).toBeGreaterThanOrEqual(2);
    expect(qr.version).toBeLessThanOrEqual(4);
    expect(qr.size).toBe(17 + 4 * qr.version);
    // Finder pattern corners are dark.
    expect(qr.dark(0, 0)).toBe(true);
    expect(qr.dark(0, qr.size - 1)).toBe(true);
    expect(qr.dark(qr.size - 1, 0)).toBe(true);
  });

  it('lays labels out on sheets for each layout', () => {
    const items = labelItems(p, dm, 'piece');
    for (const L of Object.values(LABEL_LAYOUTS)) {
      const pages = labelPages(items, L.id);
      const per = L.cols * L.rows;
      expect(pages).toHaveLength(Math.ceil(items.length / per));
      expect(pages[0].w).toBe(L.page.w);
      expect(pages[0].svg.match(/<g transform/g)).toHaveLength(Math.min(per, items.length));
      // Labels stay on the page.
      expect(L.left + L.cols * L.label.w + (L.cols - 1) * L.gapX).toBeLessThanOrEqual(L.page.w + 1e-9);
      expect(L.top + L.rows * L.label.h + (L.rows - 1) * L.gapY).toBeLessThanOrEqual(L.page.h + 1e-9);
    }
    const svg = labelPages(items.slice(0, 1), 'a4-3x8')[0].svg;
    expect(svg).toContain(items[0].mark);
    expect(svg).toContain('Delivery 1');
  });

  it('keeps PDF text within the standard-font (Windows-1252) character set', () => {
    expect(pdfSafe('PL10 160 × 150 — Ø18 · 2 m² ≈ 5 € …')).toBe('PL10 160 × 150 — Ø18 · 2 m² ~ 5 € …');
    expect(pdfSafe('Batch 東 → site')).toBe('Batch ? -> site');
  });
});
