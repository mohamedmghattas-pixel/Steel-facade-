/**
 * Fill a user's XLSX template: write values into given cells of one sheet and
 * leave every other part of the workbook (styles, images, merged cells, data
 * validations, conditional formats, form controls, other sheets) untouched.
 * Only the sheet's XML is rewritten, and in it only the target cells.
 */
import { deflateRaw, entryText, readZip, rewriteZip, type ZipEntry } from './zipRead';

export type CellValue = string | number | null;

const xmlEsc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const xmlUnesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** "AB12" → { col: 28, row: 12 } (1-based). */
export function parseRef(ref: string): { col: number; row: number } {
  const m = ref.toUpperCase().match(/^([A-Z]{1,3})(\d+)$/);
  if (!m) throw new Error(`Not a cell reference: "${ref}".`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

const cellXml = (ref: string, style: string, v: CellValue) => {
  if (v === null || v === '') return `<c r="${ref}"${style}/>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
};

const CELL_RE = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;

/** Write values into cells of a worksheet XML (existing styles kept; missing rows / cells inserted in order). */
export function patchSheetXml(xml: string, cells: Record<string, CellValue>): string {
  if (!/<sheetData[\s>/]/.test(xml)) throw new Error('Unsupported worksheet XML (no <sheetData>; namespace prefixes are not supported).');
  let out = xml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  for (const [rawRef, value] of Object.entries(cells)) {
    const ref = rawRef.toUpperCase();
    const { col, row } = parseRef(ref);
    const rowRe = new RegExp(`<row\\b[^>]*?\\br="${row}"[^>]*?(\\/>|>)`);
    const rm = rowRe.exec(out);
    if (!rm) {
      // New row, before the first row with a larger number.
      const rows = [...out.matchAll(/<row\b[^>]*?\br="(\d+)"/g)];
      const after = rows.find((x) => Number(x[1]) > row);
      const ins = `<row r="${row}">${cellXml(ref, '', value)}</row>`;
      const at = after ? (after.index ?? 0) : out.indexOf('</sheetData>');
      out = out.slice(0, at) + ins + out.slice(at);
      continue;
    }
    const rowStart = rm.index;
    if (rm[1] === '/>') {
      const open = rm[0].slice(0, -2) + '>';
      out = out.slice(0, rowStart) + open + cellXml(ref, '', value) + '</row>' + out.slice(rowStart + rm[0].length);
      continue;
    }
    const bodyStart = rowStart + rm[0].length;
    const bodyEnd = out.indexOf('</row>', bodyStart);
    const body = out.slice(bodyStart, bodyEnd);
    let next = '';
    let done = false;
    let last = 0;
    for (const cm of body.matchAll(CELL_RE)) {
      const r = cm[0].match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!r) continue;
      const c = parseRef(r).col;
      if (!done && r === ref) {
        const style = cm[0].match(/\bs="\d+"/)?.[0];
        next += body.slice(last, cm.index) + cellXml(ref, style ? ` ${style}` : '', value);
        last = (cm.index ?? 0) + cm[0].length;
        done = true;
      } else if (!done && c > col) {
        next += body.slice(last, cm.index) + cellXml(ref, '', value);
        last = cm.index ?? 0;
        done = true;
      }
    }
    next += body.slice(last);
    if (!done) next += cellXml(ref, '', value);
    out = out.slice(0, bodyStart) + next + out.slice(bodyEnd);
  }
  return out;
}

/** Sheet names and their XML part paths, from workbook.xml and its relationships. */
export async function xlsxSheets(entries: ZipEntry[]): Promise<{ name: string; path: string }[]> {
  const get = (n: string) => entries.find((e) => e.name === n);
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('Not an XLSX workbook (xl/workbook.xml is missing).');
  const relText = await entryText(rels);
  const targets = new Map<string, string>();
  for (const m of relText.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const t = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && t) targets.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`);
  }
  const out: { name: string; path: string }[] = [];
  for (const m of (await entryText(wb)).matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlUnesc(m[0].match(/\bname="([^"]*)"/)?.[1] ?? '');
    const id = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? '';
    const path = targets.get(id);
    if (path) out.push({ name, path });
  }
  return out;
}

async function sheetEntry(entries: ZipEntry[], sheet?: string): Promise<{ entry: ZipEntry; name: string }> {
  const sheets = await xlsxSheets(entries);
  const s = sheet ? sheets.find((x) => x.name === sheet) : sheets[0];
  if (!s) throw new Error(sheet ? `The workbook has no sheet "${sheet}" (sheets: ${sheets.map((x) => x.name).join(', ')}).` : 'The workbook has no sheets.');
  const entry = entries.find((e) => e.name === s.path);
  if (!entry) throw new Error(`Sheet part ${s.path} is missing.`);
  return { entry, name: s.name };
}

/** Copy of the workbook with the values written into one sheet (the first when `sheet` is not given). */
export async function fillXlsxTemplate(bytes: Uint8Array, cells: Record<string, CellValue>, sheet?: string): Promise<Uint8Array> {
  const entries = readZip(bytes);
  const { entry } = await sheetEntry(entries, sheet);
  const data = new TextEncoder().encode(patchSheetXml(await entryText(entry), cells));
  return rewriteZip(entries, new Map([[entry.name, { data, deflated: await deflateRaw(data) }]]));
}

/** Text of cells of one sheet (shared strings, inline strings and values), e.g. to preview a mapping. */
export async function readXlsxCells(bytes: Uint8Array, refs: string[], sheet?: string): Promise<{ sheet: string; sheets: string[]; cells: Record<string, string> }> {
  const entries = readZip(bytes);
  const sheets = (await xlsxSheets(entries)).map((s) => s.name);
  const { entry, name } = await sheetEntry(entries, sheet);
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const shared = ssEntry ? [...(await entryText(ssEntry)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnesc(t[1])).join('')) : [];
  const xml = await entryText(entry);
  const want = new Set(refs.map((r) => r.toUpperCase()));
  const cells: Record<string, string> = {};
  for (const m of xml.matchAll(CELL_RE)) {
    const r = m[0].match(/\br="([A-Z]+\d+)"/)?.[1];
    if (!r || !want.has(r)) continue;
    const t = m[0].match(/\bt="(\w+)"/)?.[1];
    const v = m[0].match(/<v>([\s\S]*?)<\/v>/)?.[1];
    if (t === 's' && v !== undefined) cells[r] = shared[Number(v)] ?? '';
    else if (t === 'inlineStr') cells[r] = [...m[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlUnesc(x[1])).join('');
    else if (v !== undefined) cells[r] = xmlUnesc(v);
  }
  return { sheet: name, sheets, cells };
}
