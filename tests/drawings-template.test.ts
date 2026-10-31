import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import {
  DEFAULT_TEMPLATE,
  activeTemplate,
  allDrawings,
  drawTemplateTitleBlock,
  drawingToDxf,
  drawingToSvg,
  gaDrawing,
  newTemplate,
  parseTemplates,
  sampleTitleData,
  type DEnt,
} from '../src/core/drawings';
import { Sheet } from '../src/core/drawings/dims';
import { frameRect, projectionSymbol } from '../src/core/drawings/layout';
import { TEXT } from '../src/core/drawings/standards';
import type { Project, SheetSize } from '../src/core/model/types';
import type { TitleData } from '../src/core/drawings/template';
import { sampleFacade } from './helpers';

/**
 * The ISO 7200 title block as drawn before sheet templates existed (verbatim
 * copy of the original layout.ts drawTitleBlock): the reference the default
 * template must reproduce.
 */
function legacyTitleBlock(s: Sheet, size: SheetSize, p: Project, d: TitleData, projection: 'first' | 'third') {
  const TB_W = 180;
  const TB_H = 40;
  const f = frameRect(size);
  const x0 = f.x1 - TB_W;
  const y0 = f.y0;
  s.rect(x0, y0, TB_W, TB_H, 'border');
  const hl = (y: number) => s.line({ x: x0, y: y0 + y }, { x: x0 + TB_W, y: y0 + y }, 'medium');
  const vl = (x: number, ya: number, yb: number) => s.line({ x: x0 + x, y: y0 + ya }, { x: x0 + x, y: y0 + yb }, 'medium');
  hl(10);
  hl(24);
  hl(32);
  vl(45, 0, 10);
  vl(120, 0, 10);
  vl(136, 0, 10);
  vl(160, 0, 10);
  vl(45, 10, 24);
  vl(30, 24, 32);
  vl(60, 24, 32);
  vl(90, 24, 32);
  vl(135, 24, 32);
  vl(95, 32, 40);
  vl(130, 32, 40);
  const lbl = (x: number, y: number, t: string) => s.text({ x: x0 + x + 0.8, y: y0 + y - 2.4 }, t, TEXT.label, 'start', 'text');
  const val = (x: number, y: number, t: string, h: number, w: number, bold = false) => {
    const max = Math.max(3, Math.floor((w - 2) / (h * 0.72)));
    s.text({ x: x0 + x + 1, y: y0 + y + 1.2 }, t.length > max ? `${t.slice(0, max - 1)}…` : t, h, 'start', 'text', 0, bold);
  };
  lbl(0, 10, 'Legal owner');
  val(0, 0, p.drawings.settings.legalOwner || p.info.client || '—', TEXT.small, 45);
  lbl(45, 10, 'Identification number');
  val(45, 0, d.number, TEXT.title, 75, true);
  lbl(120, 10, 'Rev');
  val(120, 0, d.rev, TEXT.title, 16, true);
  lbl(136, 10, 'Date of issue');
  val(136, 0, d.date, TEXT.small, 24);
  lbl(160, 10, 'Sheet');
  val(160, 0, d.sheetNo, TEXT.small, 20);
  projectionSymbol(s, x0 + 3, y0 + 14.5, projection);
  s.text({ x: x0 + 24, y: y0 + 16 }, `Scale ${d.scale}`, TEXT.small, 'start');
  s.text({ x: x0 + 24, y: y0 + 12 }, projection === 'first' ? 'ISO-E' : 'ISO-A', TEXT.label, 'start');
  lbl(45, 24, 'Title');
  val(45, 16.5, d.title, TEXT.normal, 135, true);
  val(45, 11.2, d.subtitle, TEXT.small, 135);
  lbl(0, 32, 'Created by');
  val(0, 24, d.createdBy || '—', TEXT.small, 30);
  lbl(30, 32, 'Checked by');
  val(30, 24, d.checkedBy || '—', TEXT.small, 30);
  lbl(60, 32, 'Approved by');
  val(60, 24, d.approvedBy || '—', TEXT.small, 30);
  lbl(90, 32, 'Document type');
  val(90, 24, d.docType, TEXT.small, 45);
  lbl(135, 32, 'Document status');
  val(135, 24, d.status, TEXT.small, 45);
  lbl(0, 40, 'Project');
  val(0, 32, p.info.name || '—', TEXT.small, 95);
  lbl(95, 40, 'Project no.');
  val(95, 32, p.info.number || '—', TEXT.small, 35);
  lbl(130, 40, 'Client');
  val(130, 32, p.info.client || '—', TEXT.small, 50);
}

/** Entity as a canonical string (coordinates to 1e-6 mm). */
const key = (e: DEnt) => {
  const r = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
  switch (e.t) {
    case 'line':
      return `l ${e.layer} ${r(e.a.x)},${r(e.a.y)} ${r(e.b.x)},${r(e.b.y)}`;
    case 'circle':
      return `c ${e.layer} ${r(e.c.x)},${r(e.c.y)} ${r(e.r)} ${!!e.fill}`;
    case 'poly':
      return `p ${e.layer} ${e.closed} ${!!e.fill} ${e.pts.map((q) => `${r(q.x)},${r(q.y)}`).join(' ')}`;
    case 'text':
      return `t ${e.layer} ${r(e.p.x)},${r(e.p.y)} ${e.h} ${e.anchor} ${e.rot ?? 0} ${!!e.bold} ${e.text}`;
    case 'image':
      return `i ${r(e.p.x)},${r(e.p.y)} ${r(e.w)}x${r(e.h)}`;
  }
};

