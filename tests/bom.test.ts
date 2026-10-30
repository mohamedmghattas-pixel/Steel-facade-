import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import { bomToXlsx, buildBom, colName, toCsv } from '../src/core/reports/bom';
import { sampleFacade } from './helpers';
import { unzipNames } from './unzip';

describe('material list', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const bom = buildBom(p, dm);

  it('totals match the derived parts', () => {
    const sum = dm.parts.reduce((s, pt) => s + pt.mass, 0);
    expect(bom.totals.weight).toBeCloseTo(sum, 6);
    expect(bom.totals.parts).toBe(dm.parts.length);
    const qty = bom.parts.slice(1).reduce((s, r) => s + (r[1] as number), 0);
    expect(qty).toBe(dm.parts.length);
    const tableWeight = bom.parts.slice(1).reduce((s, r) => s + (r[7] as number), 0);
    expect(Math.abs(tableWeight - sum)).toBeLessThan(0.5);
    const bolts = bom.bolts.slice(1).reduce((s, r) => s + (r[4] as number), 0);
    expect(bolts).toBe(bom.totals.bolts);
    expect(bom.assemblies[0][0]).toBe('Mark');
    expect(bom.profiles.length).toBeGreaterThan(2);
  });

  it('quotes CSV fields', () => {
    const csv = toCsv([
      ['a', 'b,c', 'say "hi"'],
      [1, 2.5, 'line\nbreak'],
    ]);
    expect(csv).toBe('a,"b,c","say ""hi"""\r\n1,2.5,"line\nbreak"\r\n');
  });

  it('writes a valid XLSX package', () => {
    const bytes = bomToXlsx(bom, p);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
    const names = unzipNames(bytes).map((f) => f.name);
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      expect(names).toContain(n);
    }
    const sheet2 = new TextDecoder().decode(unzipNames(bytes).find((f) => f.name === 'xl/worksheets/sheet2.xml')!.data);
    expect(sheet2).toContain('<sheetData>');
    expect(sheet2).toContain('Mark');
  });

  it('names spreadsheet columns', () => {
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
  });
});
