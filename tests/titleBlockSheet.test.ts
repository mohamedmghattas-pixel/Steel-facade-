/**
 * A company title block taken out of a whole drawing sheet (DXF exported from a
 * detailing package): the title block block is found among the frame, views and
 * tables; it is a strip that spans the frame width on every sheet; its logo comes
 * from an embedded OLE picture; its own revision table takes the revisions; values
 * beside labels become fields (and project data); the layout keeps above the strip.
 * Plus the bitmap reader / PNG writer behind the logo. Synthetic fixtures only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '../src/assistant/tools';
import { useStore } from '../src/state/store';
import { deriveModel } from '../src/core/derive/model';
import {
  allDrawings,
  applyFoundValues,
  checkSheetLayout,
  drawTitleBlockAt,
  drawingToSvg,
  foundProjectValues,
  issueDrawings,
  readTitleBlockDxf,
  sampleTitleData,
  sanitizeTemplate,
  sheetFurniture,
  templateBox,
  titleBlockTemplate,
  type DEnt,
  type Drawing,
} from '../src/core/drawings';
import { Sheet } from '../src/core/drawings/dims';
import { frameRect } from '../src/core/drawings/layout';
import { base64, decodeBmp, encodePng, olePicture, pngSize } from '../src/core/io/bitmap';
import type { Project, SheetSize, SheetTemplate } from '../src/core/model/types';
import { sampleFacade } from './helpers';
import { sheetTitleBlockDxf } from './titleBlockFixture';

const textsOf = (d: { entities: DEnt[] } | { ents: DEnt[] }) => ('entities' in d ? d.entities : d.ents).filter((e): e is Extract<DEnt, { t: 'text' }> => e.t === 'text');
const shown = (d: { entities: DEnt[] }) => textsOf(d).map((e) => e.text);
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

function withTemplate(p: Project, t: SheetTemplate): Project {
  p.drawings.templates.push(t);
  p.drawings.activeTemplate = t.id;
  return p;
}

describe('bitmaps: BMP in, PNG out', () => {
  const bmp = (bpp: 8 | 24 | 32, topDown = false) => {
    const w = 3;
    const h = 2;
    const stride = Math.ceil((w * bpp) / 32) * 4;
    const pal = bpp === 8 ? 256 * 4 : 0;
    const off = 54 + pal;
    const b = new Uint8Array(off + stride * h);
    const v = new DataView(b.buffer);
    b[0] = 0x42;
    b[1] = 0x4d;
    v.setUint32(2, b.length, true);
    v.setUint32(10, off, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, w, true);
    v.setInt32(22, topDown ? -h : h, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, bpp, true);
    // Pixels (top row first): red, green, blue / white, black, grey.
    const rows = [
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      [
        [255, 255, 255],
        [0, 0, 0],
        [128, 128, 128],
      ],
    ];
    if (bpp === 8) {
      const colours = rows.flat();
      colours.forEach(([r, g, bl], i) => b.set([bl, g, r, 0], 54 + i * 4));
      rows.forEach((row, y) => row.forEach((_, x) => (b[off + (topDown ? y : h - 1 - y) * stride + x] = y * 3 + x)));
    } else
      rows.forEach((row, y) =>
        row.forEach(([r, g, bl], x) => {
          const k = off + (topDown ? y : h - 1 - y) * stride + x * (bpp / 8);
          b.set([bl, g, r], k);
        }),
      );
    return b;
  };
  const expectPixels = (d: Uint8Array) =>
    expect(Array.from(d)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
  it('decodes 8-bit palette, 24-bit and 32-bit bitmaps, bottom-up and top-down, to RGBA rows top first', () => {
    for (const bpp of [8, 24, 32] as const)
      for (const td of [false, true]) {
        const bm = decodeBmp(bmp(bpp, td))!;
        expect(bm.width).toBe(3);
        expect(bm.height).toBe(2);
        expectPixels(bm.data);
      }
  });
  it('rejects what is not a bitmap', () => {
    const b = bmp(24);
    b[14] = 77; // header size
    expect(decodeBmp(b)).toBeNull();
    expect(decodeBmp(new Uint8Array([0x42, 0x4d, 1, 2, 3]))).toBeNull();
  });
  it('writes a valid PNG (signature, IHDR size, compressed) and base64', () => {
    const png = encodePng({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(255) });
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(png)).toEqual({ width: 200, height: 100 });
    // 80 kB of white compresses to a few hundred bytes.
    expect(png.length).toBeLessThan(1000);
    expect(base64(new Uint8Array([77, 97, 110]))).toBe('TWFu');
    expect(base64(new Uint8Array([77, 97]))).toBe('TWE=');
    expect(base64(new Uint8Array([77]))).toBe('TQ==');
  });
  it('finds the picture inside an OLE object, after other bytes', () => {
    const junk = new Uint8Array([0x42, 0x4d, 0, 0, 0x42, 9, 9, 0xd0, 0xcf, 0x11, 0xe0]);
    const b = bmp(24);
    const all = new Uint8Array(junk.length + b.length + 8);
    all.set(junk);
    all.set(b, junk.length);
    const pic = olePicture(all)!;
    expect(pic.width).toBe(3);
    expect(pic.height).toBe(2);
    expect(pic.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(olePicture(junk)).toBeNull();
  });
});

describe('a whole drawing sheet: the title block found in it', () => {
  const text = sheetTitleBlockDxf();
  const imp = readTitleBlockDxf(text);
  const valueOf = (s: string) => imp.texts.find((t) => t.lines.some((l) => l.text === s));
  it('takes the block with the title-block labels, not the frame, views or part list', () => {
    expect(imp.regions[0].label).toBe('COMPANY_TB');
    expect(imp.region?.id).toBe(imp.regions[0].id);
    expect(imp.width).toBeCloseTo(790, 3);
    expect(imp.height).toBeCloseTo(80, 3);
    const all = imp.texts.map((t) => t.lines.map((l) => l.text).join(' '));
    expect(all).toContain('JOB NAME:');
    for (const outside of ['FRONT VIEW', '5596', 'MARK', 'L09-X', 'CAD system']) expect(all).not.toContain(outside);
    // A strip across the sheet: it spans the frame width.
    expect(imp.span).toBe(true);
    // The overview is the whole sheet (the frame's vertical note runs a little left of it).
    expect(imp.overview!.width).toBeGreaterThan(795);
    expect(imp.overview!.height).toBeGreaterThanOrEqual(560);
    expect(imp.notes.join(' ')).toMatch(/whole drawing sheet/);
  });
  it('maps the values beside their labels, and adds the sheet number where the cell is empty', () => {
    expect(valueOf('Demo Tower')?.suggested).toBe('project.name');
    expect(valueOf('Demo Tower')?.label).toBe('JOB NAME:');
    expect(valueOf('P-100')?.suggested).toBe('project.number');
    expect(valueOf('J.D')?.suggested).toBe('drawing.drawn');
    expect(valueOf('BRACKET')?.suggested).toBe('drawing.title');
    expect(valueOf('0')?.suggested).toBe('drawing.rev');
    expect(valueOf('M1')?.suggested).toBe('drawing.mark');
    // Labels stay fixed text.
    expect(valueOf('JOB NAME:')?.suggested).toBe('text:');
    const added = imp.texts.filter((t) => t.added);
    expect(added).toHaveLength(1);
    expect(added[0].suggested).toBe('drawing.sheet');
    expect(added[0].label).toBe('SHEET');
    // In the SHEET cell (680–740), below the label.
    expect(added[0].lines[0].x).toBeCloseTo(710 - 10, 3);
    expect(added[0].lines[0].y).toBeGreaterThan(40);
    expect(added[0].lines[0].y).toBeLessThan(70);
    expect(imp.found).toMatchObject({ 'project.name': 'Demo Tower', 'project.number': 'P-100', 'drawing.drawn': 'J.D', 'drawing.title': 'BRACKET', 'drawing.mark': 'M1' });
  });
  it('finds the revision table: header at the bottom, rows above it to the top of the block', () => {
    const rt = imp.revTable!;
    expect(rt.cols.map((c) => c.key)).toEqual(['rev', 'description', 'date']);
    expect(rt.cols[0].x0).toBeCloseTo(140, 3);
    expect(rt.cols[2].x1).toBeCloseTo(320, 3);
    expect(rt.rows.map((r) => [r.y0, r.y1])).toEqual([
      [12, 24],
      [24, 36],
      [36, 48],
      [48, 60],
      [60, 80],
    ]);
    expect(rt.h).toBe(4);
    // Header texts are not taken as labels (DATE is not the date of issue here).
    expect(valueOf('DATE')?.suggested).toBe('text:');
    expect(imp.texts.some((t) => t.added && t.suggested === 'drawing.date')).toBe(false);
  });
  it('takes the logo from the embedded picture, fitted into its cell', () => {
    expect(imp.logo?.startsWith('data:image/png;base64,')).toBe(true);
    expect(imp.logoPx).toEqual({ w: 4, h: 2 });
    const r = imp.logoRect!;
    // The frame (20–140 × 10–90) clipped to the logo cell (10–150 × 0–80, inset).
    expect(r.x).toBeCloseTo(10, 3);
    expect(r.y).toBeCloseTo(10, 3);
    expect(r.x + r.w).toBeCloseTo(130, 3);
    expect(r.y + r.h).toBeLessThanOrEqual(80);
    expect(r.y + r.h).toBeGreaterThan(75);
  });
  it('reads another block, the whole drawing or a picked area on request', () => {
    const part = imp.regions.find((r) => r.label === 'PART_LIST')!;
    const pl = readTitleBlockDxf(text, { region: part.id });
    expect(pl.texts.map((t) => t.lines[0].text)).toEqual(expect.arrayContaining(['MARK', 'L09-X']));
    expect(pl.logo).toBeUndefined();
    const all = readTitleBlockDxf(text, { region: 'all' });
    expect(all.region).toBeUndefined();
    expect(all.width).toBeGreaterThan(790);
    expect(all.height).toBeGreaterThan(550);
    // An area around the right end of the strip (overview coordinates).
    const R = imp.region!;
    const area = readTitleBlockDxf(text, { region: { x0: R.x0 + 539, y0: R.y0 - 1, x1: R.x1 + 1, y1: R.y1 + 1 } });
    expect(area.width).toBeCloseTo(250, 3);
    expect(area.texts.map((t) => t.lines[0].text)).toEqual(expect.arrayContaining(['DRAWN BY:', 'J.D', 'PART NO.']));
    expect(area.texts.map((t) => t.lines[0].text)).not.toContain('JOB NAME:');
    expect(() => readTitleBlockDxf(text, { region: { x0: -500, y0: -500, x1: -400, y1: -400 } })).toThrow(/Nothing of the drawing/);
  });
});

describe('a full-width title block on the sheets', () => {
  const imp = readTitleBlockDxf(sheetTitleBlockDxf());
  const tpl = titleBlockTemplate(imp, 'tpl-strip', { name: 'Company strip', file: 'sheet.dxf' });
  let p: Project;
  let ds: Drawing[];
  beforeEach(() => {
    p = withTemplate(sampleFacade(), structuredClone(tpl));
    ds = allDrawings(p, deriveModel(p));
  });
  it('makes a strip template with the logo, its revision rows and every value field', () => {
    expect(tpl.span).toBe('width');
    expect(tpl.width).toBeCloseTo(790, 3);
    expect(tpl.logo).toBe(imp.logo);
    expect(tpl.logoRect).toEqual(imp.logoRect);
    expect(tpl.revTable?.rows).toHaveLength(5);
    const src = new Set((tpl.texts ?? []).map((t) => t.source));
    for (const s of ['project.name', 'project.number', 'drawing.drawn', 'drawing.title', 'drawing.rev', 'drawing.mark', 'drawing.sheet']) expect(src.has(s)).toBe(true);
    // Survives the sanitiser (larger than a corner block) and the JSON round trip.
    const back = sanitizeTemplate(JSON.parse(JSON.stringify(tpl)));
    expect(back.span).toBe('width');
    expect(back.width).toBeCloseTo(790, 3);
    expect(back.revTable).toEqual(tpl.revTable);
    // Without span the same block is held to the corner limits.
    expect(sanitizeTemplate({ ...tpl, span: undefined }).width).toBe(380);
  });
  it('spans the frame width on every sheet size, at most a quarter of the frame height', () => {
    for (const size of ['A4', 'A3', 'A2', 'A1', 'A0'] as SheetSize[]) {
      const f = frameRect(size);
      const box = templateBox(tpl, size);
      expect(box.w).toBeCloseTo(f.x1 - f.x0, 6);
      expect(box.h).toBeCloseTo(((f.x1 - f.x0) / 790) * 80, 6);
      expect(box.h).toBeLessThanOrEqual((f.y1 - f.y0) * 0.25 + 1e-9);
      const fur = sheetFurniture(tpl, size);
      expect(fur.floor).toBeCloseTo(box.h, 6);
      expect(fur.rev).toBe(0);
      expect(fur.w).toBe(180);
    }
  });
  it('draws it across the bottom of every sheet, with the views and tables above it and no separate revision table', () => {
    expect(ds.length).toBeGreaterThan(10);
    for (const d of ds) {
      const f = frameRect(d.sheetSize);
      const floor = sheetFurniture(tpl, d.sheetSize).floor;
      expect(d.regions?.titleBlock).toEqual({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y0 + floor });
      expect(checkSheetLayout(d)).toEqual([]);
      const t = shown(d);
      expect(t).toContain('JOB NAME:');
      expect(t).not.toContain('Description');
    }
  });
  it('fills the values per sheet: project, mark, title, sheet n/N', () => {
    p.info.name = 'Speed Tower';
    p.info.number = '26P999';
    ds = allDrawings(p, deriveModel(p));
    const part = ds.find((d) => d.kind === 'part')!;
    const t = shown(part);
    expect(t).toContain('Speed Tower');
    expect(t).toContain('26P999');
    expect(t).toContain(part.mark);
    expect(t).toContain('1/1');
    expect(t).not.toContain('Demo Tower');
    const ga = ds.find((d) => d.kind === 'ga')!;
    // General sheets have no mark: the mark field stays empty.
    expect(shown(ga)).not.toContain(part.mark);
  });
  it('writes the revisions into the rows of the block, oldest next to the header', () => {
    const part = ds.find((d) => d.kind === 'part')!;
    issueDrawings(p, [{ id: part.id, fingerprint: 'x' }], { date: '2026-11-01', description: 'For approval', drawn: 'J.D', checked: 'K.S', approved: '', status: 'In approval' });
    issueDrawings(p, [{ id: part.id, fingerprint: 'y' }], { date: '2026-11-03', description: 'For construction', drawn: 'J.D', checked: 'K.S', approved: 'K.S', status: 'Released' });
    const again = allDrawings(p, deriveModel(p)).find((d) => d.id === part.id)!;
    const t = textsOf(again);
    const first = t.find((e) => e.text === 'For approval')!;
    const second = t.find((e) => e.text === 'For construction')!;
    expect(first).toBeDefined();
    expect(second.p.y).toBeGreaterThan(first.p.y);
    expect(t.some((e) => e.text === '2026-11-03')).toBe(true);
    expect(shown(again)).not.toContain('Description');
  });
  it('renders to SVG with the logo image', () => {
    const svg = drawingToSvg(ds.find((d) => d.kind === 'assembly')!);
    expect(svg).toContain('data:image/png;base64,');
  });
});

describe('project data from the title block', () => {
  it('lists the project values found and writes them into the project', () => {
    const imp = readTitleBlockDxf(sheetTitleBlockDxf());
    const p = sampleFacade();
    p.info.designer = 'A.B';
    const vals = foundProjectValues(imp, p);
    expect(vals.map((v) => v.source)).toEqual(['project.name', 'project.number', 'drawing.drawn']);
    expect(vals.find((v) => v.source === 'drawing.drawn')?.current).toBe('A.B');
    applyFoundValues(p, imp);
    expect(p.info.name).toBe('Demo Tower');
    expect(p.info.number).toBe('P-100');
    expect(p.info.designer).toBe('J.D');
  });
  it('assistant: imports a whole sheet, activates the strip and copies the project data (undoable)', async () => {
    useStore.getState().replaceProject(sampleFacade());
    const r = JSON.parse(await runTool('sheet_templates', { action: 'import_dxf', dxf: sheetTitleBlockDxf(), name: 'Company', activate: true, copyProjectData: true }));
    expect(r.span).toBe(true);
    expect(r.revisionRows).toBe(5);
    expect(r.logo).toBe(true);
    const p = useStore.getState().project;
    expect(p.info.name).toBe('Demo Tower');
    expect(p.drawings.activeTemplate).toBe(r.id);
    useStore.getState().undo();
    expect(useStore.getState().project.info.name).not.toBe('Demo Tower');
  });
});

it('shrinks a long value before it is shortened', () => {
  const imp = readTitleBlockDxf(sheetTitleBlockDxf());
  const tpl = titleBlockTemplate(imp, 't', { name: 'x' });
  const p = sampleFacade();
  const title = tpl.texts!.find((t) => t.source === 'drawing.title')!;
  expect(title.maxW).toBeGreaterThan(0);
  const draw = (v: string) => {
    const s = new Sheet(0, 0);
    drawTitleBlockAt(s, 0, 0, p, tpl, { ...sampleTitleData(p), title: v }, 'first');
    return textsOf(s).find((e) => near(e.p.x, title.x) && near(e.p.y, title.y))!;
  };
  // Fits: as drawn.
  expect(draw('BRACKET').h).toBe(title.h);
  // A little too long: smaller lettering, the whole text.
  const cap = title.maxW! / (title.h * 0.72);
  const longer = 'X'.repeat(Math.floor(cap * 1.2));
  const e = draw(longer);
  expect(e.text).toBe(longer);
  expect(e.h).toBeLessThan(title.h);
  // Far too long: 70 % and shortened with "…".
  const e2 = draw('Y'.repeat(Math.floor(cap * 3)));
  expect(e2.h).toBeCloseTo(title.h * 0.7, 6);
  expect(e2.text.endsWith('…')).toBe(true);
});
