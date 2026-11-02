/**
 * Small ASCII DXF reader for geometry import. It keeps every entity as its raw
 * group-code list, so the geometry stage can read exactly what it needs:
 * dxf-parser drops data a 3D import depends on (POLYLINE elevation and mesh
 * sizes, CIRCLE extrusion, MESH faces, ATTRIB sequences) and throws on some
 * degenerate entities, which aborts the whole file.
 *
 * Sections read: HEADER ($INSUNITS, $MEASUREMENT, $ACADVER), TABLES (layer
 * states), BLOCKS (name, flags, base point, entities) and ENTITIES. VERTEX
 * records are attached to their POLYLINE; ATTRIB / SEQEND are dropped, unless
 * read with `{ attributes: true }`: the ATTRIB records of a block insert are then
 * kept on its INSERT (`attribs`), e.g. for title blocks (drawings/titleBlockDxf.ts).
 */
import type { Vec3 } from '../model/types';

export interface DxfEntity {
  type: string;
  codes: number[];
  values: string[];
  /** POLYLINE: its VERTEX records in file order. */
  vertices?: DxfEntity[];
  /** INSERT: its ATTRIB records in file order (only when read with `{ attributes: true }`). */
  attribs?: DxfEntity[];
}

export interface DxfReaderOptions {
  /** Keep the ATTRIB records that follow a block insert, on the INSERT's `attribs` (default off: dropped). */
  attributes?: boolean;
}

export interface DxfBlock {
  name: string;
  /** BLOCK flags (1 anonymous, 4 xref, 8 xref overlay …). */
  flags: number;
  base: Vec3;
  entities: DxfEntity[];
}

export interface DxfLayerState {
  frozen: boolean;
  off: boolean;
}

export interface DxfDocument {
  insunits: number | null;
  measurement: number | null;
  version: string | null;
  layers: Map<string, DxfLayerState>;
  /** Keyed by upper-case block name (AutoCAD names are case-insensitive). */
  blocks: Map<string, DxfBlock>;
  entities: DxfEntity[];
}

// ---------------------------------------------------------------------------
// Entity accessors

/** First value of a group code as a number (fallback when absent or not numeric). */
export function gNum(e: DxfEntity, code: number, fallback = 0): number {
  const i = e.codes.indexOf(code);
  if (i < 0) return fallback;
  const n = Number(e.values[i]);
  return Number.isFinite(n) ? n : fallback;
}

/** First value of a group code as a string. */
export function gStr(e: DxfEntity, code: number, fallback = ''): string {
  const i = e.codes.indexOf(code);
  return i < 0 ? fallback : e.values[i];
}

export function gHas(e: DxfEntity, code: number): boolean {
  return e.codes.includes(code);
}

/** Point from group codes c, c+10, c+20 (e.g. 10/20/30). */
export function gPoint(e: DxfEntity, c: number, fallback: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  return { x: gNum(e, c, fallback.x), y: gNum(e, c + 10, fallback.y), z: gNum(e, c + 20, fallback.z) };
}

