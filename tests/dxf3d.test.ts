import { describe, expect, it } from 'vitest';
import { dxfUnitScale, importDxfWireframe, parseDxf, previewDxfImport, type DxfImportOptions, type ParsedDxf } from '../src/core/io/dxfImport';
import { joinSegments } from '../src/core/io/wireframeJoin';
import { createProject } from '../src/core/model/ops';
import type { Project, Vec3 } from '../src/core/model/types';

// ---------------------------------------------------------------------------
// Synthetic DXF writer: every entity is a list of (group code, value) pairs.

type Pair = [number, string | number];
type Pt = number[];

const P3 = (c: number, p: Pt): Pair[] => [
  [c, p[0]],
  [c + 10, p[1]],
  [c + 20, p[2] ?? 0],
];

interface BlockDef {
  name: string;
  base?: Pt;
  flags?: number;
  entities: Pair[][];
}

function dxfText(o: { insunits?: number; measurement?: number; layers?: { name: string; flags?: number; color?: number }[]; blocks?: BlockDef[]; entities: Pair[][] }): string {
  const out: Pair[] = [];
  out.push([0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1027']);
  if (o.insunits !== undefined) out.push([9, '$INSUNITS'], [70, o.insunits]);
  if (o.measurement !== undefined) out.push([9, '$MEASUREMENT'], [70, o.measurement]);
  out.push([0, 'ENDSEC']);
  out.push([0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [70, (o.layers ?? []).length]);
  for (const l of o.layers ?? []) out.push([0, 'LAYER'], [2, l.name], [70, l.flags ?? 0], [62, l.color ?? 7], [6, 'CONTINUOUS']);
  out.push([0, 'ENDTAB'], [0, 'ENDSEC']);
  out.push([0, 'SECTION'], [2, 'BLOCKS']);
  for (const b of o.blocks ?? []) {
    out.push([0, 'BLOCK'], [8, '0'], [2, b.name], [70, b.flags ?? 0], ...P3(10, b.base ?? [0, 0, 0]), [3, b.name], [1, '']);
    for (const e of b.entities) out.push(...e);
    out.push([0, 'ENDBLK'], [8, '0']);
  }
  out.push([0, 'ENDSEC']);
  out.push([0, 'SECTION'], [2, 'ENTITIES']);
  for (const e of o.entities) out.push(...e);
  out.push([0, 'ENDSEC'], [0, 'EOF']);
  return out.map(([c, v]) => `${String(c).padStart(3)}\n${v}`).join('\r\n') + '\r\n';
}

const line = (a: Pt, b: Pt, layer = '0'): Pair[] => [[0, 'LINE'], [8, layer], ...P3(10, a), ...P3(11, b)];

function lwpoly(pts: Pt[], o: { closed?: boolean; elevation?: number; n?: Pt; layer?: string } = {}): Pair[] {
  const out: Pair[] = [[0, 'LWPOLYLINE'], [8, o.layer ?? '0'], [100, 'AcDbPolyline'], [90, pts.length], [70, o.closed ? 1 : 0]];
  if (o.elevation) out.push([38, o.elevation]);
  for (const p of pts) {
    out.push([10, p[0]], [20, p[1]]);
    if (p[2]) out.push([42, p[2]]);
  }
  if (o.n) out.push(...P3(210, o.n));
  return out;
}

function poly(pts: Pt[], o: { flags?: number; elevation?: number; n?: Pt; layer?: string; vflags?: number; bulges?: number[]; extra?: Pair[]; faces?: number[][] } = {}): Pair[] {
  const layer = o.layer ?? '0';
  const out: Pair[] = [[0, 'POLYLINE'], [8, layer], [66, 1], [10, 0], [20, 0], [30, o.elevation ?? 0], [70, o.flags ?? 0], ...(o.extra ?? [])];
  if (o.n) out.push(...P3(210, o.n));
  pts.forEach((p, i) => {
    out.push([0, 'VERTEX'], [8, layer], ...P3(10, p), [70, o.vflags ?? 0]);
    if (o.bulges?.[i]) out.push([42, o.bulges[i]]);
  });
  for (const f of o.faces ?? []) out.push([0, 'VERTEX'], [8, layer], ...P3(10, [0, 0, 0]), [70, 128], ...f.map((v, k): Pair => [71 + k, v]));
  out.push([0, 'SEQEND'], [8, layer]);
  return out;
}

const arc = (c: Pt, r: number, a0: number, a1: number, n?: Pt, layer = '0'): Pair[] => [[0, 'ARC'], [8, layer], ...P3(10, c), [40, r], ...(n ? P3(210, n) : []), [50, a0], [51, a1]];
const circle = (c: Pt, r: number, layer = '0'): Pair[] => [[0, 'CIRCLE'], [8, layer], ...P3(10, c), [40, r]];

function insert(name: string, ins: Pt, o: { sx?: number; sy?: number; sz?: number; rot?: number; n?: Pt; cols?: number; rows?: number; cs?: number; rs?: number; layer?: string; attribs?: boolean } = {}): Pair[] {
  const out: Pair[] = [[0, 'INSERT'], [8, o.layer ?? '0']];
  if (o.attribs) out.push([66, 1]);
  out.push([2, name], ...P3(10, ins));
  if (o.sx !== undefined) out.push([41, o.sx]);
  if (o.sy !== undefined) out.push([42, o.sy]);
  if (o.sz !== undefined) out.push([43, o.sz]);
  if (o.rot !== undefined) out.push([50, o.rot]);
  if (o.cols) out.push([70, o.cols], [44, o.cs ?? 0]);
  if (o.rows) out.push([71, o.rows], [45, o.rs ?? 0]);
  if (o.n) out.push(...P3(210, o.n));
  if (o.attribs) out.push([0, 'ATTRIB'], [8, '0'], ...P3(10, [0, 0, 0]), [40, 100], [1, 'TAG VALUE'], [2, 'TAG'], [0, 'SEQEND'], [8, '0']);
  return out;
}

const face3d = (c: Pt[], hidden = 0): Pair[] => [[0, '3DFACE'], [8, 'FACES'], ...P3(10, c[0]), ...P3(11, c[1]), ...P3(12, c[2]), ...P3(13, c[3] ?? c[2]), [70, hidden]];

/** The 12 edges of the cube [0, s]³. */
function cubeEdges(s: number, layer = '0'): Pair[][] {
  const c = (i: number): Pt => [i & 1 ? s : 0, i & 2 ? s : 0, i & 4 ? s : 0];
  const out: Pair[][] = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) out.push(line(c(i), c(i | bit), layer));
  return out;
}

// ---------------------------------------------------------------------------
// Assertions

const near = (p: Vec3, q: Pt, tol = 1e-6) => Math.abs(p.x - q[0]) <= tol && Math.abs(p.y - q[1]) <= tol && Math.abs(p.z - (q[2] ?? 0)) <= tol;
const hasPoint = (d: ParsedDxf, q: Pt, tol = 1e-6) => d.segments.some((s) => near(s.a, q, tol) || near(s.b, q, tol));
const hasSeg = (d: ParsedDxf, a: Pt, b: Pt, tol = 1e-6) => d.segments.some((s) => (near(s.a, a, tol) && near(s.b, b, tol)) || (near(s.a, b, tol) && near(s.b, a, tol)));
const nodes = (p: Project) => Object.values(p.nodes).map((n) => n.p);
const hasNode = (p: Project, q: Pt, tol = 1e-6) => nodes(p).some((n) => near(n, q, tol));

const opts3d = (o: Partial<DxfImportOptions> = {}): DxfImportOptions => ({
  plane: { kind: 'XZ', offset: 0 },
  scale: 1,
  offset: { x: 0, y: 0, z: 0 },
  splitIntersections: true,
  use3d: true,
  ...o,
});

// ---------------------------------------------------------------------------

describe('DXF 3D wireframe: parsing', () => {
  it('reads a 3D frame of LINEs and imports it with X/Y/Z kept', () => {
    const cols = [
      [0, 0],
      [6000, 0],
      [6000, 4000],
      [0, 4000],
    ];
    const text = dxfText({
      insunits: 4,
      entities: [
        ...cols.map(([x, y]) => line([x, y, 0], [x, y, 3000], 'COLUMNS')),
        ...cols.map(([x, y], i) => line([x, y, 3000], [...cols[(i + 1) % 4], 3000], 'BEAMS')),
      ],
    });
    const d = parseDxf(text);
    expect(d.segments).toHaveLength(8);
    expect(d.is3d).toBe(true);
    expect(d.bounds.min.z).toBe(0);
    expect(d.bounds.max.z).toBe(3000);
    expect(d.layers).toEqual(['BEAMS', 'COLUMNS']);
    expect(d.entities.LINE.read).toBe(8);

    const p = createProject();
    const ids = importDxfWireframe(p, d, opts3d({ offset: { x: 100, y: 200, z: 50 } }));
    expect(ids).toHaveLength(8);
    expect(Object.keys(p.nodes)).toHaveLength(8);
    expect(hasNode(p, [100, 200, 50])).toBe(true);
    expect(hasNode(p, [6100, 4200, 3050])).toBe(true);
    expect(new Set(nodes(p).map((n) => n.z))).toEqual(new Set([50, 3050]));
  });

  it('reads 3D POLYLINE vertices as WCS and 2D POLYLINE elevation / OCS', () => {
    const text = dxfText({
      entities: [
        poly(
          [
            [0, 0, 0],
            [1000, 0, 500],
            [1000, 1000, 1000],
          ],
          { flags: 8 | 1, vflags: 32 },
        ),
        // 2D polyline at elevation 250 in a front-view OCS (N = 0,−1,0): OCS y → world Z, elevation → −Y.
        poly(
          [
            [0, 0, 0],
            [2000, 0, 0],
            [2000, 1500, 0],
          ],
          { elevation: 250, n: [0, -1, 0] },
        ),
      ],
    });
    const d = parseDxf(text);
    expect(d.entities.POLYLINE.read).toBe(2);
    expect(d.segments).toHaveLength(3 + 2);
    expect(hasSeg(d, [1000, 0, 500], [1000, 1000, 1000])).toBe(true);
    expect(hasSeg(d, [1000, 1000, 1000], [0, 0, 0])).toBe(true); // closed
    expect(hasSeg(d, [0, -250, 0], [2000, -250, 0])).toBe(true);
    expect(hasSeg(d, [2000, -250, 0], [2000, -250, 1500])).toBe(true);
  });

  it('applies the OCS of LWPOLYLINEs drawn in rotated UCSs (elevations)', () => {
    const text = dxfText({
      entities: [
        // Front elevation: extrusion (0,−1,0), elevation 500 → the plane y = −500.
        lwpoly(
          [
            [0, 0],
            [3000, 0],
            [3000, 3500],
          ],
          { n: [0, -1, 0], elevation: 500, layer: 'FRONT' },
        ),
        // Side elevation: extrusion (1,0,0) → OCS x → world Y, OCS y → world Z, elevation → world X.
        lwpoly(
          [
            [0, 0],
            [2000, 3000],
          ],
          { n: [1, 0, 0], elevation: 700, layer: 'SIDE' },
        ),
      ],
    });
    const d = parseDxf(text);
    expect(d.is3d).toBe(true);
    expect(hasSeg(d, [0, -500, 0], [3000, -500, 0])).toBe(true);
    expect(hasSeg(d, [3000, -500, 0], [3000, -500, 3500])).toBe(true);
    expect(hasSeg(d, [700, 0, 0], [700, 2000, 3000])).toBe(true);
  });

  it('expands blocks: rotation, scale, mirror, OCS, nested blocks, layer 0 inheritance, MINSERT', () => {
    const blocks: BlockDef[] = [
      { name: 'CUBE', base: [500, 500, 0], entities: cubeEdges(1000) },
      { name: 'FRAME', entities: [insert('CUBE', [2000, 0, 0]), line([0, 0, 0], [2000, 0, 0])] },
    ];
    const text = dxfText({
      blocks,
      entities: [
        insert('CUBE', [10000, 0, 0], { rot: 90, sx: 2, sy: 2, sz: 2, layer: 'A' }),
        insert('CUBE', [0, 10000, 0], { sx: -1, sz: 1.5, layer: 'B', attribs: true }),
        insert('FRAME', [0, 0, 5000], { rot: 90, layer: 'STEEL' }),
        insert('cube', [20000, 0, 0], { n: [0, -1, 0], layer: 'C' }),
        insert('CUBE', [0, 0, 0], { cols: 3, rows: 2, cs: 2000, rs: 3000, layer: 'ARRAY' }),
        line([0, 0, 0], [1, 1, 1], 'AFTER'),
      ],
    });
    const d = parseDxf(text);
    const on = (layer: string) => ({ ...d, segments: d.segments.filter((s) => s.layer === layer) });
    // A: rotated 90°, scaled ×2 about the base point (500,500,0).
    expect(on('A').segments).toHaveLength(12);
    expect(hasPoint(on('A'), [11000, -1000, 0])).toBe(true);
    expect(hasPoint(on('A'), [9000, 1000, 2000])).toBe(true);
    // B: mirrored in x, z ×1.5; its attributes are skipped, the following entities still read.
    expect(hasPoint(on('B'), [500, 9500, 0])).toBe(true);
    expect(hasPoint(on('B'), [-500, 10500, 1500])).toBe(true);
    // Nested: FRAME (rotated 90° at z 5000) holds CUBE at (2000,0,0) and a layer-0 line → layer STEEL.
    expect(on('STEEL').segments).toHaveLength(13);
    expect(hasPoint(on('STEEL'), [500, 1500, 5000])).toBe(true);
    expect(hasSeg(on('STEEL'), [0, 0, 5000], [0, 2000, 5000])).toBe(true);
    // Insert in a front-view OCS: block z → world −Y, block y → world Z (block names are case-insensitive).
    expect(hasPoint(on('C'), [20500, -1000, 500])).toBe(true);
    expect(hasPoint(on('C'), [19500, 0, -500])).toBe(true);
    // MINSERT 3 × 2.
    expect(on('ARRAY').segments).toHaveLength(12 * 6);
    expect(hasPoint(on('ARRAY'), [4500, 2500, 0])).toBe(true);
    expect(hasPoint(on('ARRAY'), [4500, 3500, 1000])).toBe(true);
    expect(hasPoint(on('ARRAY'), [-500, -500, 0])).toBe(true);
    expect(on('AFTER').segments).toHaveLength(1);
    expect(d.entities.INSERT.read).toBe(4 + 1); // 4 top-level + 1 nested
    expect(d.entities['INSERT (array)'].read).toBe(1);
    expect(d.is3d).toBe(true);
  });

  it('guards against missing and self-referencing blocks', () => {
    const text = dxfText({
      blocks: [{ name: 'LOOP', entities: [line([0, 0, 0], [100, 0, 0]), insert('LOOP', [0, 0, 100])] }],
      entities: [insert('LOOP', [0, 0, 0]), insert('MISSING', [0, 0, 0])],
    });
    const d = parseDxf(text);
    expect(d.segments).toHaveLength(1);
    expect(d.entities.INSERT.skipped).toBe(2);
    expect(d.notes.join(' ')).toMatch(/MISSING/);
    expect(d.notes.join(' ')).toMatch(/contains itself/);
  });

  it('turns ARCs (any extrusion) and bulges into chords within the tolerance', () => {
    const text = dxfText({
      entities: [
        // Mirrored 2D arc (N = 0,0,−1): OCS x → −X.
        arc([100, 0, 0], 50, 0, 90, [0, 0, -1], 'FLIP'),
        // Arc in a front-view OCS: centre (1000, 2000) at elevation 300 → world (1000, −300, 2000).
        arc([1000, 2000, 300], 500, 0, 180, [0, -1, 0], 'XZ'),
        // Semicircular bulge from (0,0) to (1000,0): CCW, so it dips to y = −500.
        lwpoly(
          [
            [0, 0, 1],
            [1000, 0],
          ],
          { layer: 'BULGE' },
        ),
      ],
    });
    const d = parseDxf(text);
    const on = (layer: string) => ({ ...d, segments: d.segments.filter((s) => s.layer === layer) });
    expect(hasPoint(on('FLIP'), [-150, 0, 0])).toBe(true);
    expect(hasPoint(on('FLIP'), [-100, 50, 0])).toBe(true);

    const xz = on('XZ');
    expect(hasPoint(xz, [1500, -300, 2000])).toBe(true);
    expect(hasPoint(xz, [500, -300, 2000])).toBe(true);
    expect(xz.segments.length).toBeGreaterThan(8);
    for (const s of xz.segments) {
      expect(s.a.y).toBeCloseTo(-300, 9);
      expect(s.a.z).toBeGreaterThanOrEqual(2000 - 1e-9);
      // Chord midpoint stays within 2 mm of the circle.
      const mid = { x: (s.a.x + s.b.x) / 2, z: (s.a.z + s.b.z) / 2 };
      expect(500 - Math.hypot(mid.x - 1000, mid.z - 2000)).toBeLessThanOrEqual(2 + 1e-9);
    }
    expect(Math.max(...xz.segments.map((s) => s.a.z))).toBeGreaterThan(2490);

    const b = on('BULGE');
    expect(hasPoint(b, [0, 0, 0])).toBe(true);
    expect(hasPoint(b, [1000, 0, 0])).toBe(true);
    expect(Math.min(...b.segments.map((s) => s.a.y))).toBeLessThan(-495);
    for (const s of b.segments) expect(Math.hypot(s.a.x - 500, s.a.y)).toBeCloseTo(500, 6);
    expect(d.is3d).toBe(true);

    // Arcs off: ARC skipped, bulge becomes its chord.
    const flat = parseDxf(text, { arcs: false });
    expect(flat.entities.ARC.skipped).toBe(2);
    expect(flat.segments).toHaveLength(1);

    // A closed two-vertex polyline with two semicircular bulges is a full circle.
    const ring = parseDxf(dxfText({ entities: [lwpoly([[0, 0, 1], [1000, 0, 1]], { closed: true })] }));
    expect(Math.min(...ring.segments.map((s) => s.a.y))).toBeLessThan(-495);
    expect(Math.max(...ring.segments.map((s) => s.a.y))).toBeGreaterThan(495);
    for (const s of ring.segments) expect(Math.hypot(s.a.x - 500, s.a.y)).toBeCloseTo(500, 6);
  });

  it('reads circles, splines and mesh edges only when asked, and reports skipped entities', () => {
    const cube = (i: number): Pt => [i & 1 ? 1000 : 0, i & 2 ? 1000 : 0, i & 4 ? 1000 : 0];
    const text = dxfText({
      entities: [
        circle([0, 0, 0], 100),
        [[0, 'TEXT'], [8, 'ANNO'], ...P3(10, [0, 0, 0]), [40, 100], [1, 'GRID A']],
        [[0, 'POINT'], [8, '0'], ...P3(10, [5, 5, 5])],
        [[0, '3DSOLID'], [8, '0'], [1, 'acis data']],
        [[0, 'LINE'], [8, '0'], [67, 1], ...P3(10, [0, 0, 0]), ...P3(11, [1, 0, 0])],
        // Two triangles sharing an edge → 5 edges; the hidden third edge of the second is dropped → 4.
        face3d([
          [0, 0, 0],
          [1000, 0, 0],
          [1000, 1000, 0],
        ]),
        face3d(
          [
            [0, 0, 0],
            [1000, 1000, 0],
            [0, 1000, 0],
          ],
          4,
        ),
        // Polyface cube: 8 vertices, 6 quads → 12 edges.
        poly(
          Array.from({ length: 8 }, (_, i) => cube(i)),
          {
            flags: 64,
            vflags: 192,
            layer: 'PFACE',
            faces: [
              [1, 2, 4, 3],
              [5, 6, 8, 7],
              [1, 2, 6, 5],
              [3, 4, 8, 7],
              [1, 3, 7, 5],
              [2, 4, 8, 6],
            ],
          },
        ),
        // Cubic B-spline with clamped knots.
        [
          [0, 'SPLINE'],
          [8, 'SPL'],
          [70, 8],
          [71, 3],
          [72, 8],
          [73, 4],
          [74, 0],
          ...[0, 0, 0, 0, 1, 1, 1, 1].map((k): Pair => [40, k]),
          ...P3(10, [0, 0, 0]),
          ...P3(10, [1000, 2000, 0]),
          ...P3(10, [3000, 2000, 0]),
          ...P3(10, [4000, 0, 0]),
        ],
      ],
    });
    const d = parseDxf(text);
    expect(d.segments).toHaveLength(0);
    expect(d.entities.CIRCLE.skipped).toBe(1);
    expect(Object.keys(d.entities.CIRCLE.reasons)[0]).toMatch(/Circles/);
    expect(d.entities.TEXT.skipped).toBe(1);
    expect(d.entities.POINT.skipped).toBe(1);
    expect(Object.keys(d.entities['3DSOLID'].reasons)[0]).toMatch(/ACIS/);
    expect(d.entities.LINE.reasons['paper space (layout)']).toBe(1);
    expect(d.entities['3DFACE'].skipped).toBe(2);
    expect(d.entities['POLYFACE MESH'].skipped).toBe(1);
    expect(d.entities.SPLINE.skipped).toBe(1);

    const all = parseDxf(text, { circles: true, meshEdges: true, splines: true });
    const on = (layer: string) => all.segments.filter((s) => s.layer === layer);
    expect(on('FACES')).toHaveLength(4);
    expect(on('PFACE')).toHaveLength(12);
    const spl = on('SPL');
    expect(spl.length).toBeGreaterThanOrEqual(8);
    expect(near(spl[0].a, [0, 0, 0])).toBe(true);
    expect(near(spl[spl.length - 1].b, [4000, 0, 0])).toBe(true);
    // Bezier midpoint (t = 0.5): (0 + 3·1000 + 3·3000 + 4000)/8 = 2000, y = 1500.
    expect(spl.some((s) => near(s.a, [2000, 1500, 0], 1e-6))).toBe(true);
    const circ = on('0').filter((s) => Math.abs(Math.hypot(s.a.x, s.a.y) - 100) < 1e-9);
    expect(circ.length).toBeGreaterThanOrEqual(4);
  });

  it('detects 3D drawings', () => {
    const flat = dxfText({ entities: [line([0, 0, 0], [1000, 0, 0]), arc([0, 0, 0], 100, 0, 90, [0, 0, -1]), lwpoly([[0, 0], [10, 10]])] });
    expect(parseDxf(flat).is3d).toBe(false);
    const elevated = dxfText({ entities: [line([0, 0, 300], [1000, 0, 300]), lwpoly([[0, 0], [10, 10]], { elevation: 300 })] });
    expect(parseDxf(elevated).is3d).toBe(false);
    expect(parseDxf(dxfText({ entities: [line([0, 0, 0], [0, 0, 1000])] })).is3d).toBe(true);
    // Flat in world Z, but drawn in a tilted OCS.
    expect(parseDxf(dxfText({ entities: [lwpoly([[0, 0], [1000, 0]], { n: [0, -1, 0] })] })).is3d).toBe(true);
  });

  it('reads units from $INSUNITS with a $MEASUREMENT fallback', () => {
    const at = (o: { insunits?: number; measurement?: number }) => parseDxf(dxfText({ ...o, entities: [line([0, 0, 0], [1, 0, 2])] }));
    expect(at({ insunits: 6 }).unitScale).toBe(1000);
    expect(at({ insunits: 14 }).unitScale).toBe(100);
    expect(at({ insunits: 10 }).unitScale).toBe(914.4);
    expect(at({ insunits: 2 }).unitScale).toBe(304.8);
    expect(at({ insunits: 0, measurement: 0 })).toMatchObject({ unitScale: 25.4, unitSource: 'measurement' });
    expect(at({ measurement: 1 })).toMatchObject({ unitScale: 1, unitSource: 'measurement' });
    expect(at({})).toMatchObject({ unitScale: 1, unitSource: 'none' });
    expect(dxfUnitScale(14)).toBe(100);
    expect(dxfUnitScale(10)).toBe(914.4);
    expect(dxfUnitScale(3)).toBe(1);

    const d = at({ insunits: 6 });
    const p = createProject();
    importDxfWireframe(p, d, opts3d({ scale: d.unitScale }));
    expect(hasNode(p, [1000, 0, 2000])).toBe(true);
  });
});

describe('DXF 3D wireframe: joining and splitting', () => {
  const imp = (entities: Pair[][], o: Partial<DxfImportOptions> = {}) => {
    const p = createProject();
    const ids = importDxfWireframe(p, parseDxf(dxfText({ entities })), opts3d(o));
    return { p, ids, members: Object.keys(p.members).length, nodes: Object.keys(p.nodes).length };
  };

  it('joins endpoints within the tolerance', () => {
    const ents = [line([0, 0, 0], [1000, 0, 0]), line([1000.8, 0.6, 0], [1000, 1000, 500])];
    expect(imp(ents)).toMatchObject({ members: 2, nodes: 3 });
    expect(imp(ents, { joinTolerance: 0.5 })).toMatchObject({ members: 2, nodes: 4 });
  });

  it('snaps to existing model nodes and reuses existing lines', () => {
    const p = createProject();
    const parsed = parseDxf(dxfText({ entities: [line([0, 0, 0], [1000, 0, 0])] }));
    importDxfWireframe(p, parsed, opts3d());
    const again = parseDxf(dxfText({ entities: [line([0.5, 0, 0], [1000, 0, 1]), line([1000, 0, 0], [1000, 0, 1000])] }));
    const ids = importDxfWireframe(p, again, opts3d());
    expect(ids).toHaveLength(2);
    expect(Object.keys(p.members)).toHaveLength(2);
    expect(Object.keys(p.nodes)).toHaveLength(3);
  });

  it('drops duplicates and merges overlapping collinear lines', () => {
    const base = [
      line([0, 0, 0], [3000, 0, 0]),
      line([1000, 0, 0], [4000, 0, 0]),
      line([3000, 0, 0], [0, 0, 0]),
      line([0, 0, 0], [500, 0, 0]),
      line([0, 0, 0], [0, 0, 0]),
    ];
    const one = imp(base, { splitIntersections: false });
    expect(one).toMatchObject({ members: 1, nodes: 2 });
    expect(hasNode(one.p, [4000, 0, 0])).toBe(true);
    // A line attached at an interior end keeps that node.
    const attached = imp([...base, line([3000, 0, 0], [3000, 0, 1000])], { splitIntersections: false });
    expect(attached).toMatchObject({ members: 3, nodes: 4 });
    // Overlap on a diagonal in 3D, off by 0.3 mm.
    const diag = imp([line([0, 0, 0], [3000, 3000, 3000]), line([1000, 1000.3, 1000], [4000, 4000, 4000])], { splitIntersections: false });
    expect(diag).toMatchObject({ members: 1, nodes: 2 });
  });

  it('splits at true 3D crossings but not at skew lines that only cross in a projection', () => {
    expect(imp([line([0, 0, 0], [1000, 0, 0]), line([500, -500, 0], [500, 500, 0])])).toMatchObject({ members: 4, nodes: 5 });
    // 100 mm apart in Z: crossing in plan only.
    expect(imp([line([0, 0, 0], [1000, 0, 0]), line([500, -500, 100], [500, 500, 100])])).toMatchObject({ members: 2, nodes: 4 });
    // Diagonal X-bracing in a vertical bay crosses at its centre.
    const x = imp([line([0, 0, 0], [3000, 0, 3000]), line([3000, 0, 0], [0, 0, 3000])]);
    expect(x).toMatchObject({ members: 4, nodes: 5 });
    expect(hasNode(x.p, [1500, 0, 1500], 1e-6)).toBe(true);
    // Within the tolerance (1 mm apart) still counts as a crossing.
    expect(imp([line([0, 0, 0], [1000, 0, 0]), line([500, -500, 1], [500, 500, 1])])).toMatchObject({ members: 4, nodes: 5 });
    // T-junction with a 1 mm gap.
    expect(imp([line([0, 0, 0], [1000, 0, 0]), line([400, 1, 0], [400, 800, 0])])).toMatchObject({ members: 3, nodes: 4 });
    // Splitting off.
    expect(imp([line([0, 0, 0], [1000, 0, 0]), line([500, -500, 0], [500, 500, 0])], { splitIntersections: false })).toMatchObject({ members: 2, nodes: 4 });
  });

  it('keeps 2D placement on a work plane and applies layer rules', () => {
    const p = createProject();
    const d = parseDxf(dxfText({ entities: [line([0, 0, 0], [1000, 0, 0], 'MULLION'), line([0, 0, 0], [0, 2000, 0], 'MULLION')] }));
    expect(d.is3d).toBe(false);
    importDxfWireframe(p, d, {
      ...opts3d({ use3d: false, plane: { kind: 'YZ', offset: 250 }, offset: { x: 10, y: 20 } }),
      layerRules: { MULLION: { profile: 'SHS 100x100x5', role: 'mullion' } },
    });
    expect(nodes(p).every((n) => n.x === 250)).toBe(true);
    expect(hasNode(p, [250, 1010, 20])).toBe(true);
    expect(hasNode(p, [250, 10, 2020])).toBe(true);
    expect(Object.values(p.members).every((m) => m.profile === 'SHS 100x100x5' && m.role === 'mullion' && m.layer === 'MULLION')).toBe(true);
  });

  it('previews counts without touching a project', () => {
    const d = parseDxf(dxfText({ entities: [line([0, 0, 0], [1000, 0, 0]), line([500, -500, 0], [500, 500, 0]), line([0, 0, 0], [1000, 0, 0])] }));
    const r = previewDxfImport(d, opts3d());
    expect(r.stats).toMatchObject({ input: 3, duplicates: 1, edges: 4, nodes: 5 });
  });
});

describe('DXF 3D wireframe: performance', () => {
  it('parses, joins and splits a 20k-segment 3D lattice in a few seconds', () => {
    // 30 × 30 × 8 nodes, neighbours joined, endpoints jittered by up to 0.6 mm,
    // X-bracing in every bay of the y = 0 face, and 1000 duplicated lines.
    const nx = 30;
    const ny = 30;
    const nz = 8;
    const step = 1500;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6;
    const at = (i: number, j: number, k: number, jitter = true): Pt => [i * step + (jitter ? rnd() : 0), j * step + (jitter ? rnd() : 0), k * 1200 + (jitter ? rnd() : 0)];
    const ents: Pair[][] = [];
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++) {
          if (i + 1 < nx) ents.push(line(at(i, j, k), at(i + 1, j, k), 'X'));
          if (j + 1 < ny) ents.push(line(at(i, j, k), at(i, j + 1, k), 'Y'));
          if (k + 1 < nz) ents.push(line(at(i, j, k), at(i, j, k + 1), 'Z'));
        }
    const grid = ents.length;
    for (let i = 0; i + 1 < nx; i++)
      for (let k = 0; k + 1 < nz; k++) {
        ents.push(line(at(i, 0, k, false), at(i + 1, 0, k + 1, false), 'BRACE'));
        ents.push(line(at(i + 1, 0, k, false), at(i, 0, k + 1, false), 'BRACE'));
      }
    const braces = ents.length - grid;
    for (let n = 0; n < 1000; n++) ents.push(ents[n * 7]);
    const text = dxfText({ insunits: 4, entities: ents });

    const t0 = performance.now();
    const d = parseDxf(text);
    const t1 = performance.now();
    const p = createProject();
    const ids = importDxfWireframe(p, d, opts3d());
    const t2 = performance.now();
    expect(d.segments.length).toBe(grid + braces + 1000);
    expect(d.segments.length).toBeGreaterThan(20_000);
    expect(ids).toHaveLength(grid + braces * 2);
    expect(Object.keys(p.nodes)).toHaveLength(nx * ny * nz + braces / 2);
    // Generous bound for slow CI machines; typically well under a second.
    expect(t2 - t0).toBeLessThan(10_000);
    console.info(`20k DXF: parse ${(t1 - t0).toFixed(0)} ms, join + split ${(t2 - t1).toFixed(0)} ms`);
  });

  it('joins 20k loose segments directly', () => {
    const segs = Array.from({ length: 20_000 }, (_, i) => {
      const x = (i % 200) * 1000;
      const z = Math.floor(i / 200) * 1000;
      return { a: { x, y: 0, z }, b: { x: x + 1000.4, y: 0.3, z }, layer: 'L' };
    });
    const t0 = performance.now();
    const r = joinSegments(segs, { tolerance: 2, split: true });
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(r.stats.edges).toBe(20_000);
    expect(r.stats.nodes).toBe(201 * 100);
  });
});
