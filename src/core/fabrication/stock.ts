/**
 * Stock availability (bars on hand) from CSV, tolerant of what stores and
 * ERP systems export:
 * - delimiter `,` `;` or tab; quoted fields; blank lines and `#` comments skipped
 * - optional header row (profile / section / designation, length, qty / quantity /
 *   pcs / on hand, material / grade) in any column order; without a header the
 *   columns are recognised by content (profile text, length, qty, grade)
 * - lengths in mm, or metres with "m" (bare values ≤ 30 are taken as metres)
 * - qty -1, "unlimited", "inf", "∞" or "*" = unlimited
 * Rows for the same profile, length and material are merged.
 */
import type { StockItem } from '../model/types';
import { getProfile } from '../library/profiles';
import { toCsv, type Row } from '../reports/bom';

export interface StockParseResult {
  items: StockItem[];
  errors: string[];
  warnings: string[];
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === '') {
      q = true;
      cur = '';
    } else if (c === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(line: string): string {
  if (line.includes('\t')) return '\t';
  if (line.includes(';')) return ';';
  return ',';
}

const UNLIMITED = /^(-1|unlimited|unlim|inf|infinite|∞|\*|any)$/i;

/** Length in mm from "6000", "6000 mm", "6 m", "6,5m"; null if not a length. */
export function parseLength(s: string, decimalComma = false): number | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d+(?:[.,]\d+)?)(mm|m)?$/);
  if (!m) return null;
  const raw = m[1].includes(',') ? (decimalComma ? m[1].replace(',', '.') : m[1].replace(',', '')) : m[1];
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (m[2] === 'm' || (!m[2] && v <= 30)) return Math.round(v * 1000);
  return Math.round(v * 10) / 10;
}

function parseQty(s: string): number | null {
  const t = s.trim();
  if (UNLIMITED.test(t)) return -1;
  const m = t.match(/^(\d+)(?:\s*(?:pcs|pc|no|nr|x|bars?|st))?\.?$/i);
  return m ? Number(m[1]) : null;
}

const isGrade = (s: string) => /^(S\d{3}|A\d{3,4}|1\.\d{4}|EN\s?AW|AISI|304|316|Q\d{3}|Fe\s?\d{3}|St\s?\d{2})/i.test(s.trim());
const isNumberish = (s: string) => /^[\d.,\s]+(mm|m)?$/i.test(s.trim()) || UNLIMITED.test(s.trim());

type Col = 'profile' | 'length' | 'qty' | 'material';

function headerColumns(cells: string[]): Partial<Record<Col, number>> | null {
  const map: Partial<Record<Col, number>> = {};
  cells.forEach((c, i) => {
    const h = c.toLowerCase();
    if (map.profile === undefined && /profile|section|designation|size|article|item|description/.test(h)) map.profile = i;
    else if (map.length === undefined && /length|len\b|^l$|^l \(|lengte|länge/.test(h)) map.length = i;
    else if (map.qty === undefined && /qty|quantity|count|pcs|pieces|on ?hand|available|stock|^no\.?$|^n$|number|menge|anzahl/.test(h)) map.qty = i;
    else if (map.material === undefined && /material|grade|steel|quality|werkstoff/.test(h)) map.material = i;
  });
  return map.profile !== undefined && map.length !== undefined ? map : null;
}

/** Recognise columns by content when there is no header. */
function guessRow(cells: string[], decimalComma: boolean): { profile?: string; length?: number; qty?: number; material?: string } {
  const res: { profile?: string; length?: number; qty?: number; material?: string } = {};
  const nums: { i: number; s: string }[] = [];
  for (const [i, c] of cells.entries()) {
    if (!c) continue;
    if (isNumberish(c)) nums.push({ i, s: c });
    else if (!res.profile && !isGrade(c)) res.profile = c;
    else if (!res.material) res.material = c;
  }
  // Explicit units or the larger value make the length; the other number is the quantity.
  const withUnit = nums.find((n) => /m$/i.test(n.s.trim()));
  const unlimited = nums.find((n) => UNLIMITED.test(n.s.trim()));
  const ordered = [...nums].sort((a, b) => (parseLength(b.s, decimalComma) ?? 0) - (parseLength(a.s, decimalComma) ?? 0));
  const lenCell = withUnit ?? ordered.find((n) => n !== unlimited && (parseLength(n.s, decimalComma) ?? 0) >= 100) ?? ordered.find((n) => n !== unlimited);
  if (lenCell) res.length = parseLength(lenCell.s, decimalComma) ?? undefined;
  const qtyCell = unlimited ?? nums.find((n) => n !== lenCell);
  if (qtyCell) res.qty = parseQty(qtyCell.s) ?? undefined;
  return res;
}

export function parseStockCsv(text: string): StockParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const content = lines.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.trim() && !/^\s*(#|\/\/)/.test(l));
  if (!content.length) return { items: [], errors: ['The file is empty.'], warnings };
  const delim = detectDelimiter(content[0].l);
  const decimalComma = delim !== ',';
  let cols = headerColumns(splitLine(content[0].l, delim));
  const rows = cols ? content.slice(1) : content;
  const merged = new Map<string, StockItem>();
  const unknown = new Set<string>();
  for (const { l, n } of rows) {
    const cells = splitLine(l, delim);
    let profile: string | undefined;
    let length: number | null | undefined;
    let qty: number | null | undefined;
    let material: string | undefined;
    if (cols) {
      profile = cells[cols.profile!];
      length = cells[cols.length!] !== undefined ? parseLength(cells[cols.length!], decimalComma) : null;
      qty = cols.qty !== undefined && cells[cols.qty]?.trim() ? parseQty(cells[cols.qty]) : undefined;
      material = cols.material !== undefined ? cells[cols.material] : undefined;
    } else {
      const g = guessRow(cells, decimalComma);
      ({ profile, material } = g);
      length = g.length;
      qty = g.qty;
    }
    if (!profile?.trim()) {
      errors.push(`Line ${n}: no profile.`);
      continue;
    }
    if (!length) {
      errors.push(`Line ${n}: no valid length for ${profile}.`);
      continue;
    }
    if (qty === null) {
      errors.push(`Line ${n}: quantity is not a whole number (use -1 for unlimited).`);
      continue;
    }
    if (qty === undefined) {
      warnings.push(`Line ${n}: no quantity — taken as 1.`);
      qty = 1;
    }
    const prof = getProfile(profile.trim());
    if (!prof) unknown.add(profile.trim());
    const item: StockItem = { profile: prof?.name ?? profile.trim(), length, qty };
    if (material?.trim()) item.material = material.trim();
    const key = `${item.profile}|${item.length}|${item.material ?? ''}`;
    const prev = merged.get(key);
    if (prev) prev.qty = prev.qty < 0 || item.qty < 0 ? -1 : prev.qty + item.qty;
    else merged.set(key, item);
  }
  if (unknown.size) warnings.push(`Not in the profile library (kept as typed): ${[...unknown].slice(0, 5).join(', ')}${unknown.size > 5 ? '…' : ''}`);
  return { items: [...merged.values()], errors, warnings };
}

export function stockToCsv(items: StockItem[]): string {
  const rows: Row[] = [['Profile', 'Length (mm)', 'Qty', 'Material']];
  for (const s of items) rows.push([s.profile, s.length, s.qty, s.material ?? '']);
  return toCsv(rows);
}
