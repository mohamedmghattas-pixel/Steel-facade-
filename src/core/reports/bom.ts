/**
 * Material lists: parts, assemblies, profile summary and bolts, exported as CSV
 * or a small multi-sheet XLSX workbook.
 */
import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type AccessoryItem, type DerivedModel } from '../derive/model';
import { zip } from '../io/zip';

export type Row = (string | number)[];

export interface BomTables {
  parts: Row[];
  assemblies: Row[];
  profiles: Row[];
  bolts: Row[];
  /**
   * Listed-only components of composite members (gaskets in metres, packers in
   * pieces): per assembly mark, and totals per profile (the gasket list).
   * Header only when the model has none.
   */
  accessories: Row[];
  accessoryTotals: Row[];
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

  const { accessories, accessoryTotals } = accessoryTables(dm);
  return {
    parts,
    assemblies,
    profiles,
    bolts,
    accessories,
    accessoryTotals,
    totals: {
      weight: dm.parts.reduce((s, pt) => s + pt.mass, 0),
      surface: dm.parts.reduce((s, pt) => s + pt.surface, 0),
      parts: dm.parts.length,
      assemblies: dm.assemblies.length,
      bolts: dm.bolts.reduce((s, b) => s + b.positions.length, 0),
    },
  };
}

const RULE = (r: AccessoryItem['rule']) =>
  r.kind === 'percent' ? `L ${r.percent >= 0 ? '+' : ''}${r.percent} %` : r.kind === 'pieces' ? (r.at === 'nodes' ? `${r.length} mm at nodes` : `${r.length} mm @ ${r.spacing ?? 600}`) : `L ${r.start ?? 0} / ${r.end ?? 0}`;

/** Accessories per assembly mark (one row per component) and totals per profile and material. */
export function accessoryTables(dm: DerivedModel): { accessories: Row[]; accessoryTotals: Row[] } {
  const accessories: Row[] = [['Assembly', 'Assemblies', 'Item', 'Kind', 'Profile', 'Material', 'Unit', 'Qty per assembly', 'Total qty', 'Length rule', 'Total weight (kg)']];
  const accessoryTotals: Row[] = [['Profile', 'Kind', 'Material', 'Unit', 'Total qty', 'Total weight (kg)']];
  const list = dm.accessories ?? [];
  if (!list.length) return { accessories, accessoryTotals };
  const asmQty = new Map(uniqueAssemblies(dm).map((u) => [u.assembly.mark, u.qty]));
  // One instance per mark stands for every identical assembly (same signature).
  const firstMain = new Map<string, string>();
  for (const a of dm.assemblies) if (!firstMain.has(a.mark)) firstMain.set(a.mark, a.main);
  const rows = list.filter((x) => firstMain.get(x.assembly) === x.main).sort((a, b) => byNum(a.assembly, b.assembly) || a.key.localeCompare(b.key, undefined, { numeric: true }));
  for (const x of rows) {
    const n = asmQty.get(x.assembly) ?? 1;
    const q = x.unit === 'm' ? r2(x.qty) : x.qty;
    accessories.push([x.assembly, n, x.name, x.kind, x.profile, x.material, x.unit, q, x.unit === 'm' ? r2(x.qty * n) : x.qty * n, RULE(x.rule), r2(x.mass * n)]);
  }
  const tot = new Map<string, { profile: string; kind: string; material: string; unit: string; qty: number; kg: number }>();
  for (const x of list) {
    const k = `${x.profile}|${x.material}|${x.unit}`;
    const e = tot.get(k) ?? { profile: x.profile, kind: x.kind, material: x.material, unit: x.unit, qty: 0, kg: 0 };
    e.qty += x.qty;
    e.kg += x.mass;
    tot.set(k, e);
  }
  for (const e of [...tot.values()].sort((a, b) => a.kind.localeCompare(b.kind) || byNum(a.profile, b.profile))) accessoryTotals.push([e.profile, e.kind, e.material, e.unit, e.unit === 'm' ? r2(e.qty) : e.qty, r2(e.kg)]);
  return { accessories, accessoryTotals };
}

const byNum = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

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

