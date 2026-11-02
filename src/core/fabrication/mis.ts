/**
 * Export for fabrication MIS / ERP systems: one JSON document (schema
 * "facadesteel.mis", version 1 — described in docs/FABRICATION.md) and the same
 * content as a flat CSV set (parts, assemblies, bolts, operations, welds, coatings).
 */
import type { EndPrep, Project } from '../model/types';
import { polygonPerimeter } from '../model/geometry';
import { uniqueAssemblies, uniqueParts, type DerivedModel, type Part } from '../derive/model';
import type { EndCut } from '../geometry/endPrep';
import { toCsv, type Row } from '../reports/bom';
import { assemblyBatchId, assemblyPhaseId, batchName, connectionBatchId, partBatchId, phaseName } from './batches';
import { assemblyDims, partDims, weldJoints, type Dims } from './geometry';
import { boltSetMass } from './packing';

export const MIS_SCHEMA = 'facadesteel.mis';
export const MIS_VERSION = 1;

export interface MisCut {
  kind: string;
  /** Saw angles from square, degrees (web / side view, flange / top view). */
  angleWeb: number;
  angleFlange: number;
  copeDepth?: number;
  copeLength?: number;
}

export interface MisPart {
  mark: string;
  qty: number;
  type: Part['kind'];
  name: string;
  profile: string;
  material: string;
  finish: string;
  /** Linear parts: cut length; plates: bounding width × height × thickness. */
  length: number;
  width: number;
  thickness: number;
  dims: Dims;
  unitMass: number;
  unitArea: number;
  assemblies: string[];
  batches: { batch: string; qty: number }[];
  holes: { count: number; round: { d: number; qty: number }[]; slots: { d: number; length: number; qty: number }[] };
  cuts?: { start: MisCut; end: MisCut };
  /** Plates: cut contour length, mm. */
  contourLength?: number;
}

export interface MisAssembly {
  mark: string;
  qty: number;
  main: string;
  parts: { mark: string; qty: number }[];
  unitMass: number;
  dims: Dims;
  finish: string;
  batches: { batch: string; qty: number }[];
  phases: string[];
}

export interface MisBolt {
  batch: string;
  kind: 'bolt' | 'anchor';
  size: string;
  grade: string;
  length: number;
  qty: number;
  unitMassEstimate: number;
}

export type MisOpType = 'saw' | 'cope' | 'thermal-cut' | 'drill' | 'slot' | 'mark' | 'galvanize' | 'paint';

export interface MisOperation {
  part: string;
  seq: number;
  op: MisOpType;
  qty: number;
  end?: 'start' | 'end';
  d?: number;
  length?: number;
  angleWeb?: number;
  angleFlange?: number;
  detail: string;
}

export interface MisWeld {
  assembly: string;
  partA: string;
  partB: string;
  type: 'fillet';
  /** Throat (ISO) or leg (ASME) size from the drawing settings, mm. */
  size: number;
  /** Estimated length per assembly, mm (null = not computed). */
  length: number | null;
}

export interface MisCoating {
  assembly: string;
  qty: number;
  finish: string;
  /** Surface area per assembly by finish, m². */
  areaEach: number;
  areaTotal: number;
}

export interface MisExport {
  schema: typeof MIS_SCHEMA;
  version: typeof MIS_VERSION;
  generated: string;
  units: { length: 'mm'; mass: 'kg'; area: 'm2'; angle: 'deg' };
  project: { id: string; name: string; number: string; client: string; designer: string };
  phases: { id: string; name: string; sequence: number }[];
  batches: { id: string; name: string; date?: string; phase?: string }[];
  parts: MisPart[];
  assemblies: MisAssembly[];
  bolts: MisBolt[];
  operations: MisOperation[];
  welds: MisWeld[];
  coatings: MisCoating[];
  totals: { parts: number; assemblies: number; mass: number; bolts: number };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A part's resolved end cut (end preparations, connection fits, auto-cut): kind, saw angles and the first cope. */
function fromCut(c: EndCut): MisCut {
  const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
  const out: MisCut = { kind: c.kind, angleWeb: r2(c.angleWeb), angleFlange: r2(c.angleFlange) };
  if (c.copes[0]) {
    out.copeDepth = Math.round(c.copes[0].depth * 10) / 10;
    out.copeLength = Math.round(c.copes[0].length * 10) / 10;
  }
  return out;
}

function cutOf(prep: EndPrep | undefined): MisCut {
  if (!prep) return { kind: 'square', angleWeb: 0, angleFlange: 0 };
  const c: MisCut = { kind: prep.kind, angleWeb: prep.angleWeb ?? 0, angleFlange: prep.angleFlange ?? 0 };
  if (prep.kind === 'cope') {
    c.copeDepth = prep.copeDepth;
    c.copeLength = prep.copeLength;
  }
  return c;
}

const countBy = (keys: string[]) => {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].map(([batch, qty]) => ({ batch, qty }));
};