describe('sheet templates', () => {
  it('the default template reproduces the ISO 7200 title block exactly', () => {
    for (const variant of [0, 1, 2]) {
      const p = sampleFacade();
      if (variant === 1) {
        p.info = { name: '', number: '', client: '', designer: '' };
      } else if (variant === 2) {
        p.drawings.settings.legalOwner = 'Owner Ltd';
        p.info.name = 'A very long project name that certainly does not fit into the project field of the block';
      }
      const d: TitleData = { ...sampleTitleData(p), createdBy: variant === 1 ? '' : 'MG', title: 'Assembly M1 – a title long enough to be shortened in the title block field', subtitle: variant === 1 ? '' : 'sub' };
      for (const proj of ['first', 'third'] as const)
        for (const size of ['A3', 'A1'] as const) {
          const a = new Sheet(0, 0);
          legacyTitleBlock(a, size, p, d, proj);
          const b = new Sheet(0, 0);
          drawTemplateTitleBlock(b, size, p, DEFAULT_TEMPLATE, d, proj);
          expect(b.ents.map(key), `${variant} ${proj} ${size}`).toEqual(a.ents.map(key));
        }
    }
  });

  it('keeps the drawing content of every sheet unchanged with the default template', () => {
    const p = sampleFacade();
    const dm = deriveModel(p);
    const before = allDrawings(p, dm);
    const q = structuredClone(p);
    q.drawings.templates.push(newTemplate('t1', 'Copy of default'));
    q.drawings.activeTemplate = 't1';
    const after = allDrawings(q, deriveModel(q));
    expect(after.map((d) => d.fingerprint)).toEqual(before.map((d) => d.fingerprint));
    expect(after.map((d) => d.entities.length)).toEqual(before.map((d) => d.entities.length));
  });

  it('resolves custom fields, fixed text, logo and fixed notes', () => {
    const p = sampleFacade();
    p.info.name = 'Tower B';
    const logo = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIi8+PC9zdmc+';
    p.drawings.templates.push({
      id: 'acme',
      name: 'ACME',
      width: 170,
      height: 30,
      grid: 5,
      logo,
      notes: ['ACME quality plan QP-7 applies.'],
      fields: [
        { label: '', source: 'logo', col: 0, row: 0, w: 8, h: 6 },
        { label: 'Company', source: 'text:ACME Facades Ltd', col: 8, row: 3, w: 14, h: 3 },
        { label: 'Project', source: 'project.name', col: 8, row: 0, w: 14, h: 3 },
        { label: 'Drawing no.', source: 'drawing.number', col: 22, row: 0, w: 12, h: 3, textH: 3.5, bold: true },
        { label: 'Scale', source: 'drawing.scale', col: 22, row: 3, w: 6, h: 3 },
        { label: 'Rev', source: 'drawing.rev', col: 28, row: 3, w: 6, h: 3 },
      ],
    });
    p.drawings.activeTemplate = 'acme';
    expect(activeTemplate(p).name).toBe('ACME');
    const dm = deriveModel(p);
    const d = gaDrawing(p, dm, 'front');
    const texts = d.entities.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toContain('ACME Facades Ltd');
    expect(texts).toContain('Tower B');
    expect(texts).toContain(d.number);
    expect(texts).toContain(d.scale);
    expect(texts).toContain('Company');
    expect(texts.some((t) => t.includes('QP-7'))).toBe(true);
    // Border of the 170 × 30 block at the bottom right of the frame.
    const f = frameRect('A3');
    expect(d.entities.some((e) => e.t === 'poly' && e.layer === 'border' && e.pts.length === 4 && Math.abs(e.pts[0].x - (f.x1 - 170)) < 1e-6 && Math.abs(e.pts[2].y - (f.y0 + 30)) < 1e-6)).toBe(true);
    const img = d.entities.find((e) => e.t === 'image');
    expect(img).toBeDefined();
    expect(drawingToSvg(d)).toContain('<image');
    expect(drawingToDxf(d)).not.toContain('data:image');
  });

  it('imports and exports templates as JSON', () => {
    const t = newTemplate('x', 'Mine');
    const back = parseTemplates(JSON.stringify(t));
    expect(back[0].fields).toEqual(t.fields);
    expect(back[0].width).toBe(180);
    expect(parseTemplates(JSON.stringify([t, { ...t, id: 'y' }]))).toHaveLength(2);
    expect(() => parseTemplates('{"name":"no fields"}')).toThrow(/fields/);
    expect(() => parseTemplates('not json')).toThrow(/JSON/);
    // Out-of-range sizes are clamped; foreign logos are dropped.
    const odd = parseTemplates(JSON.stringify({ ...t, width: 5000, logo: 'http://example.com/x.png' }))[0];
    expect(odd.width).toBeLessThanOrEqual(400);
    expect(odd.logo).toBeUndefined();
  });
});