/** All points of a repeated x/y/z group (e.g. control points 10/20/30), in order. */
export function gPoints(e: DxfEntity, c: number): Vec3[] {
  const out: Vec3[] = [];
  let cur: Vec3 | null = null;
  for (let i = 0; i < e.codes.length; i++) {
    const code = e.codes[i];
    const n = Number(e.values[i]);
    if (code === c) {
      cur = { x: Number.isFinite(n) ? n : 0, y: 0, z: 0 };
      out.push(cur);
    } else if (cur && code === c + 10) cur.y = Number.isFinite(n) ? n : 0;
    else if (cur && code === c + 20) cur.z = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/** All numeric values of a repeated group code, in order. */
export function gNums(e: DxfEntity, code: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.codes.length; i++) if (e.codes[i] === code) out.push(Number(e.values[i]) || 0);
  return out;
}

// ---------------------------------------------------------------------------
// Scanner

class Scanner {
  private pos = 0;
  private line = 0;
  private back = false;
  code = 0;
  value = '';

  constructor(private readonly s: string) {}

  private readLine(): string | null {
    const s = this.s;
    if (this.pos >= s.length) return null;
    let e = s.indexOf('\n', this.pos);
    if (e < 0) e = s.length;
    let l = s.slice(this.pos, e);
    this.pos = e + 1;
    this.line++;
    if (l.endsWith('\r')) l = l.slice(0, -1);
    return l;
  }

  /** Advance to the next (code, value) pair. False at end of input. */
  next(): boolean {
    if (this.back) {
      this.back = false;
      return true;
    }
    const c = this.readLine();
    if (c === null) return false;
    const v = this.readLine();
    if (v === null) return false;
    const code = Number.parseInt(c, 10);
    if (!Number.isFinite(code)) {
      if (c.trim() === '') return this.next(); // stray blank line
      throw new Error(`Not an ASCII DXF file (unexpected "${c.trim().slice(0, 40)}" on line ${this.line - 1}).`);
    }
    this.code = code;
    this.value = v.trim();
    return true;
  }

  pushBack() {
    this.back = true;
  }

  is(code: number, value: string) {
    return this.code === code && this.value === value;
  }
}

// ---------------------------------------------------------------------------
// Reader

export function readDxf(text: string, opts: DxfReaderOptions = {}): DxfDocument {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (src.indexOf('\n') < 0 && src.indexOf('\r') >= 0) src = src.replace(/\r/g, '\n');
  const sc = new Scanner(src);
  const doc: DxfDocument = { insunits: null, measurement: null, version: null, layers: new Map(), blocks: new Map(), entities: [] };
  let sawSection = false;
  while (sc.next()) {
    if (sc.is(0, 'EOF')) break;
    if (!sc.is(0, 'SECTION')) continue;
    sawSection = true;
    if (!sc.next()) break;
    const name = sc.code === 2 ? sc.value.toUpperCase() : '';
    if (name === 'HEADER') readHeader(sc, doc);
    else if (name === 'TABLES') readTables(sc, doc);
    else if (name === 'BLOCKS') readBlocks(sc, doc, opts);
    else if (name === 'ENTITIES') readEntities(sc, doc.entities, opts);
    else skipSection(sc);
  }
  if (!sawSection) throw new Error('Not a DXF file (no SECTION found).');
  return doc;
}

function skipSection(sc: Scanner) {
  while (sc.next()) if (sc.code === 0 && (sc.value === 'ENDSEC' || sc.value === 'EOF')) return;
}

function readHeader(sc: Scanner, doc: DxfDocument) {
  let v = '';
  while (sc.next()) {
    if (sc.code === 0) {
      if (sc.value !== 'ENDSEC') sc.pushBack();
      return;
    }
    if (sc.code === 9) {
      v = sc.value.toUpperCase();
      continue;
    }
    const n = Number(sc.value);
    if (v === '$INSUNITS' && sc.code === 70 && Number.isFinite(n)) doc.insunits = n;
    else if (v === '$MEASUREMENT' && sc.code === 70 && Number.isFinite(n)) doc.measurement = n;
    else if (v === '$ACADVER' && sc.code === 1) doc.version = sc.value;
  }
}

/** Reads the records of a section up to ENDSEC: each record is "0 TYPE" plus its pairs. */
function readRecord(sc: Scanner, type: string): DxfEntity {
  const e: DxfEntity = { type, codes: [], values: [] };
  while (sc.next()) {
    if (sc.code === 0) {
      sc.pushBack();
      break;
    }
    e.codes.push(sc.code);
    e.values.push(sc.value);
  }
  return e;
}

function readTables(sc: Scanner, doc: DxfDocument) {
  while (sc.next()) {
    if (sc.code !== 0) continue;
    if (sc.value === 'ENDSEC' || sc.value === 'EOF') return;
    const rec = readRecord(sc, sc.value);
    if (rec.type !== 'LAYER') continue;
    const name = gStr(rec, 2);
    if (!name) continue;
    doc.layers.set(name, { frozen: (gNum(rec, 70) & 1) !== 0, off: gNum(rec, 62, 7) < 0 });
  }
}

function readBlocks(sc: Scanner, doc: DxfDocument, opts: DxfReaderOptions) {
  while (sc.next()) {
    if (sc.code !== 0) continue;
    if (sc.value === 'ENDSEC' || sc.value === 'EOF') return;
    if (sc.value !== 'BLOCK') {
      readRecord(sc, sc.value);
      continue;
    }
    const head = readRecord(sc, 'BLOCK');
    const block: DxfBlock = { name: gStr(head, 2) || gStr(head, 3), flags: gNum(head, 70), base: gPoint(head, 10), entities: [] };
    readEntities(sc, block.entities, opts);
    // ENDBLK record (if present) is consumed by the loop above.
    if (block.name && !doc.blocks.has(block.name.toUpperCase())) doc.blocks.set(block.name.toUpperCase(), block);
  }
}

/** Entities up to ENDSEC / ENDBLK / EOF (the terminator is consumed, except EOF). */
function readEntities(sc: Scanner, out: DxfEntity[], opts: DxfReaderOptions = {}) {
  let poly: DxfEntity | null = null;
  // The INSERT whose ATTRIB records may follow (up to SEQEND).
  let insert: DxfEntity | null = null;
  while (sc.next()) {
    if (sc.code !== 0) continue;
    const type = sc.value.toUpperCase();
    if (type === 'ENDSEC' || type === 'ENDBLK') {
      if (type === 'ENDBLK') readRecord(sc, type);
      return;
    }
    if (type === 'EOF' || type === 'BLOCK') {
      // EOF, or the next BLOCK of a block section whose ENDBLK is missing.
      sc.pushBack();
      return;
    }
    const e = readRecord(sc, type);
    if (type === 'VERTEX') {
      if (poly) poly.vertices!.push(e);
      continue;
    }
    if (type === 'SEQEND') {
      poly = null;
      insert = null;
      continue;
    }
    // Block attributes are text; they follow an INSERT up to SEQEND.
    if (type === 'ATTRIB') {
      if (opts.attributes && insert) (insert.attribs ??= []).push(e);
      continue;
    }
    poly = null;
    insert = type === 'INSERT' ? e : null;
    if (type === 'POLYLINE') {
      e.vertices = [];
      poly = e;
    }
    out.push(e);
  }
}