function holesOf(part: Part): MisPart['holes'] {
  const list =
    part.kind === 'plate'
      ? (part.plateHoles ?? []).map((h) => ({ d: h.d, slot: h.slot ?? 0 }))
      : part.holes.map((h) => ({ d: h.d, slot: h.slot ?? 0 }));
  const round = new Map<number, number>();
  const slots = new Map<string, { d: number; length: number; qty: number }>();
  for (const h of list) {
    if (h.slot > 0) {
      const length = r1(h.d + h.slot);
      const k = `${h.d}|${length}`;
      const e = slots.get(k) ?? { d: h.d, length, qty: 0 };
      e.qty++;
      slots.set(k, e);
    } else round.set(h.d, (round.get(h.d) ?? 0) + 1);
  }
  return { count: list.length, round: [...round].map(([d, qty]) => ({ d, qty })).sort((a, b) => a.d - b.d), slots: [...slots.values()] };
}

export function misExport(p: Project, dm: DerivedModel): MisExport {
  const parts: MisPart[] = [];
  const operations: MisOperation[] = [];
  for (const { part, qty, refs } of uniqueParts(dm)) {
    const pieces = refs.map((r) => dm.partByRef.get(r)!);
    const member = part.memberId ? p.members[part.memberId] : undefined;
    const holes = holesOf(part);
    const mp: MisPart = {
      mark: part.mark,
      qty,
      type: part.kind,
      name: part.name,
      profile: part.profile,
      material: part.material,
      finish: part.finish,
      length: r1(part.length),
      width: r1(part.width),
      thickness: part.thickness,
      dims: partDims(part).map(r1) as Dims,
      unitMass: r3(part.mass),
      unitArea: r3(part.surface),
      assemblies: [...new Set(pieces.map((x) => x.assembly))].sort(),
      batches: countBy(pieces.map((x) => batchName(p, partBatchId(p, x)))),
      holes,
    };
    let seq = 0;
    const op = (o: Omit<MisOperation, 'part' | 'seq'>) => operations.push({ part: part.mark, seq: (seq += 10), ...o });
    if (part.kind === 'plate') {
      mp.contourLength = r1(polygonPerimeter(part.outline ?? []));
      op({ op: 'thermal-cut', qty: 1, length: mp.contourLength, detail: `PL${part.thickness} ${Math.round(part.length)}×${Math.round(part.width)} contour` });
    } else {
      // The cuts as derived (they include connection fits and the auto-cut); else the member's own preparations.
      mp.cuts = part.ends ? { start: fromCut(part.ends.start), end: fromCut(part.ends.end) } : { start: cutOf(member?.startPrep), end: cutOf(member?.endPrep) };
      for (const end of ['start', 'end'] as const) {
        const c = mp.cuts[end];
        op({ op: 'saw', qty: 1, end, angleWeb: c.angleWeb, angleFlange: c.angleFlange, length: mp.length, detail: `${end} ${c.kind}${c.angleWeb || c.angleFlange ? ` web ${c.angleWeb}°, flange ${c.angleFlange}°` : ' 90°'}` });
        if (c.kind === 'cope' || c.copeDepth) op({ op: 'cope', qty: 1, end, length: c.copeLength, d: c.copeDepth, detail: `cope ${c.copeDepth ?? 0} deep × ${c.copeLength ?? 0} long` });
      }
    }
    for (const h of holes.round) op({ op: 'drill', qty: h.qty, d: h.d, detail: `Ø${h.d}` });
    for (const s of holes.slots) op({ op: 'slot', qty: s.qty, d: s.d, length: s.length, detail: `Ø${s.d} × ${s.length} overall` });
    op({ op: 'mark', qty: 1, detail: part.mark });
    if (part.finish === 'hdg' || part.finish === 'hdg+paint') op({ op: 'galvanize', qty: 1, detail: 'hot-dip galvanize' });
    if (part.finish === 'paint' || part.finish === 'hdg+paint') op({ op: 'paint', qty: 1, detail: `${r3(part.surface)} m²` });
    parts.push(mp);
  }

  const markOf = (ref: string) => dm.partByRef.get(ref)?.mark ?? ref;
  const assemblies: MisAssembly[] = [];
  const coatings: MisCoating[] = [];
  // Assemblies of each mark, in model order (grouped once, not filtered per mark).
  const byMark = new Map<string, typeof dm.assemblies>();
  for (const x of dm.assemblies) {
    const l = byMark.get(x.mark);
    if (l) l.push(x);
    else byMark.set(x.mark, [x]);
  }
  for (const { assembly: a, qty } of uniqueAssemblies(dm)) {
    const same = byMark.get(a.mark) ?? [];
    const main = dm.partByRef.get(a.main)!;
    assemblies.push({
      mark: a.mark,
      qty,
      main: main.mark,
      parts: countBy(a.parts.map(markOf)).map(({ batch, qty: n }) => ({ mark: batch, qty: n })),
      unitMass: r3(a.mass),
      dims: assemblyDims(dm, a).map(r1) as Dims,
      finish: main.finish,
      batches: countBy(same.map((x) => batchName(p, assemblyBatchId(p, dm, x)))),
      phases: [...new Set(same.map((x) => phaseName(p, assemblyPhaseId(p, dm, x))).filter(Boolean))],
    });
    const byFinish = new Map<string, number>();
    for (const r of a.parts) {
      const pt = dm.partByRef.get(r)!;
      if (pt.finish !== 'none') byFinish.set(pt.finish, (byFinish.get(pt.finish) ?? 0) + pt.surface);
    }
    for (const [finish, area] of byFinish) coatings.push({ assembly: a.mark, qty, finish, areaEach: r3(area), areaTotal: r3(area * qty) });
  }

  const boltMap = new Map<string, MisBolt>();
  for (const b of dm.bolts) {
    const batch = batchName(p, connectionBatchId(p, b.connectionId));
    const k = `${batch}|${b.kind}|${b.size}|${b.grade}|${b.length}`;
    const e = boltMap.get(k) ?? { batch, kind: b.kind, size: b.size, grade: b.grade, length: b.length, qty: 0, unitMassEstimate: r3(boltSetMass(b.size, b.length, b.kind)) };
    e.qty += b.positions.length;
    boltMap.set(k, e);
  }

  // One weld row per joint of each unique assembly.
  const size = p.drawings.settings.weldSize;
  const welds: MisWeld[] = [];
  const firstOf = new Map<string, string>();
  for (const a of dm.assemblies) if (!firstOf.has(a.mark)) firstOf.set(a.mark, a.id);
  const firstParts = new Map<string, Set<string>>();
  for (const a of dm.assemblies) if (firstOf.get(a.mark) === a.id) firstParts.set(a.mark, new Set(a.parts));
  for (const w of weldJoints(dm)) {
    const set = firstParts.get(w.assembly);
    if (!set?.has(w.a)) continue;
    welds.push({ assembly: w.assembly, partA: markOf(w.a), partB: markOf(w.b), type: 'fillet', size, length: w.length });
  }

  return {
    schema: MIS_SCHEMA,
    version: MIS_VERSION,
    generated: new Date().toISOString(),
    units: { length: 'mm', mass: 'kg', area: 'm2', angle: 'deg' },
    project: { id: p.id, name: p.info.name, number: p.info.number, client: p.info.client, designer: p.info.designer },
    phases: p.phases.map((x) => ({ id: x.id, name: x.name, sequence: x.sequence })),
    batches: p.batches.map((b) => ({ id: b.id, name: b.name, ...(b.date ? { date: b.date } : {}), ...(b.phase ? { phase: phaseName(p, b.phase) || b.phase } : {}) })),
    parts,
    assemblies,
    bolts: [...boltMap.values()],
    operations,
    welds,
    coatings,
    totals: { parts: dm.parts.length, assemblies: dm.assemblies.length, mass: r1(dm.parts.reduce((s, x) => s + x.mass, 0)), bolts: dm.bolts.reduce((s, b) => s + b.positions.length, 0) },
  };
}

