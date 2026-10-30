/**
 * Fastener catalogue: structural bolts (bolts.ts), generic concrete anchors and
 * self-drilling screws for facade rails.
 *
 * ANCHOR VALUES ARE TYPICAL — use the manufacturer's ETA (EU, EAD 330232 /
 * 330499 / 330008 / 330011) or ICC-ES ESR (US) values for design. They are
 * generic starting points for layout, not brand data. Clearance holes in the
 * fixture follow EN 1992-4 Table 6.1; characteristic spacing/edge distance for
 * the concrete cone are s_cr,N = 3 h_ef and c_cr,N = 1.5 h_ef (EN 1992-4 / ACI 318).
 */
import { BOLT_SIZES, type BoltSize } from './bolts';

export const ANCHOR_DISCLAIMER = "Typical values — use the manufacturer's ETA/ESR values for design.";

export type AnchorType = 'wedge' | 'bonded' | 'screw' | 'undercut' | 'headed' | 'channel';

/** Rule for a typical minimum distance: factor × (d or h_ef), not less than `min` mm. */
export interface DistanceRule {
  factor: number;
  of: 'd' | 'hef';
  min?: number;
}

export interface AnchorFamily {
  type: AnchorType;
  label: string;
  /** Assessment document the product ETAs/ESRs are issued against. */
  assessment: string;
  installation: 'post-installed' | 'cast-in';
  description: string;
  sMin: DistanceRule;
  cMin: DistanceRule;
  /** Typical minimum member thickness. */
  hMin: (hef: number, d: number) => number;
}

export interface AnchorSize {
  kind: 'anchor';
  type: AnchorType;
  name: string;
  /** Thread / nominal diameter, mm. */
  d: number;
  /** Drill hole diameter in the concrete d0, mm (0 for cast-in). */
  drill: number;
  /** Clearance hole in the fixture df, mm (EN 1992-4 Table 6.1, pre-positioned). */
  fixtureHole: number;
  /** Typical minimum effective embedment h_ef, mm. */
  hef: number;
  /** Typical maximum effective embedment where the system allows a range (bonded), mm. */
  hefMax?: number;
  /** Typical minimum spacing, edge distance and member thickness, mm. */
  sMin: number;
  cMin: number;
  hMin: number;
  /** Characteristic spacing / edge distance for the full concrete cone, mm. */
  sCrN: number;
  cCrN: number;
  /** Cast-in channel profile (width/height, mm) for type 'channel'. */
  channel?: string;
  note: string;
}

