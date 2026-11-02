/**
 * The client's own title block: import from DXF (linework, texts, MTEXT, blocks with
 * ATTDEF / ATTRIB, units), live fields filled per sheet, free template content drawn
 * on every sheet size and in SVG / DXF, the layout keeping clear of it, migration and
 * JSON round trip. Synthetic DXF fixtures only (titleBlockFixture.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runTool, TOOLS } from '../src/assistant/tools';
import { useStore } from '../src/state/store';
import { deriveModel } from '../src/core/derive/model';
import {
  activeTemplate,
  allDrawings,
  checkSheetLayout,
  drawingToDxf,
  drawingToSvg,
  drawTemplateTitleBlock,
  gaDrawing,
  parseTemplates,
  placeholderSource,
  readTitleBlockDxf,
  sampleTitleData,
  templateBox,
  templateTextValue,
  textPlaceholders,
  titleBlockSvg,
  titleBlockTemplate,
  type DEnt,
  type Drawing,
  type TitleBlockDxf,
} from '../src/core/drawings';
import { Sheet } from '../src/core/drawings/dims';
import { frameRect } from '../src/core/drawings/layout';
import { cleanTextValue, parseMtext } from '../src/core/drawings/titleBlockDxf';
import { readDxf } from '../src/core/io/dxfReader';
import type { Project, SheetSize, SheetTemplate } from '../src/core/model/types';
import { migrateProject } from '../src/state/storage';
import { sampleFacade } from './helpers';
import { isoSizeTitleBlockDxf, titleBlockFixtureDxf } from './titleBlockFixture';

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;
const textsOf = (ents: DEnt[]) => ents.filter((e): e is Extract<DEnt, { t: 'text' }> => e.t === 'text').map((e) => e.text);
const texts = (d: { entities: DEnt[] }) => textsOf(d.entities);
const find = (imp: TitleBlockDxf, s: string) => imp.texts.find((t) => t.tag === s) ?? imp.texts.find((t) => t.lines.some((l) => l.text === s));

function withTemplate(p: Project, t: SheetTemplate): Project {
  p.drawings.templates.push(t);
  p.drawings.activeTemplate = t.id;
  return p;
}

describe('DXF reader keeps attributes when asked', () => {
  const text = titleBlockFixtureDxf();
  it('drops ATTRIB records by default and keeps them on the INSERT with { attributes: true }', () => {
    const plain = readDxf(text);
    const ins = plain.entities.filter((e) => e.type === 'INSERT');
    expect(ins).toHaveLength(3);
    expect(ins.every((e) => e.attribs === undefined)).toBe(true);
    expect(plain.entities.some((e) => e.type === 'ATTRIB')).toBe(false);
    const withAttr = readDxf(text, { attributes: true });
    expect(withAttr.entities.map((e) => e.type)).toEqual(plain.entities.map((e) => e.type));
    const tb = withAttr.entities.find((e) => e.type === 'INSERT' && e.values.includes('TB_ATTR'))!;
    expect(tb.attribs?.map((a) => a.values[a.codes.indexOf(2)])).toEqual(['DRAWN_BY', 'CHECKED', 'UNKNOWN_TAG']);
    expect(withAttr.entities.filter((e) => e.type === 'INSERT' && e !== tb).every((e) => e.attribs === undefined)).toBe(true);
    // Block contents (ATTDEF) are unchanged either way.
    expect(withAttr.blocks.get('TB_ATTR')!.entities.map((e) => e.type)).toEqual(plain.blocks.get('TB_ATTR')!.entities.map((e) => e.type));
  });
});

describe('text values', () => {
  it('strips MTEXT formatting, splits paragraphs, keeps placeholders', () => {
    expect(parseMtext('{\\fArial|b1|i0|c0|p34;\\{TITLE\\}}')).toEqual({ lines: ['{TITLE}'], bold: true, h: undefined, hRel: undefined });
    expect(parseMtext('\\H2.5;Line 1\\PLine {\\C1;two}').lines).toEqual(['Line 1', 'Line two']);
    expect(parseMtext('\\H2.5;Line').h).toBe(2.5);
    expect(parseMtext('\\H0.5x;Line').hRel).toBe(0.5);
    expect(parseMtext('{PROJECT} and {\\Lunder}').lines).toEqual(['{PROJECT} and under']);
    expect(parseMtext('\\A1;1\\S1^2; in\\~x \\\\ y %%c20 \\U+00B0').lines).toEqual(['11/2 in x \\ y Ø20 °']);
    expect(cleanTextValue('%%uØ%%c10 %%d %%p0.5 %%%')).toBe('ØØ10 ° ±0.5 %');
  });

  it('matches placeholders and tags to field sources, case-insensitively', () => {
    expect(placeholderSource('PROJECT')).toBe('project.name');
    expect(placeholderSource('Drawing_No')).toBe('drawing.number');
    expect(placeholderSource('dwg-no')).toBe('drawing.number');
    expect(placeholderSource('drawing.number')).toBe('drawing.number');
    expect(placeholderSource('Sheet n/N')).toBe('drawing.sheet');
    expect(placeholderSource('rev')).toBe('drawing.rev');
    expect(placeholderSource('CHECKED_BY')).toBe('drawing.checked');
    expect(placeholderSource('mm')).toBeNull();
    expect(textPlaceholders('Sheet {SHEET_N} of {SHEETS} [mm]').map((x) => x.source)).toEqual(['drawing.sheetIndex', 'drawing.sheetCount']);
    const p = sampleFacade();
    p.info.client = 'Client Co';
    const d = { ...sampleTitleData(p), sheetNo: '2/3', scale: '1:20' };
    expect(templateTextValue(p, 'fmt:Sheet {SHEET_N} of {SHEETS}, scale <SCALE>, {UNKNOWN}', d)).toBe('Sheet 2 of 3, scale 1:20, {UNKNOWN}');
    expect(templateTextValue(p, 'project.client', d)).toBe('Client Co');
    expect(templateTextValue(p, 'text:Fixed {CLIENT}', d)).toBe('Fixed {CLIENT}');
  });
});

describe('title block import from DXF', () => {
  const imp = readTitleBlockDxf(titleBlockFixtureDxf());

  it('reads the units from $INSUNITS (inches) and takes the extents as the block size in mm', () => {
    expect(imp.unitScale).toBe(25.4);
    expect(imp.unitSource).toBe('insunits');
    expect(imp.units).toBe('inches');
    expect(near(imp.width, 180)).toBe(true);
    expect(near(imp.height, 50)).toBe(true);
    expect(imp.space).toBe('model');
  });

  it('reads the linework: lines, polylines, arcs, circles, ellipses, solids and solid hatches', () => {
    const g = imp.graphics;
    expect(g.filter((x) => x.t === 'line')).toHaveLength(5 + 2 + 1);
    const border = g.find((x) => x.t === 'rect' && near(x.w, 180) && near(x.h, 50));
    expect(border && border.t === 'rect' && border.lw).toBe('frame');
    const cellLine = g.find((x) => x.t === 'line' && near(x.a.y, 10) && near(x.b.y, 10) && near(Math.abs(x.b.x - x.a.x), 180));
    expect(cellLine && cellLine.t === 'line' && cellLine.lw).toBe('medium');
    expect(g.some((x) => x.t === 'circle' && near(x.c.x, 20) && near(x.c.y, 40) && near(x.r, 4))).toBe(true);
    // The half arc (r 6 above the centre) and the ellipse (8 × 4) as chords.
    const arc = g.find((x) => x.t === 'poly' && !x.closed && x.pts.every((q) => near(Math.hypot(q.x - 20, q.y - 40), 6, 1e-2)));
    expect(arc).toBeDefined();
    const ell = g.find((x) => x.t === 'poly' && x.closed && !x.fill && x.pts.some((q) => near(q.x, 53)) && x.pts.some((q) => near(q.y, 44, 1e-2)));
    expect(ell).toBeDefined();
    expect(g.filter((x) => x.t === 'poly' && x.fill)).toHaveLength(2);
    // The mirrored block: its line runs from x 100 to 90 (scale x −1).
    expect(g.some((x) => x.t === 'line' && near(Math.min(x.a.x, x.b.x), 90) && near(Math.max(x.a.x, x.b.x), 100) && near(x.a.y, 15))).toBe(true);
    // Lines of the blocks: created/checked divider (x 30, y 10–18) and the sheet box (x 150).
    expect(g.some((x) => x.t === 'line' && near(x.a.x, 30) && near(x.a.y, 10) && near(x.b.y, 18))).toBe(true);
    expect(g.some((x) => x.t === 'line' && near(x.a.x, 150) && near(x.b.y, 10))).toBe(true);
    expect(imp.read.INSERT).toBe(3);
  });

  it('finds the texts and suggests fields for placeholders and attribute tags', () => {
    expect(find(imp, 'PROJECT')?.suggested).toBe('text:');
    expect(find(imp, '{PROJECT}')?.suggested).toBe('project.name');
    expect(find(imp, '{Drawing_No}')?.suggested).toBe('drawing.number');
    expect(find(imp, 'Scale {SCALE}')?.suggested).toBe('fmt:');
    const title = find(imp, '{TITLE}')!;
    expect(title.kind).toBe('MTEXT');
    expect(title.bold).toBe(true);
    expect(title.suggested).toBe('drawing.title');
    const company = find(imp, 'ACME Facades Ltd')!;
    expect(company.lines.map((l) => l.text)).toEqual(['ACME Facades Ltd', 'London']);
    expect(company.suggested).toBe('text:');
    // Two lines below the top of the MTEXT (attachment top left): baselines 2.5 mm and 2.5 + 5/3·2.5 mm below it.
    expect(near(company.lines[0].y, 48 - 2.5) && near(company.lines[1].y, 48 - 2.5 - (5 / 3) * 2.5)).toBe(true);
    expect(find(imp, 'Client: {CLIENT}')?.suggested).toBe('fmt:');
    // Attributes: ATTRIB values with their tags (the block's ATTDEFs are not listed twice).
    expect(find(imp, 'DRAWN_BY')).toMatchObject({ kind: 'ATTRIB', suggested: 'drawing.drawn', lines: [{ text: 'MG' }] });
    expect(find(imp, 'CHECKED')).toMatchObject({ kind: 'ATTRIB', suggested: 'drawing.checked' });
    expect(find(imp, 'UNKNOWN_TAG')).toMatchObject({ kind: 'ATTRIB', suggested: 'text:', lines: [{ text: 'Some text' }] });
    expect(imp.texts.filter((t) => t.tag === 'DRAWN_BY')).toHaveLength(1);
    // A constant attribute stays (no ATTRIB for it); an insert without ATTRIBs uses its ATTDEF.
    expect(find(imp, 'CONST')).toMatchObject({ kind: 'ATTDEF', lines: [{ text: 'ISO 7200' }], suggested: 'text:' });
    const sheet = find(imp, 'SHEET')!;
    expect(sheet.kind).toBe('ATTDEF');
    expect(sheet.suggested).toBe('drawing.sheet');
    expect(near(sheet.lines[0].x, 152) && near(sheet.lines[0].y, 2)).toBe(true);
    // Centred TEXT at its alignment point.
    const scale = find(imp, 'Scale {SCALE}')!;
    expect(scale.anchor).toBe('middle');
    expect(near(scale.lines[0].x, 135) && near(scale.lines[0].y, 2)).toBe(true);
    // Mirrored block text stays readable at the mirrored place (right-aligned at x 100).
    const mk = find(imp, 'MK')!;
    expect(mk.rot).toBe(0);
    expect(mk.anchor).toBe('end');
    expect(near(mk.lines[0].x, 100) && near(mk.lines[0].y, 16)).toBe(true);
    // Heights in mm.
    expect(near(find(imp, '{Drawing_No}')!.h, 5)).toBe(true);
  });

  it('offers the image frame as the logo rectangle and reports what it left out', () => {
    expect(imp.images).toBe(1);
    expect(imp.logoRect).toEqual({ x: 125, y: 32, w: 30, h: 16 });
    expect(imp.notes.some((n) => /external files/.test(n))).toBe(true);
    expect(imp.skipped['IMAGE (external file)']).toBe(1);
  });

  it('guesses the units when the file has none, or takes the units it is given', () => {
    const noUnits = titleBlockFixtureDxf({ units: false });
    const guessed = readTitleBlockDxf(noUnits);
    expect(guessed.unitSource).toBe('guess');
    expect(guessed.unitScale).toBe(25.4);
    expect(near(guessed.width, 180)).toBe(true);
    expect(guessed.notes.some((n) => /does not state its units/.test(n))).toBe(true);
    const mm = readTitleBlockDxf(noUnits, { unitScale: 1 });
    expect(mm.unitSource).toBe('user');
    expect(near(mm.width, 180 / 25.4)).toBe(true);
    const metric = readTitleBlockDxf(titleBlockFixtureDxf({ units: false, perMm: 1 }));
    expect(metric.unitScale).toBe(1);
    expect(near(metric.width, 180)).toBe(true);
    expect(() => readTitleBlockDxf('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n')).toThrow(/No title block/);
    expect(() => readTitleBlockDxf('not a dxf')).toThrow(/DXF/);
  });

  it('builds a template: live fields, fixed texts, placeholders, logo, border', () => {
    const logo = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
    const t = titleBlockTemplate(imp, 'tb1', { name: 'ACME', logo, logoRect: imp.logoRect, file: 'acme.dxf' });
    expect(t.width).toBe(180);
    expect(t.height).toBe(50);
    expect(t.fields).toEqual([]);
    expect(t.logoRect).toEqual(imp.logoRect);
    expect(t.imported).toMatchObject({ file: 'acme.dxf', units: 'inches', unitScale: 25.4 });
    // The outline is the 0.7 mm border: the DXF's own outer rectangle is left out.
    expect(t.border).toBe(true);
    expect(t.graphics!.some((g) => g.t === 'rect' && near(g.w, 180))).toBe(false);
    const by = (src: string) => t.texts!.find((x) => x.source === src);
    expect(by('project.name')).toMatchObject({ x: 2, y: 33, h: 3.5 });
    // Room to the next vertical line (x 90) on the right, less a gap.
    expect(by('project.name')!.maxW).toBeCloseTo(90 - 2 - 0.8, 3);
    expect(by('drawing.number')!.maxW).toBeCloseTo(120 - 62 - 0.8, 3);
    expect(by('drawing.title')).toMatchObject({ bold: true });
    expect(by('drawing.drawn')).toMatchObject({ origin: 'DRAWN_BY' });
    expect(by('drawing.sheet')).toBeDefined();
    expect(by('fmt:Scale {SCALE}')).toMatchObject({ anchor: 'middle' });
    expect(by('fmt:Client: {CLIENT}')).toBeDefined();
    expect(by('fmt:Rev {REV}')).toBeDefined();
    expect(by('text:ACME Facades Ltd')).toBeDefined();
    expect(by('text:London')).toBeDefined();
    expect(by('text:Some text')).toBeDefined();
    // Mapping: a fixed text to a field, a field kept fixed, a text left out; scaled to 90 %.
    const i = imp.texts.indexOf(find(imp, 'UNKNOWN_TAG')!);
    const j = imp.texts.indexOf(find(imp, '{PROJECT}')!);
    const k = imp.texts.indexOf(find(imp, 'PROJECT')!);
    const map = imp.texts.map((x) => x.suggested);
    map[i] = 'drawing.status';
    map[j] = 'text:';
    map[k] = '';
    const t2 = titleBlockTemplate(imp, 'tb2', { name: 'Mapped', map, scale: 0.9, border: false });
    expect(t2.width).toBeCloseTo(162, 3);
    expect(t2.border).toBe(false);
    expect(t2.graphics!.some((g) => g.t === 'rect' && near(g.w, 162))).toBe(true);
    expect(t2.texts!.find((x) => x.source === 'drawing.status')).toMatchObject({ origin: 'UNKNOWN_TAG' });
    expect(t2.texts!.some((x) => x.source === 'text:{PROJECT}')).toBe(true);
    expect(t2.texts!.some((x) => x.source === 'text:PROJECT')).toBe(false);
    expect(t2.texts!.find((x) => x.source === 'drawing.number')!.h).toBeCloseTo(4.5, 3);
    // Too large for a title block: scaled down to the limits.
    const big = titleBlockTemplate({ ...imp, width: 760, height: 100 }, 'tb3', { name: 'Big' });
    expect(big.width).toBe(380);
  });
});

describe('imported title block on the sheets', () => {
  const logo = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
  const imp = readTitleBlockDxf(titleBlockFixtureDxf());
  const tpl = () => titleBlockTemplate(imp, 'tb1', { name: 'ACME', logo, logoRect: imp.logoRect, file: 'acme.dxf' });
  const project = () => {
    const p = withTemplate(sampleFacade(), tpl());
    p.info.client = 'Client Co';
    p.info.designer = 'J. Smith';
    return p;
  };
  const issues = (ds: Drawing[]) => ds.flatMap((d) => checkSheetLayout(d).map((i) => `${d.number} ${d.sheetSize}${d.sheetCount ? ` (${d.sheetIndex}/${d.sheetCount})` : ''}: ${i.message}`));

  it('fills the fields per sheet on every drawing and keeps the fixed graphics', () => {
    const p = project();
    expect(activeTemplate(p).name).toBe('ACME');
    const ds = allDrawings(p, deriveModel(p));
    expect(ds.length).toBeGreaterThan(5);
    for (const d of ds) {
      const tx = texts(d);
      expect(tx, d.id).toContain(d.number);
      expect(tx).toContain(p.info.name);
      expect(tx).toContain(`Scale ${d.scale}`);
      // Sheet n/N (series of erection sheets count their own sheets).
      expect(tx.some((x) => /^\d+\/\d+$/.test(x))).toBe(true);
      expect(tx).toContain('Client: Client Co');
      expect(tx).toContain(`Rev ${d.rev}`);
      expect(tx).toContain('J. Smith');
      expect(tx).toContain('ACME Facades Ltd');
      expect(tx).toContain('Some text');
      expect(tx).toContain('ISO 7200');
      // Sample values of the DXF are replaced by the live fields.
      expect(tx).not.toContain('MG');
      expect(tx).not.toContain('{PROJECT}');
      // The block sits at the bottom right of the frame: the cell line at y 10 spans its width.
      const f = frameRect(d.sheetSize as SheetSize);
      expect(d.entities.some((e) => e.t === 'line' && near(e.a.x, f.x1 - 180) && near(e.b.x, f.x1) && near(e.a.y, f.y0 + 10))).toBe(true);
      expect(d.entities.some((e) => e.t === 'image' && near(e.p.x, f.x1 - 180 + 125) && near(e.w, 30))).toBe(true);
      expect(d.regions!.titleBlock).toEqual({ x0: f.x1 - 180, y0: f.y0, x1: f.x1, y1: f.y0 + 50 });
      expect(d.regions!.revisionTable.y0).toBe(f.y0 + 50);
    }
    expect(issues(ds)).toEqual([]);
    // SVG keeps the logo, DXF writes the texts and a frame for the logo.
    const ga = ds.find((d) => d.kind === 'ga')!;
    expect(drawingToSvg(ga)).toContain('<image');
    const dxf = drawingToDxf(ga);
    expect(dxf).toContain(ga.number);
    expect(dxf).toContain('ACME Facades Ltd');
    expect(dxf).not.toContain('data:image');
  });

  it('draws on every sheet size A0–A4 and in the ASME variant, clear of the layout', () => {
    const p = project();
    const d = sampleTitleData(p);
    for (const size of ['A4', 'A3', 'A2', 'A1', 'A0'] as const) {
      for (const proj of ['first', 'third'] as const) {
        const s = new Sheet(0, 0);
        drawTemplateTitleBlock(s, size, p, activeTemplate(p), d, proj);
        const f = frameRect(size);
        const xs = s.ents.flatMap((e) => (e.t === 'line' ? [e.a.x, e.b.x] : e.t === 'poly' ? e.pts.map((q) => q.x) : []));
        expect(Math.max(...xs)).toBeLessThanOrEqual(f.x1 + 1e-6);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(f.x1 - 180 - 1e-6);
        expect(textsOf(s.ents)).toContain(d.number);
      }
    }
    // GA on A1 and assembly sheets on A2, ASME standard: still clean.
    p.drawings.settings.gaSheet = 'A1';
    p.drawings.settings.sheet = 'A2';
    p.drawings.settings.standard = 'ASME';
    const ds = allDrawings(p, deriveModel(p));
    expect(ds.find((x) => x.kind === 'ga')!.sheetSize).toBe('A1');
    expect(issues(ds)).toEqual([]);
  });

  it('fills number, sheet n/N, scale, revision and status on continuation sheets', () => {
    const p = project();
    p.drawings.settings.extraNotes = Array.from({ length: 40 }, (_, i) => `Project note ${i + 1}: the facade contractor shall coordinate this item with the main contractor before fabrication and installation on site.`);
    const ds = allDrawings(p, deriveModel(p));
    const multi = ds.filter((d) => (d.sheetCount ?? 1) > 1);
    expect(multi.length).toBeGreaterThan(1);
    const first = multi[0];
    const same = ds.filter((d) => d.number === first.number);
    expect(same.length).toBe(first.sheetCount);
    p.drawings.revisions[same[1].id] = [{ rev: 'A', date: '2026-11-01', description: 'Issued', drawn: 'MG', checked: 'AB', approved: '', status: 'Released', fingerprint: same[1].fingerprint }];
    const again = allDrawings(p, deriveModel(p)).filter((d) => d.number === first.number);
    again.forEach((d, i) => {
      const tx = texts(d);
      expect(tx).toContain(d.number);
      expect(tx).toContain(`${i + 1}/${again.length}`);
      expect(tx).toContain(`Scale ${first.scale}`);
      expect(tx).toContain(`Rev ${d.rev}`);
    });
    expect(again[1].rev).toBe('A');
    expect(texts(again[1])).toContain('MG');
    expect(texts(again[1])).toContain('AB');
    expect(issues(again)).toEqual([]);
  });

  it('keeps every fingerprint of a block of the ISO 7200 size (fingerprints exclude the title block)', () => {
    const base = sampleFacade();
    const before = allDrawings(base, deriveModel(base));
    const iso = readTitleBlockDxf(isoSizeTitleBlockDxf());
    expect([iso.width, iso.height]).toEqual([180, 40]);
    expect(iso.texts.map((t) => t.suggested)).toEqual(['drawing.number', 'drawing.title', 'fmt:']);
    const p = withTemplate(sampleFacade(), titleBlockTemplate(iso, 'iso', { name: 'ISO size' }));
    const after = allDrawings(p, deriveModel(p));
    expect(after.map((d) => d.fingerprint)).toEqual(before.map((d) => d.fingerprint));
    expect(after.map((d) => d.number)).toEqual(before.map((d) => d.number));
    const tx = texts(after.find((d) => d.kind === 'ga')!);
    expect(tx.some((x) => /^Sheet \d+ of \d+$/.test(x))).toBe(true);
  });

  it('reserves the actual rectangle: a taller block moves the views and tables up', () => {
    const p = project();
    const t = p.drawings.templates[0];
    // 180 × 80 mm (scaled from the 180 × 50 import would change the width; stretch the height instead).
    t.height = 80;
    const ga = gaDrawing(p, deriveModel(p), 'front');
    const f = frameRect(ga.sheetSize as SheetSize);
    expect(ga.regions!.titleBlock.y1).toBe(f.y0 + 80);
    expect(checkSheetLayout(ga)).toEqual([]);
  });

  it('scales a block wider than the frame down to fit (A4: 180 mm inside the frame)', () => {
    expect(templateBox({ width: 200, height: 50 }, 'A4')).toEqual({ w: 180, h: 45, k: 0.9 });
    expect(templateBox({ width: 200, height: 50 }, 'A3')).toEqual({ w: 200, h: 50, k: 1 });
    const p = project();
    const t = { ...activeTemplate(p), width: 200 };
    const s = new Sheet(0, 0);
    drawTemplateTitleBlock(s, 'A4', p, t, sampleTitleData(p), 'first');
    const f = frameRect('A4');
    const border = s.ents.find((e) => e.t === 'poly' && e.layer === 'border');
    expect(border && border.t === 'poly' && near(border.pts[0].x, f.x0) && near(border.pts[1].x, f.x1)).toBe(true);
    const h = s.ents.find((e) => e.t === 'text' && e.text === p.info.name);
    expect(h && h.t === 'text' && near(h.h, 3.5 * 0.9)).toBe(true);
  });

  it('a free text mapped to the projection draws the ISO 5456-2 symbol', () => {
    const p = project();
    const t = activeTemplate(p);
    t.texts!.push({ x: 160, y: 20, h: 3, source: 'projection' });
    const s = new Sheet(0, 0);
    drawTemplateTitleBlock(s, 'A3', p, t, sampleTitleData(p), 'first');
    const f = frameRect('A3');
    expect(s.ents.some((e) => e.t === 'circle' && near(e.r, 3) && near(e.c.x, f.x1 - 180 + 160 + 1 + 13) && near(e.c.y, f.y0 + 20 + 3.5))).toBe(true);
  });

  it('previews the block alone with sample data', () => {
    const p = project();
    const svg = titleBlockSvg(p, activeTemplate(p));
    expect(svg).toContain('viewBox="-2 -2 184 54"');
    expect(svg).toContain(sampleTitleData(p).number);
    expect(svg).toContain('<image');
  });
});

describe('templates with free content: JSON, migration, sanitising', () => {
  const imp = readTitleBlockDxf(titleBlockFixtureDxf());
  const t = titleBlockTemplate(imp, 'tb1', { name: 'ACME' });

  it('round-trips through the template JSON (export / import)', () => {
    const back = parseTemplates(JSON.stringify(t))[0];
    expect(back.graphics).toEqual(t.graphics);
    expect(back.texts).toEqual(t.texts);
    expect(back.border).toBe(true);
    expect(back.imported).toEqual(t.imported);
    expect([back.width, back.height]).toEqual([180, 50]);
  });

  it('drops broken entries and keeps sizes of free templates', () => {
    const broken = parseTemplates(
      JSON.stringify({
        ...t,
        width: 20,
        graphics: [{ t: 'line', a: { x: 0, y: 0 }, b: { x: 'x', y: 1 } }, { t: 'circle', c: { x: 1, y: 1 }, r: -1 }, { t: 'bogus' }, { t: 'rect', x: 1, y: 1, w: 2, h: 2, lw: 'huge' }],
        texts: [{ x: 1, y: 1, h: -2, source: 'drawing.number', anchor: 'left' }, { y: 3 }],
        logoRect: { x: 0, y: 0, w: 0, h: 1 },
      }),
    )[0];
    expect(broken.graphics).toEqual([{ t: 'rect', x: 1, y: 1, w: 2, h: 2 }]);
    expect(broken.texts).toEqual([{ x: 1, y: 1, h: 2.5, source: 'drawing.number' }]);
    expect(broken.logoRect).toBeUndefined();
    expect(broken.width).toBe(40);
  });

  it('migrates project files: older grid templates unchanged, imported ones kept', () => {
    const p = sampleFacade();
    const grid: SheetTemplate = { id: 'g', name: 'Grid', width: 170, height: 30, grid: 5, notes: ['QP-7'], fields: [{ label: 'Project', source: 'project.name', col: 0, row: 0, w: 10, h: 3 }] };
    p.drawings.templates = [grid, t, { name: 'not a template' } as unknown as SheetTemplate];
    p.drawings.activeTemplate = 'tb1';
    const m = migrateProject(JSON.parse(JSON.stringify(p)))!;
    expect(m.drawings.templates).toHaveLength(2);
    expect(m.drawings.templates[0]).toEqual(grid);
    expect(m.drawings.templates[1].graphics).toEqual(t.graphics);
    expect(activeTemplate(m).texts).toEqual(t.texts);
    // A project without templates still gets the list.
    const q = JSON.parse(JSON.stringify(sampleFacade()));
    delete q.drawings.templates;
    expect(migrateProject(q)!.drawings.templates).toEqual([]);
  });
});

describe('assistant: title block import and field mapping', () => {
  const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runTool(name, input));
  const st = () => useStore.getState();
  beforeEach(() => st().replaceProject(sampleFacade()));

  it('imports a DXF title block, maps texts, activates it (undoable)', async () => {
    const tool = TOOLS.find((t) => t.name === 'sheet_templates')!;
    expect(JSON.stringify(tool.input_schema).length).toBeLessThanOrEqual(4096);
    expect(tool.description!.length).toBeLessThanOrEqual(1024);
    const r = await run('sheet_templates', { action: 'import_dxf', dxf: titleBlockFixtureDxf(), name: 'Client block', activate: true, map: [{ i: 0, source: '' }] });
    expect(r.units).toBe('inches');
    expect([r.width, r.height]).toEqual([180, 50]);
    expect(r.dxfTexts.find((x: { tag?: string }) => x.tag === 'DRAWN_BY').source).toBe('drawing.drawn');
    expect(r.dxfTexts[0].source).toBe('');
    expect(r.summary).toMatch(/Read .*LINE/);
    expect(st().project.drawings.activeTemplate).toBe(r.id);
    const tpl = st().project.drawings.templates.find((t) => t.id === r.id)!;
    expect(tpl.texts!.some((x) => x.source === 'text:PROJECT')).toBe(false);
    const some = tpl.texts!.findIndex((x) => x.source === 'text:Some text');
    const num = tpl.texts!.findIndex((x) => x.source === 'drawing.number');
    const m = await run('sheet_templates', { action: 'map_texts', id: r.id, map: [{ i: some, source: 'drawing.status' }, { i: num, source: '' }] });
    expect(m.texts.find((x: { source: string }) => x.source === 'drawing.status')).toBeDefined();
    expect(m.texts.some((x: { source: string }) => x.source === 'drawing.number')).toBe(false);
    await expect(runTool('sheet_templates', { action: 'map_texts', id: r.id, map: [{ i: 0, source: 'nonsense' }] })).rejects.toThrow(/Unknown source/);
    await expect(runTool('sheet_templates', { action: 'import_dxf', dxf: 'garbage' })).rejects.toThrow(/DXF/);
    st().undo();
    expect(st().project.drawings.templates.find((t) => t.id === r.id)!.texts!.some((x) => x.source === 'drawing.number')).toBe(true);
    st().undo();
    expect(st().project.drawings.templates).toHaveLength(0);
  });
});