/** The MIS export as flat CSV files. */
export function misCsvFiles(m: MisExport): { name: string; content: string }[] {
  const parts: Row[] = [['Mark', 'Qty', 'Type', 'Name', 'Profile', 'Material', 'Finish', 'Length (mm)', 'Width (mm)', 'Thickness (mm)', 'Unit mass (kg)', 'Unit area (m²)', 'Holes', 'Round holes', 'Slots', 'Start cut', 'End cut', 'Contour (mm)', 'Assemblies', 'Batches']];
  const cut = (c?: MisCut) => (c ? `${c.kind} ${c.angleWeb}/${c.angleFlange}` : '');
  for (const x of m.parts) {
    parts.push([
      x.mark,
      x.qty,
      x.type,
      x.name,
      x.profile,
      x.material,
      x.finish,
      x.length,
      x.width,
      x.thickness,
      x.unitMass,
      x.unitArea,
      x.holes.count,
      x.holes.round.map((h) => `${h.qty}xØ${h.d}`).join(' '),
      x.holes.slots.map((h) => `${h.qty}xØ${h.d}x${h.length}`).join(' '),
      cut(x.cuts?.start),
      cut(x.cuts?.end),
      x.contourLength ?? '',
      x.assemblies.join(' '),
      x.batches.map((b) => `${b.batch}:${b.qty}`).join(' '),
    ]);
  }
  const assemblies: Row[] = [['Mark', 'Qty', 'Main part', 'Parts', 'Unit mass (kg)', 'L (mm)', 'W (mm)', 'H (mm)', 'Finish', 'Batches', 'Phases']];
  for (const a of m.assemblies) assemblies.push([a.mark, a.qty, a.main, a.parts.map((x) => `${x.qty}x${x.mark}`).join(' '), a.unitMass, ...a.dims, a.finish, a.batches.map((b) => `${b.batch}:${b.qty}`).join(' '), a.phases.join(' ')]);
  const bolts: Row[] = [['Batch', 'Kind', 'Size', 'Grade', 'Length (mm)', 'Qty', 'Unit mass est. (kg)']];
  for (const b of m.bolts) bolts.push([b.batch, b.kind, b.size, b.grade, b.length, b.qty, b.unitMassEstimate]);
  const ops: Row[] = [['Part', 'Seq', 'Operation', 'Qty', 'End', 'Diameter (mm)', 'Length (mm)', 'Angle web (°)', 'Angle flange (°)', 'Detail']];
  for (const o of m.operations) ops.push([o.part, o.seq, o.op, o.qty, o.end ?? '', o.d ?? '', o.length ?? '', o.angleWeb ?? '', o.angleFlange ?? '', o.detail]);
  const welds: Row[] = [['Assembly', 'Part A', 'Part B', 'Type', 'Size (mm)', 'Length est. (mm)']];
  for (const w of m.welds) welds.push([w.assembly, w.partA, w.partB, w.type, w.size, w.length ?? '']);
  const coatings: Row[] = [['Assembly', 'Qty', 'Finish', 'Area each (m²)', 'Area total (m²)']];
  for (const c of m.coatings) coatings.push([c.assembly, c.qty, c.finish, c.areaEach, c.areaTotal]);
  return [
    { name: 'parts.csv', content: toCsv(parts) },
    { name: 'assemblies.csv', content: toCsv(assemblies) },
    { name: 'bolts.csv', content: toCsv(bolts) },
    { name: 'operations.csv', content: toCsv(ops) },
    { name: 'welds.csv', content: toCsv(welds) },
    { name: 'coatings.csv', content: toCsv(coatings) },
  ];
}