export const ANCHOR_FAMILIES: Record<AnchorType, AnchorFamily> = {
  wedge: {
    type: 'wedge',
    label: 'Mechanical expansion (wedge / stud)',
    assessment: 'EAD 330232 (ETA) / ICC-ES AC193',
    installation: 'post-installed',
    description: 'Torque-controlled expansion anchor, drill = nominal diameter',
    sMin: { factor: 1.0, of: 'hef', min: 40 },
    cMin: { factor: 1.0, of: 'hef', min: 40 },
    hMin: (hef) => Math.max(100, 2 * hef),
  },
  bonded: {
    type: 'bonded',
    label: 'Bonded (chemical) threaded rod',
    assessment: 'EAD 330499 (ETA) / ICC-ES AC308',
    installation: 'post-installed',
    description: 'Injection mortar with threaded rod; embedment adjustable between h_ef,min and 20 d',
    sMin: { factor: 5, of: 'd', min: 40 },
    cMin: { factor: 5, of: 'd', min: 40 },
    hMin: (hef) => Math.max(100, hef + 30),
  },
  screw: {
    type: 'screw',
    label: 'Concrete screw',
    assessment: 'EAD 330232 (ETA) / ICC-ES AC193',
    installation: 'post-installed',
    description: 'Thread-forming concrete screw, named by drill diameter',
    sMin: { factor: 5, of: 'd', min: 35 },
    cMin: { factor: 5, of: 'd', min: 35 },
    hMin: (hef) => Math.max(80, 2 * hef),
  },
  undercut: {
    type: 'undercut',
    label: 'Undercut',
    assessment: 'EAD 330232 (ETA) / ICC-ES AC193',
    installation: 'post-installed',
    description: 'Self-undercutting sleeve anchor, pre-set fixture (drill diameter is system specific)',
    sMin: { factor: 1.0, of: 'hef' },
    cMin: { factor: 0.8, of: 'hef' },
    hMin: (hef) => Math.max(100, 2 * hef),
  },
  headed: {
    type: 'headed',
    label: 'Cast-in headed anchor / anchor rod',
    assessment: 'EN 1992-4 / ACI 318 Ch. 17 (AISC Design Guide 1)',
    installation: 'cast-in',
    description: 'Headed stud or anchor rod with nut/plate; h_ef ≈ 12 d, edge ≈ 5 d (DG1), spacing 4 d (ACI 318 17.9.2)',
    sMin: { factor: 4, of: 'd', min: 50 },
    cMin: { factor: 5, of: 'd', min: 100 },
    hMin: (hef) => hef + 50,
  },
  channel: {
    type: 'channel',
    label: 'Cast-in anchor channel with T-bolt',
    assessment: 'EAD 330008 (ETA) / ICC-ES AC232',
    installation: 'cast-in',
    description: 'Hot-rolled or cold-formed anchor channel with hammer-head (T) bolts',
    sMin: { factor: 5, of: 'd', min: 50 },
    cMin: { factor: 0.75, of: 'hef', min: 50 },
    hMin: (hef) => hef + 30,
  },
};

/** EN 1992-4 Table 6.1 clearance hole df for pre-positioned fixtures, by d. */
const DF: Record<number, number> = { 6: 7, 8: 9, 10: 12, 12: 14, 14: 16, 16: 18, 18: 20, 20: 22, 22: 24, 24: 26, 27: 30, 30: 33 };
const df = (d: number) => DF[d] ?? d + 3;

const rule = (r: DistanceRule, d: number, hef: number) => Math.max(r.min ?? 0, Math.round(r.factor * (r.of === 'd' ? d : hef)));

function anchor(type: AnchorType, name: string, d: number, drill: number, hef: number, extra: Partial<AnchorSize> = {}): AnchorSize {
  const f = ANCHOR_FAMILIES[type];
  return {
    kind: 'anchor',
    type,
    name,
    d,
    drill,
    fixtureHole: df(d),
    hef,
    sMin: rule(f.sMin, d, hef),
    cMin: rule(f.cMin, d, hef),
    hMin: f.hMin(hef, d),
    sCrN: 3 * hef,
    cCrN: 1.5 * hef,
    note: ANCHOR_DISCLAIMER,
    ...extra,
  };
}

// Wedge: [d, typical h_ef]
const WEDGE: [number, number][] = [[8, 45], [10, 60], [12, 70], [16, 85], [20, 100], [24, 125]];
// Bonded rod: [d, drill]; h_ef,min = max(60, 4 d), h_ef,max = 20 d
const BONDED: [number, number][] = [[8, 10], [10, 12], [12, 14], [16, 18], [20, 24], [24, 28], [27, 32], [30, 35]];
// Concrete screw: [nominal (drill) size, clearance hole, typical h_ef]
const SCREW: [number, number, number][] = [[6, 8, 40], [8, 12, 50], [10, 14, 65], [12, 16, 80], [14, 18, 90]];
// Undercut: [d, typical drill, typical h_ef]
const UNDERCUT: [number, number, number][] = [[10, 20, 100], [12, 22, 125], [16, 30, 190], [20, 37, 250]];
// Cast-in headed: d
const HEADED = [12, 16, 20, 24, 27, 30];
// Anchor channels: [profile, typical h_ef, T-bolt sizes]
const CHANNELS: [string, number, number[]][] = [
  ['28/15', 80, [8, 10, 12]],
  ['38/17', 80, [10, 12, 16]],
  ['40/22', 90, [10, 12, 16, 20]],
  ['50/30', 105, [10, 12, 16, 20]],
  ['52/34', 150, [12, 16, 20, 24]],
  ['72/48', 180, [20, 24, 27]],
];