function formSheetXml(rows: Row[], f: XlsxForm): string {
  const styles = f.styles ?? {};
  const maxRow = Math.max(rows.length, ...Object.keys(styles).map((r) => Number(r.match(/\d+/)?.[0] ?? 0)));
  const byRow = new Map<number, Map<number, { v: string | number; s?: number }>>();
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === '' || v === undefined || v === null) return;
      if (!byRow.has(r)) byRow.set(r, new Map());
      byRow.get(r)!.set(c, { v });
    }),
  );
  for (const [ref, st] of Object.entries(styles)) {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    const r = Number(m[2]) - 1;
    if (!byRow.has(r)) byRow.set(r, new Map());
    const cell = byRow.get(r)!.get(c - 1) ?? { v: '' };
    cell.s = FORM_STYLE[st];
    byRow.get(r)!.set(c - 1, cell);
  }
  let body = '';
  for (let r = 0; r < maxRow; r++) {
    const cells = byRow.get(r);
    const ht = f.heights?.[r + 1];
    if (!cells?.size && !ht) continue;
    const attrs = ht ? ` ht="${ht}" customHeight="1"` : '';
    const xs = [...(cells ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([c, { v, s }]) => {
      const ref = `${colName(c)}${r + 1}`;
      const sa = s ? ` s="${s}"` : '';
      if (v === '') return `<c r="${ref}"${sa}/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${sa}><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
    });
    body += `<row r="${r + 1}"${attrs}>${xs.join('')}</row>`;
  }
  const cols = f.cols?.length
    ? `<cols>${[...f.cols].sort((a, b) => a.col - b.col).map((c) => `<col min="${c.col}" max="${c.col}" width="${c.width}" customWidth="1"${c.hidden || c.width === 0 ? ' hidden="1"' : ''}/>`).join('')}</cols>`
    : '';
  const merges = f.merges?.length ? `<mergeCells count="${f.merges.length}">${f.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const lists = f.lists?.length
    ? `<dataValidations count="${f.lists.length}">${f.lists.map((d) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${d.sqref}"><formula1>${xmlEsc(d.formula)}</formula1></dataValidation>`).join('')}</dataValidations>`
    : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    cols +
    `<sheetData>${body}</sheetData>${merges}${lists}</worksheet>`
  );
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
  return sheetsToXlsx([
    { name: 'Summary', rows: summary },
    { name: 'Parts', rows: b.parts },
    { name: 'Assemblies', rows: b.assemblies },
    { name: 'Profiles', rows: b.profiles },
    { name: 'Bolts', rows: b.bolts },
    // Composite members only: gaskets, packers (per assembly and totals).
    ...(b.accessories.length > 1
      ? [
          { name: 'Accessories', rows: b.accessories },
          { name: 'Gasket list', rows: b.accessoryTotals },
        ]
      : []),
  ]);
}

export interface XlsxSheet {
  name: string;
  rows: Row[];
  /** Form layout (merged cells, fixed widths, styles, lists) instead of a table with a frozen header. */
  form?: XlsxForm;
}

/** Cell styles of form sheets: title (bold 14, centred), head (bold, border, centred, grey), cell (border, wrap), tick (border, centred), label (bold). */
export type FormStyle = 'title' | 'head' | 'cell' | 'tick' | 'label';
const FORM_STYLE: Record<FormStyle, number> = { title: 2, head: 3, cell: 4, tick: 5, label: 1 };

export interface XlsxForm {
  /** Ranges such as "B2:F2". */
  merges?: string[];
  /** Column widths (1-based column number); width 0 or hidden hides the column. */
  cols?: { col: number; width: number; hidden?: boolean }[];
  /** List validations: cells and the list source, e.g. { sqref: 'E11:E20', formula: '$V$2:$W$2' }. */
  lists?: { sqref: string; formula: string }[];
  /** Style per cell ("B2" → 'title'); empty cells with a style are written too (borders). */
  styles?: Record<string, FormStyle>;
  /** Row heights in points (1-based row number). */
  heights?: Record<number, number>;
}

/** Excel sheet names: ≤ 31 characters, none of []:*?/\ and unique within the workbook. */
function sheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    const base = (s.name.replace(/[[\]:*?/\\]/g, '-').trim() || `Sheet${i + 1}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)}~${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** A multi-sheet XLSX workbook; the first row of every sheet is a bold, frozen header. */
export function sheetsToXlsx(sheets: XlsxSheet[]): Uint8Array {
  const names = sheetNames(sheets);
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
        names.map((name, i) => `<sheet name="${xmlEsc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
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
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        // 0 normal, 1 bold, 2 form title, 3 form head, 4 form cell, 5 form tick
        '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.form ? formSheetXml(s.rows, s.form) : sheetXml(s.rows) })),
  ];
  return zip(files);
}

/** Alias kept for callers written against the movement/survey reports. */
export const xlsxWorkbook = (sheets: XlsxSheet[]): Uint8Array => sheetsToXlsx(sheets);
