/**
 * Material lists: parts, assemblies, profile summary and bolts, exported as CSV
 * or a small multi-sheet XLSX workbook.
 */
import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type DerivedModel } from '../derive/model';
import { zip } from '../io/zip';

export type Row = (string | number)[];

export interface BomTables {
  parts: Row[];
  assemblies: Row[];
  profiles: Row[];
  bolts: Row[];
  totals: { weight: number; surface: number; parts: number; assemblies: number; bolts: number };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const FINISH: Record<string, string> = { none: '', hdg: 'HDG', paint: 'Paint', 'hdg+paint': 'HDG + paint' };

export function buildBom(p: Project, dm: DerivedModel): BomTables {
  void p;
  const parts: Row[] = [
    ['Mark', 'Qty', 'Name', 'Profile', 'Material', 'Length (mm)', 'Unit weight (kg)', 'Total weight (kg)', 'Surface (m²)', 'Finish', 'Assembly'],
  ];
  for (const { part, qty, refs } of uniqueParts(dm)) {
    const asm = [...new Set(refs.map((r) => dm.partByRef.get(r)?.assembly ?? ''))].filter(Boolean).join(', ');
    const length = part.kind === 'plate' ? `${Math.round(part.length)} x ${Math.round(part.width)}` : Math.round(part.length);
    parts.push([
      part.mark,
      qty,
      part.name,
      part.profile,
      part.material,
      length,
      r2(part.mass),
      r2(part.mass * qty),
      r2(part.surface * qty),
      FINISH[part.finish] ?? part.finish,
      asm,
    ]);
  }

  const assemblies: Row[] = [['Mark', 'Qty', 'Main profile', 'Length (mm)', 'Weight each (kg)', 'Total weight (kg)']];
  for (const { assembly, qty } of uniqueAssemblies(dm)) {
    const main = dm.partByRef.get(assembly.main)!;
    const length = main.kind === 'plate' ? `${Math.round(main.length)} x ${Math.round(main.width)}` : Math.round(main.length);
    assemblies.push([assembly.mark, qty, main.profile, length, r2(assembly.mass), r2(assembly.mass * qty)]);
  }

  const groups = new Map<string, { profile: string; material: string; pieces: number; length: number; weight: number; plate: boolean }>();
  for (const pt of dm.parts) {
    const key = `${pt.profile}|${pt.material}`;
    const g = groups.get(key) ?? { profile: pt.profile, material: pt.material, pieces: 0, length: 0, weight: 0, plate: pt.kind === 'plate' };
    g.pieces++;
    g.length += pt.kind === 'plate' ? 0 : pt.length;
    g.weight += pt.mass;
    groups.set(key, g);
  }
  const profiles: Row[] = [['Profile', 'Material', 'Pieces', 'Total length (m)', 'Total weight (kg)']];
  for (const g of [...groups.values()].sort((a, b) => Number(a.plate) - Number(b.plate) || a.profile.localeCompare(b.profile, undefined, { numeric: true }))) {
    profiles.push([g.profile, g.material, g.pieces, g.plate ? '' : r2(g.length / 1000), r1(g.weight)]);
  }

  const bmap = new Map<string, { size: string; grade: string; kind: string; length: number; qty: number }>();
  for (const b of dm.bolts) {
    const key = `${b.size}|${b.grade}|${b.kind}|${b.length}`;
    const e = bmap.get(key) ?? { size: b.size, grade: b.grade, kind: b.kind, length: b.length, qty: 0 };
    e.qty += b.positions.length;
    bmap.set(key, e);
  }
  const bolts: Row[] = [['Size', 'Grade', 'Type', 'Length (mm)', 'Qty']];
  for (const b of [...bmap.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.length - b.length)) {
    bolts.push([b.size, b.grade, b.kind === 'anchor' ? 'Anchor' : 'Bolt + nut + 2 washers', b.length, b.qty]);
  }

  return {
    parts,
    assemblies,
    profiles,
    bolts,
    totals: {
      weight: dm.parts.reduce((s, pt) => s + pt.mass, 0),
      surface: dm.parts.reduce((s, pt) => s + pt.surface, 0),
      parts: dm.parts.length,
      assemblies: dm.assemblies.length,
      bolts: dm.bolts.reduce((s, b) => s + b.positions.length, 0),
    },
  };
}

/** RFC 4180 CSV. */
export function toCsv(rows: Row[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// XLSX

const xmlEsc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip characters that are illegal in XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows: Row[], boldFirst = true): string {
  const widths = rows[0]?.map((_, c) => Math.min(60, Math.max(8, ...rows.map((r) => String(r[c] ?? '').length + 2)))) ?? [];
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${colName(c)}${r + 1}`;
          const s = r === 0 && boldFirst ? ' s="1"' : '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (boldFirst ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '') +
    cols +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

export function bomToXlsx(b: BomTables, p: Project): Uint8Array {
  const summary: Row[] = [
    ['Item', 'Value'],
    ['Project', p.info.name],
    ['Project no.', p.info.number],
    ['Client', p.info.client],
    ['Designer', p.info.designer],
    ['Date', new Date().toISOString().slice(0, 10)],
    ['Total steel weight (kg)', r1(b.totals.weight)],
    ['Total surface (m²)', r2(b.totals.surface)],
    ['Parts', b.totals.parts],
    ['Assemblies', b.totals.assemblies],
    ['Bolts and anchors', b.totals.bolts],
  ];
  const sheets: { name: string; rows: Row[] }[] = [
    { name: 'Summary', rows: summary },
    { name: 'Parts', rows: b.parts },
    { name: 'Assemblies', rows: b.assemblies },
    { name: 'Profiles', rows: b.profiles },
    { name: 'Bolts', rows: b.bolts },
  ];
  const ns = 'http://schemas.openxmlformats.org';
  const files: { name: string; data: string }[] = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Types xmlns="${ns}/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Relationships xmlns="${ns}/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>` +
        sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<Relationships xmlns="${ns}/package/2006/relationships">` +
        sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<styleSheet xmlns="${ns}/spreadsheetml/2006/main">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  return zip(files);
}
