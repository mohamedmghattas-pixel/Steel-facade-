/**
 * Survey point import: CSV / text, DXF (POINT entities; INSERT and TEXT
 * positions as fallback) and IFC (placements of IfcAnnotation,
 * IfcBuildingElementProxy and IfcVirtualElement via web-ifc). Every parser
 * returns points in model millimetres (after `scale` and `offset`).
 */
import DxfParser from 'dxf-parser';
import type { SurveyPoint, Vec3 } from '../model/types';

export interface SurveyImportOptions {
  /** Multiply file coordinates by this (1000 for metres). Default 1. */
  scale?: number;
  /** Subtracted after scaling (site grid origin in model coordinates), mm. */
  offset?: Vec3;
}

export interface SurveyParseResult {
  points: SurveyPoint[];
  /** Lines / entities that were skipped, with the reason. */
  skipped: string[];
  format: 'csv' | 'dxf' | 'ifc' | '3dm';
}

let seq = 0;
const pid = () => `sp-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function transform(v: Vec3, o: SurveyImportOptions): Vec3 {
  const k = o.scale && Number.isFinite(o.scale) && o.scale > 0 ? o.scale : 1;
  const off = o.offset ?? { x: 0, y: 0, z: 0 };
  return { x: v.x * k - off.x, y: v.y * k - off.y, z: v.z * k - off.z };
}

// ---------------------------------------------------------------------------
// CSV / text

/** Pick the separator of one line: tab, then semicolon, then comma, then whitespace. */
function splitLine(line: string): { cells: string[]; sep: string } {
  const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : line.includes(',') ? ',' : ' ';
  const cells = (sep === ' ' ? line.trim().split(/\s+/) : line.split(sep)).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
  return { cells, sep };
}

/** A number in the cell; with ';' or tab separators a decimal comma is accepted. */
function parseNum(cell: string | undefined, sep: string): number | null {
  if (cell === undefined) return null;
  let t = cell.trim();
  if (!t) return null;
  if (sep !== ',' && /^[+-]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lines `name, x, y, z [, design x, y, z]` (or `x, y, z [, dx, dy, dz]`
 * without a name). Comma, semicolon, tab or whitespace separated; header and
 * comment lines (#, //) are skipped.
 */
export function parseSurveyCsv(text: string, o: SurveyImportOptions = {}): SurveyParseResult {
  const points: SurveyPoint[] = [];
  const skipped: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const { cells, sep } = splitLine(line);
    const nums = cells.map((c) => parseNum(c, sep));
    const isNum = (i: number) => nums[i] !== null && nums[i] !== undefined;
    const xyzAt = (i: number) => isNum(i) && isNum(i + 1) && isNum(i + 2);
    // name,x,y,z… | x,y,z[,dx,dy,dz] (3 or 6 numbers) | no,x,y,z… (numeric point number).
    let at: number;
    if (!isNum(0)) at = xyzAt(1) ? 1 : -1;
    else if ((nums.length === 3 || nums.length === 6) && nums.every((n) => n !== null)) at = 0;
    else at = xyzAt(1) ? 1 : xyzAt(0) ? 0 : -1;
    if (at < 0) {
      skipped.push(`line ${i + 1}: ${line.length > 40 ? `${line.slice(0, 40)}…` : line}`);
      return;
    }
    const name = at === 1 && cells[0] ? cells[0] : `P${points.length + 1}`;
    const p = transform({ x: nums[at]!, y: nums[at + 1]!, z: nums[at + 2]! }, o);
    const pt: SurveyPoint = { id: pid(), name, p };
    if (xyzAt(at + 3)) pt.design = transform({ x: nums[at + 3]!, y: nums[at + 4]!, z: nums[at + 5]! }, o);
    points.push(pt);
  });
  return { points, skipped, format: 'csv' };
}

// ---------------------------------------------------------------------------
// DXF

interface P3 {
  x: number;
  y: number;
  z?: number;
}
interface RawEntity {
  type: string;
  layer?: string;
  position?: P3;
  startPoint?: P3;
  text?: string;
  textHeight?: number;
  height?: number;
  name?: string;
}

const v3 = (p: P3): Vec3 => ({ x: p.x, y: p.y, z: p.z ?? 0 });
/** Strip MTEXT formatting codes ("\\P", "{\\fArial;…}"). */
const plain = (s: string) => s.replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/\\P/g, ' ').replace(/[{}]/g, '').trim();

/**
 * POINT entities (named after the nearest TEXT / MTEXT label within five text
 * heights, else layer + number). Without POINTs, block INSERT positions are
 * used, then TEXT insertion points (the text is the name).
 */
export function parseSurveyDxf(text: string, o: SurveyImportOptions = {}): SurveyParseResult {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Could not read the DXF file.');
  const ents = dxf.entities as unknown as RawEntity[];
  const labels = ents
    .filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && e.text && (e.startPoint || e.position))
    .map((e) => ({ text: plain(e.text!), at: v3((e.startPoint ?? e.position)!), h: e.textHeight ?? e.height ?? 0 }))
    .filter((l) => l.text);
  const nameNear = (q: Vec3): string | undefined => {
    let best: { d: number; t: string } | undefined;
    for (const l of labels) {
      const d = Math.hypot(l.at.x - q.x, l.at.y - q.y);
      const lim = 5 * (l.h > 0 ? l.h : 0);
      if (d <= lim && (!best || d < best.d)) best = { d, t: l.text };
    }
    return best?.t;
  };
  const skipped: string[] = [];
  const counts = new Map<string, number>();
  const auto = (prefix: string) => {
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    return `${prefix}-${n}`;
  };
  const make = (at: Vec3, name: string): SurveyPoint => ({ id: pid(), name, p: transform(at, o) });
  let points = ents.filter((e) => e.type === 'POINT' && e.position).map((e) => make(v3(e.position!), nameNear(v3(e.position!)) ?? auto(e.layer ?? 'P')));
  if (!points.length) {
    points = ents.filter((e) => e.type === 'INSERT' && e.position).map((e) => make(v3(e.position!), nameNear(v3(e.position!)) ?? auto(e.name ?? 'INSERT')));
    if (points.length) skipped.push('No POINT entities: block insertion points used.');
  }
  if (!points.length && labels.length) {
    points = labels.map((l) => make(l.at, l.text));
    skipped.push('No POINT or INSERT entities: text insertion points used.');
  }
  return { points, skipped, format: 'dxf' };
}

// ---------------------------------------------------------------------------
// IFC (web-ifc)

/** The slice of web-ifc's IfcAPI the parser needs (so it runs in Node tests and the browser). */
export interface IfcApiLike {
  GetLineIDsWithType(modelID: number, type: number): { size(): number; get(i: number): number };
  GetLine(modelID: number, id: number, flatten?: boolean): unknown;
}

/** web-ifc type codes (from web-ifc's IFC schema constants). */
export interface IfcTypeCodes {
  IFCANNOTATION: number;
  IFCBUILDINGELEMENTPROXY: number;
  IFCVIRTUALELEMENT: number;
  IFCSIUNIT: number;
  IFCCONVERSIONBASEDUNIT?: number;
}

type Any = Record<string, unknown> | null | undefined;
const val = (x: unknown): unknown => (x && typeof x === 'object' && 'value' in (x as object) ? (x as { value: unknown }).value : x);
const numv = (x: unknown): number => {
  const n = Number(val(x));
  return Number.isFinite(n) ? n : 0;
};

interface Mat {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}
const IDENT: Mat = { o: { x: 0, y: 0, z: 0 }, x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };
const nrm = (v: Vec3) => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const crs = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const apply = (m: Mat, p: Vec3): Vec3 => ({
  x: m.o.x + m.x.x * p.x + m.y.x * p.y + m.z.x * p.z,
  y: m.o.y + m.x.y * p.x + m.y.y * p.y + m.z.y * p.z,
  z: m.o.z + m.x.z * p.x + m.y.z * p.y + m.z.z * p.z,
});
const compose = (parent: Mat, child: Mat): Mat => {
  const rot = (v: Vec3) => ({
    x: parent.x.x * v.x + parent.y.x * v.y + parent.z.x * v.z,
    y: parent.x.y * v.x + parent.y.y * v.y + parent.z.y * v.z,
    z: parent.x.z * v.x + parent.y.z * v.y + parent.z.z * v.z,
  });
  return { o: apply(parent, child.o), x: rot(child.x), y: rot(child.y), z: rot(child.z) };
};

/**
 * Points from the placements of IfcAnnotation, IfcBuildingElementProxy and
 * IfcVirtualElement (the usual carriers of survey / setting-out points). An
 * annotation whose representation is a single IfcCartesianPoint uses that
 * point. Coordinates are converted from the file's length unit to mm.
 */
export function parseSurveyIfc(api: IfcApiLike, modelID: number, types: IfcTypeCodes, o: SurveyImportOptions = {}): SurveyParseResult {
  const line = (id: unknown): Any => {
    const ref = val(id);
    return typeof ref === 'number' ? (api.GetLine(modelID, ref) as Any) : (ref as Any);
  };
  const ids = (type: number) => {
    const v = api.GetLineIDsWithType(modelID, type);
    return Array.from({ length: v.size() }, (_, i) => v.get(i));
  };
  // Length unit → mm.
  let unit = 1000;
  for (const id of ids(types.IFCSIUNIT)) {
    const u = line(id);
    if (String(val(u?.UnitType)) !== 'LENGTHUNIT') continue;
    const prefix = String(val(u?.Prefix) ?? '');
    unit = prefix === 'MILLI' ? 1 : prefix === 'CENTI' ? 10 : prefix === 'DECI' ? 100 : prefix === 'KILO' ? 1e6 : 1000;
    break;
  }
  if (types.IFCCONVERSIONBASEDUNIT) {
    for (const id of ids(types.IFCCONVERSIONBASEDUNIT)) {
      const u = line(id);
      if (String(val(u?.UnitType)) !== 'LENGTHUNIT') continue;
      const name = String(val(u?.Name) ?? '').toLowerCase();
      if (name.includes('foot') || name.includes('feet')) unit = 304.8;
      else if (name.includes('inch')) unit = 25.4;
      break;
    }
  }
  const point = (id: unknown): Vec3 => {
    const cp = line(id);
    const c = (cp?.Coordinates as unknown[] | undefined) ?? [];
    return { x: numv(c[0]), y: numv(c[1]), z: numv(c[2]) };
  };
  const dir = (id: unknown, d: Vec3): Vec3 => {
    if (!val(id)) return d;
    const l = line(id);
    const r = (l?.DirectionRatios as unknown[] | undefined) ?? [];
    return nrm({ x: numv(r[0]), y: numv(r[1]), z: numv(r[2]) });
  };
  const axis2 = (id: unknown): Mat => {
    const a = line(id);
    if (!a) return IDENT;
    const o3 = a.Location ? point(a.Location) : { x: 0, y: 0, z: 0 };
    const z = dir(a.Axis, { x: 0, y: 0, z: 1 });
    let x = dir(a.RefDirection, { x: 1, y: 0, z: 0 });
    const y = nrm(crs(z, x));
    x = crs(y, z);
    return { o: o3, x, y, z };
  };
  const seen = new Map<number, Mat>();
  const placement = (id: unknown, depth = 0): Mat => {
    const ref = val(id);
    if (typeof ref !== 'number' || depth > 64) return IDENT;
    const cached = seen.get(ref);
    if (cached) return cached;
    const lp = line(ref);
    const rel = lp?.RelativePlacement ? axis2(lp.RelativePlacement) : IDENT;
    const m = lp?.PlacementRelTo ? compose(placement(lp.PlacementRelTo, depth + 1), rel) : rel;
    seen.set(ref, m);
    return m;
  };
  /** A lone IfcCartesianPoint in the shape representation, in object coordinates. */
  const reprPoint = (el: Any): Vec3 | null => {
    const shape = line(el?.Representation);
    const reps = (shape?.Representations as unknown[] | undefined) ?? [];
    for (const r of reps) {
      const rep = line(r);
      const items = (rep?.Items as unknown[] | undefined) ?? [];
      if (items.length !== 1) continue;
      const it = line(items[0]);
      if (it && Array.isArray(it.Coordinates)) return point(items[0]);
    }
    return null;
  };
  const points: SurveyPoint[] = [];
  const skipped: string[] = [];
  for (const type of [types.IFCANNOTATION, types.IFCBUILDINGELEMENTPROXY, types.IFCVIRTUALELEMENT]) {
    for (const id of ids(type)) {
      const el = line(id);
      if (!el?.ObjectPlacement) {
        skipped.push(`#${id}: no placement`);
        continue;
      }
      const m = placement(el.ObjectPlacement);
      const local = reprPoint(el) ?? { x: 0, y: 0, z: 0 };
      const w = apply(m, local);
      const name = String(val(el.Name) ?? val(el.Tag) ?? '') || `#${id}`;
      points.push({ id: pid(), name, p: transform({ x: w.x * unit, y: w.y * unit, z: w.z * unit }, o) });
    }
  }
  return { points, skipped, format: 'ifc' };
}

/** Pick the parser from the file name (CSV / TXT / XYZ default). */
export function surveyFormat(fileName: string): 'csv' | 'dxf' | 'ifc' {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ext === 'dxf' ? 'dxf' : ext === 'ifc' ? 'ifc' : 'csv';
}