export const ANCHORS: AnchorSize[] = [
  ...WEDGE.map(([d, hef]) => anchor('wedge', `Wedge M${d}`, d, d, hef)),
  ...BONDED.map(([d, drill]) => anchor('bonded', `Bonded M${d}`, d, drill, Math.max(60, 4 * d), { hefMax: 20 * d })),
  ...SCREW.map(([d, hole, hef]) => anchor('screw', `Screw ${d}`, d, d, hef, { fixtureHole: hole })),
  ...UNDERCUT.map(([d, drill, hef]) => anchor('undercut', `Undercut M${d}`, d, drill, hef)),
  ...HEADED.map((d) => anchor('headed', `Headed M${d}`, d, 0, 12 * d)),
  ...CHANNELS.flatMap(([ch, hef, ds]) => ds.map((d) => anchor('channel', `Channel ${ch} M${d}`, d, 0, hef, { channel: ch }))),
];

// ---------------------------------------------------------------------------
// Self-drilling screws (hexagon washer head, ISO 15480 / DIN 7504-K)

export interface ScrewSize {
  kind: 'screw';
  type: 'self-drilling';
  name: string;
  /** Nominal thread diameter, mm. */
  d: number;
  /** Hexagon across flats, mm. */
  af: number;
  /** Typical maximum total steel thickness drilled, mm, by drill point (#3 / #5). */
  drillCapacity: { point3: number; point5?: number };
  /** Typical bonded sealing washer outside diameter for cladding, mm. */
  washerOD?: number;
  spec: string;
  note: string;
}

const SCREW_NOTE = "Typical values — drilling capacity and loads per the manufacturer's ETA/ESR.";
export const SCREWS: ScrewSize[] = [
  { kind: 'screw', type: 'self-drilling', name: 'SDS 4.2', d: 4.2, af: 7, drillCapacity: { point3: 3 }, spec: 'ISO 15480 ST4.2', note: SCREW_NOTE },
  { kind: 'screw', type: 'self-drilling', name: 'SDS 4.8', d: 4.8, af: 8, drillCapacity: { point3: 4.4 }, washerOD: 16, spec: 'ISO 15480 ST4.8', note: SCREW_NOTE },
  { kind: 'screw', type: 'self-drilling', name: 'SDS 5.5', d: 5.5, af: 8, drillCapacity: { point3: 5.25, point5: 12.5 }, washerOD: 16, spec: 'ISO 15480 ST5.5', note: SCREW_NOTE },
  { kind: 'screw', type: 'self-drilling', name: 'SDS 6.3', d: 6.3, af: 10, drillCapacity: { point3: 6, point5: 12.5 }, washerOD: 19, spec: 'ISO 15480 ST6.3', note: SCREW_NOTE },
];

// ---------------------------------------------------------------------------
// Unified list

export type BoltFastener = BoltSize & { kind: 'bolt' };
export type Fastener = BoltFastener | AnchorSize | ScrewSize;
export type FastenerKind = Fastener['kind'];

export const FASTENERS: readonly Fastener[] = [...BOLT_SIZES.map((b): BoltFastener => ({ ...b, kind: 'bolt' })), ...ANCHORS, ...SCREWS];

const byName = new Map(FASTENERS.map((f) => [f.name, f]));

export function getFastener(name: string | null | undefined): Fastener | undefined {
  return name ? byName.get(name) : undefined;
}

export function fastenersOfKind<K extends FastenerKind>(kind: K): Extract<Fastener, { kind: K }>[] {
  return FASTENERS.filter((f): f is Extract<Fastener, { kind: K }> => f.kind === kind);
}

export function anchorsOfType(type: AnchorType): AnchorSize[] {
  return ANCHORS.filter((a) => a.type === type);
}
