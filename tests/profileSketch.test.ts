import { describe, expect, it } from 'vitest';
import {
  circleLoop,
  emptySketch,
  filletCorners,
  insertionPreset,
  loopId,
  mirrorSketch,
  parseCoord,
  pickVertex,
  rectLoop,
  setFillet,
  shapeProps,
  sketchFromDef,
  sketchToDef,
  sketchToShape,
  snapPoint,
  thinWallLoops,
  type Sketch,
  type SketchLoop,
} from '../src/core/library/sketch';
import { bulgeArc, bulgeThrough, flattenLoop, loopArea, loopBox, reverseLoop, validateLoops } from '../src/core/library/polyShape';
import { sectionProps, shapeBox, shapeOutline, type PolyShape } from '../src/core/library/shapes';
import { getProfile, profileFromDef } from '../src/core/library/profiles';

const poly = (outer: { x: number; y: number; b?: number }[], holes: { x: number; y: number; b?: number }[][] = []): PolyShape => ({ type: 'POLY', outer, ...(holes.length ? { holes } : {}) });
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const sk = (...loops: SketchLoop[]): Sketch => ({ version: 1, loops, insertion: { x: 0, y: 0 } });

describe('polygon section properties', () => {
  it('rectangle matches the closed-form values', () => {
    // 100 wide (section x = member local y), 50 high (local z), drawn off-centre.
    const s = poly(rect(20, 10, 120, 60));
    const p = sectionProps(s);
    expect(p.area).toBeCloseTo(5000, 6);
    expect(p.Iy).toBeCloseTo((100 * 50 ** 3) / 12, 3);
    expect(p.Iz).toBeCloseTo((50 * 100 ** 3) / 12, 3);
    expect(p.Wy).toBeCloseTo((100 * 50 ** 2) / 6, 3);
    expect(p.Wz).toBeCloseTo((50 * 100 ** 2) / 6, 3);
    expect(p.iy).toBeCloseTo(50 / Math.sqrt(12), 6);
    expect(p.surface).toBeCloseTo(0.3, 9);
    expect(p.Wply).toBeCloseTo((100 * 50 ** 2) / 4, 3);
    expect(p.cy).toBe(0);
    expect(shapeBox(s)).toEqual({ w: 100, h: 50 });
    // Outline centred on the bounding box like every other shape.
    expect(loopBox(shapeOutline(s).outer)).toEqual({ minX: -50, minY: -25, maxX: 50, maxY: 25 });
  });

  it('hollow rectangle (outer + void) matches the closed-form values', () => {
    const s = poly(rect(-50, -30, 50, 30), [rect(-40, -20, 40, 20)]);
    const p = sectionProps(s);
    expect(p.area).toBeCloseTo(6000 - 3200, 6);
    expect(p.Iy).toBeCloseTo((100 * 60 ** 3 - 80 * 40 ** 3) / 12, 3);
    expect(p.Iz).toBeCloseTo((60 * 100 ** 3 - 40 * 80 ** 3) / 12, 3);
    expect(p.Wy).toBeCloseTo((100 * 60 ** 3 - 80 * 40 ** 3) / 12 / 30, 3);
    // Outer perimeter only (inside of hollow sections is not painted).
    expect(p.surface).toBeCloseTo(0.32, 9);
    // The hole direction does not matter.
    const q = sectionProps(poly(rect(-50, -30, 50, 30), [reverseLoop(rect(-40, -20, 40, 20))]));
    expect(q.area).toBeCloseTo(p.area, 6);
  });

  it('an I section drawn as an outline matches the parametric IPE 200 within 1 %', () => {
    const ipe = getProfile('IPE 200')!;
    const s = ipe.shape as { h: number; b: number; tw: number; tf: number; r: number };
    const X = s.b / 2;
    const Y = s.h / 2;
    const w = s.tw / 2;
    const pts = [
      { x: -X, y: -Y },
      { x: X, y: -Y },
      { x: X, y: -Y + s.tf },
      { x: w, y: -Y + s.tf, r: s.r },
      { x: w, y: Y - s.tf, r: s.r },
      { x: X, y: Y - s.tf },
      { x: X, y: Y },
      { x: -X, y: Y },
      { x: -X, y: Y - s.tf },
      { x: -w, y: Y - s.tf, r: s.r },
      { x: -w, y: -Y + s.tf, r: s.r },
      { x: -X, y: -Y + s.tf },
    ];
    const outline = poly(filletCorners(pts, true));
    const a = sectionProps(outline);
    const b = sectionProps(ipe.shape);
    expect(rel(a.area, b.area)).toBeLessThan(0.01);
    expect(rel(a.Iy, b.Iy)).toBeLessThan(0.01);
    expect(rel(a.Iz, b.Iz)).toBeLessThan(0.01);
    expect(rel(a.Wy, b.Wy)).toBeLessThan(0.01);
    // And against the catalogue mass (22.4 kg/m): within 2 %.
    expect(rel((a.area * 7850) / 1e6, ipe.mass)).toBeLessThan(0.02);
  });

  it('arcs: a bulge circle has the area of a circle and its exact bounding box', () => {
    const s = poly(circleLoop({ x: 5, y: 7 }, 30));
    expect(rel(sectionProps(s).area, Math.PI * 900)).toBeLessThan(1e-4);
    expect(rel(loopArea(s.outer), Math.PI * 900)).toBeLessThan(1e-12);
    expect(shapeBox(s).w).toBeCloseTo(60, 9);
    expect(shapeBox(s).h).toBeCloseTo(60, 9);
    const a = bulgeArc({ x: 1, y: 0 }, { x: -1, y: 0 }, 1)!;
    expect(a.r).toBeCloseTo(1, 12);
    expect(a.c.x).toBeCloseTo(0, 12);
    expect(a.c.y).toBeCloseTo(0, 12);
    // Three-point bulge: through the top is counter-clockwise from (1, 0) to (−1, 0).
    expect(bulgeThrough({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })).toBeCloseTo(1, 12);
    expect(bulgeThrough({ x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 })).toBeCloseTo(-1, 12);
  });

  it('validates closed, simple loops with holes inside', () => {
    expect(validateLoops(rect(0, 0, 10, 10), [])).toBeNull();
    expect(validateLoops([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 5 }], [])).toMatch(/crosses itself/);
    expect(validateLoops(rect(0, 0, 10, 10), [rect(20, 20, 30, 30)])).toMatch(/not inside/);
    expect(validateLoops(rect(0, 0, 10, 10), [rect(5, 5, 12, 8)])).toMatch(/not inside/);
    expect(validateLoops(rect(0, 0, 100, 100), [rect(10, 10, 50, 50), rect(40, 40, 60, 60)])).toMatch(/overlap/);
    expect(validateLoops([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], [])).toMatch(/no area/);
    expect(() => profileFromDef({ name: 'Bad', shape: poly(rect(0, 0, 10, 10), [rect(20, 20, 30, 30)]) })).toThrow(/not inside/);
  });
});

describe('thin-wall generator and fillets', () => {
  it('turns a centre line into an outline of thickness t (mitred corners, square ends)', () => {
    // Channel 50 × 100 × 50 centre line, t = 2.
    const w = thinWallLoops([{ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }], false, 2);
    expect(w.holes).toEqual([]);
    expect(Math.abs(loopArea(w.outer))).toBeCloseTo(2 * 200, 6);
    expect(loopBox(flattenLoop(w.outer))).toEqual({ minX: -1, minY: -1, maxX: 50, maxY: 101 });
  });

  it('adds inner bend radius r and outer r + t at the bends', () => {
    const t = 2;
    const r = 2;
    const w = thinWallLoops([{ x: 50, y: 0 }, { x: 0, y: 0, r }, { x: 0, y: 100, r }, { x: 50, y: 100 }], false, t);
    // Area = t × centre-line length: each bend replaces 2·(r + t/2) of straight by a quarter circle of radius r + t/2.
    const rc = r + t / 2;
    const L = 200 - 2 * (2 * rc - (Math.PI / 2) * rc);
    expect(Math.abs(loopArea(w.outer))).toBeCloseTo(t * L, 6);
    const p = sectionProps({ type: 'POLY', outer: w.outer });
    expect(rel(p.area, t * L)).toBeLessThan(2e-4);
    // Outer corner radius r + t: the box is unchanged.
    expect(loopBox(flattenLoop(w.outer))).toEqual({ minX: -1, minY: -1, maxX: 50, maxY: 101 });
  });

  it('closed centre line gives an outer loop and a void', () => {
    const w = thinWallLoops(rect(0, 0, 100, 100), true, 4);
    expect(w.holes.length).toBe(1);
    expect(Math.abs(loopArea(w.outer))).toBeCloseTo(104 * 104, 6);
    expect(Math.abs(loopArea(w.holes[0]))).toBeCloseTo(96 * 96, 6);
    const s = sketchToShape(sk({ id: 'w', kind: 'wall', pts: rect(0, 0, 100, 100), closed: true, t: 4 }));
    expect(s.errors).toEqual([]);
    expect(s.shape!.t).toBe(4);
    expect(sectionProps(s.shape!).area).toBeCloseTo(104 * 104 - 96 * 96, 6);
  });

  it('fillets a corner with an exact tangent arc', () => {
    const r = 10;
    const out = filletCorners(rect(0, 0, 100, 100).map((p) => ({ ...p, r })), true);
    expect(out.length).toBe(8);
    expect(loopArea(out)).toBeCloseTo(100 * 100 - 4 * (r * r - (Math.PI * r * r) / 4), 6);
    expect(loopBox(flattenLoop(out))).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    // Radius too large for the edges is reduced so the tangent points stay on them.
    const big = filletCorners(rect(0, 0, 10, 10).map((p) => ({ ...p, r: 50 })), true);
    expect(validateLoops(big, [])).toBeNull();
    // setFillet on a sketch vertex.
    const s0 = sk({ id: 'a', kind: 'poly', role: 'outer', pts: rect(0, 0, 100, 50) });
    const s1 = setFillet(s0, 'a', 2, 5);
    expect(sectionProps(sketchToShape(s1).shape!).area).toBeCloseTo(5000 - (25 - (Math.PI * 25) / 4), 2);
  });
});

describe('sketch edits, input and snapping', () => {
  it('mirrors a half section about an axis into a symmetric one', () => {
    // Half hat: the wall starts on the axis x = 0.
    const s = mirrorSketch(sk({ id: 'w', kind: 'wall', pts: [{ x: 0, y: 0 }, { x: -30, y: 0 }, { x: -30, y: 40 }], closed: false, t: 2 }), { axis: 'x', at: 0 });
    expect(s.loops.length).toBe(1);
    const w = s.loops[0] as Extract<SketchLoop, { kind: 'wall' }>;
    expect(w.pts.map((p) => [p.x, p.y])).toEqual([
      [-30, 40],
      [-30, 0],
      [0, 0],
      [30, 0],
      [30, 40],
    ]);
    // Half rectangle with an edge on the axis becomes the full rectangle.
    const r = mirrorSketch(sk({ id: 'p', kind: 'poly', role: 'outer', pts: rect(0, 0, 50, 20) }), { axis: 'x', at: 0 });
    expect(r.loops.length).toBe(1);
    expect(sectionProps(sketchToShape(r).shape!).area).toBeCloseTo(2000, 6);
    expect(shapeBox(sketchToShape(r).shape!).w).toBeCloseTo(100, 9);
    // A hole off the axis is copied; a centred one is not.
    const h = mirrorSketch(
      sk(
        { id: 'o', kind: 'poly', role: 'outer', pts: rect(-50, 0, 50, 40) },
        { id: 'h', kind: 'circle', role: 'hole', c: { x: 20, y: 20 }, r: 5 },
        { id: 'c', kind: 'circle', role: 'hole', c: { x: 0, y: 20 }, r: 5 },
      ),
      { axis: 'x', at: 0 },
    );
    expect(h.loops.filter((l) => l.kind === 'circle').length).toBe(3);
    expect(h.loops.filter((l) => l.kind === 'poly').length).toBe(1);
    // A half disc on the axis (arc segment clockwise through (10, 0)) becomes the full disc.
    const half = mirrorSketch(sk({ id: 'd', kind: 'poly', role: 'outer', pts: [{ x: 0, y: -10 }, { x: 0, y: 10, b: -1 }] }), { axis: 'x', at: 0 });
    const disc = sketchToShape(half).shape!;
    expect(rel(loopArea(disc.outer), Math.PI * 100)).toBeLessThan(1e-12);
    expect(shapeBox(disc).w).toBeCloseTo(20, 9);
  });

  it('parses typed coordinates: absolute, relative and polar', () => {
    expect(parseCoord('10,20', null)).toEqual({ x: 10, y: 20 });
    expect(parseCoord('10 20', null)).toEqual({ x: 10, y: 20 });
    expect(parseCoord('@5,-5', { x: 10, y: 20 })).toEqual({ x: 15, y: 15 });
    const p = parseCoord('@10<90', { x: 1, y: 2 })!;
    expect(p.x).toBeCloseTo(1, 12);
    expect(p.y).toBeCloseTo(12, 12);
    const q = parseCoord('100<0', { x: 50, y: 50 })!;
    expect(q).toEqual({ x: 100, y: 0 });
    expect(parseCoord('abc', null)).toBeNull();
    expect(parseCoord('1,2,3', null)).toBeNull();
  });

  it('snaps to vertices, midpoints, axes and the grid', () => {
    const s = sk({ id: 'a', kind: 'poly', role: 'outer', pts: rect(0, 0, 100, 50) });
    expect(snapPoint({ x: 99, y: 49 }, s, { grid: 5, tol: 3 })).toEqual({ p: { x: 100, y: 50 }, kind: 'vertex' });
    expect(snapPoint({ x: 51, y: 1 }, s, { grid: 5, tol: 3 })).toEqual({ p: { x: 50, y: 0 }, kind: 'midpoint' });
    expect(snapPoint({ x: 33.2, y: 21.9 }, s, { grid: 5, tol: 1 })).toEqual({ p: { x: 35, y: 20 }, kind: 'grid' });
    expect(snapPoint({ x: 0.4, y: 31.7 }, sk(), { grid: 0, tol: 1 }).p).toEqual({ x: 0, y: 31.7 });
    expect(snapPoint({ x: 61.3, y: 50.4 }, sk(), { grid: 0, tol: 1, from: { x: 0, y: 50 } })).toEqual({ p: { x: 61.3, y: 50 }, kind: 'ortho' });
    expect(pickVertex(s, { x: 1, y: 49 }, 2)).toEqual({ id: 'a', i: 3 });
  });

  it('sets the insertion point from the 9 box points or the centroid', () => {
    const shape = sketchToShape(sk({ id: 'l', kind: 'wall', pts: [{ x: 0, y: 60 }, { x: 0, y: 0 }, { x: 40, y: 0 }], closed: false, t: 4 })).shape!;
    expect(insertionPreset(shape, 'tl')).toEqual({ x: -2, y: 60 });
    expect(insertionPreset(shape, 'br')).toEqual({ x: 40, y: -2 });
    expect(insertionPreset(shape, 'mc')).toEqual({ x: 19, y: 29 });
    const c = insertionPreset(shape, 'centroid');
    const props = shapeProps(shape);
    expect(c.x).toBeCloseTo(props.centroid.x, 9);
    // The centroid of an angle lies towards its heel.
    expect(c.x).toBeLessThan(19);
    expect(c.y).toBeLessThan(29);
  });

  it('reports validation messages', () => {
    expect(sketchToShape(sk()).errors[0]).toMatch(/Draw the outline/);
    expect(sketchToShape(sk({ id: 'a', kind: 'poly', role: 'outer', pts: rect(0, 0, 10, 10) }, { id: 'b', kind: 'poly', role: 'outer', pts: rect(20, 0, 30, 10) })).errors[0]).toMatch(/2 outer loops/);
    expect(sketchToShape(sk({ id: 'a', kind: 'poly', role: 'outer', pts: rect(0, 0, 10, 10) }, { id: 'h', kind: 'circle', role: 'hole', c: { x: 50, y: 50 }, r: 2 })).errors[0]).toMatch(/not inside/);
    const far = { ...sk({ id: 'a', kind: 'poly', role: 'outer', pts: rect(0, 0, 10, 10) }), insertion: { x: 500, y: 0 } };
    expect(sketchToShape(far).warnings[0]).toMatch(/far outside/);
    expect(sketchToShape({ ...far, insertion: null }).warnings[0]).toMatch(/3×3 grid/);
  });

  it('saves a sketch as a profile definition and opens it again', () => {
    const s: Sketch = {
      ...emptySketch(),
      loops: [
        { id: loopId(), kind: 'wall', pts: [{ x: 25, y: 0 }, { x: 0, y: 0, r: 3 }, { x: 0, y: 80, r: 3 }, { x: 25, y: 80 }], closed: false, t: 2.5 },
        { id: loopId(), kind: 'circle', role: 'outer', c: { x: 0, y: 0 }, r: 1 },
      ],
    };
    expect(() => sketchToDef(s, { name: 'X' })).toThrow(/2 outer loops/);
    s.loops.pop();
    s.insertion = { x: -1.25, y: 40 };
    const def = sketchToDef(s, { name: ' Alu C 80 ', family: 'Aluminium', material: '6063 T6' });
    expect(def.name).toBe('Alu C 80');
    expect(def.insertion).toEqual({ x: -1.25, y: 40 });
    const prof = profileFromDef(def);
    expect(prof.material).toBe('6063 T6');
    // Insertion point relative to the box centre (box x −1.25 … 25, y −1.25 … 81.25).
    expect(prof.insertion!.x).toBeCloseTo(-1.25 - (25 - 1.25) / 2, 9);
    expect(prof.insertion!.y).toBeCloseTo(0, 9);
    const back = sketchFromDef(def)!;
    expect(back.loops[0].kind).toBe('wall');
    expect(back.insertion).toEqual({ x: -1.25, y: 40 });
    // A profile without a stored sketch opens as editable polygons.
    const plain = sketchFromDef({ shape: def.shape, insertion: def.insertion })!;
    expect(plain.loops.length).toBe(1);
    expect(sectionProps(sketchToShape(plain).shape!).area).toBeCloseTo(sectionProps(def.shape).area, 6);
    expect(sketchFromDef({ shape: { type: 'RD', d: 10 } })).toBeNull();
    expect(rectLoop({ x: 5, y: 5 }, { x: 0, y: 0 })).toEqual(rect(0, 0, 5, 5));
  });
});
