/**
 * Synthetic models for the auto-connect tests (tests/autoConnect.test.ts):
 * a sloped V-shaped facade in the state the wireframe check leaves it
 * (mullions cut at every transom row, stack joints kept as gaps, profiles
 * perpendicular to the surface), and slab-edge reference structure for it.
 */
import { createProject, memberDefaults, newId } from '../src/core/model/ops';
import type { Id, Member, Project, Vec3 } from '../src/core/model/types';
import { add, cross, dot, normalize, scale, sub, v3 } from '../src/core/model/geometry';
import { orientToSurface } from '../src/core/wireframe';
import type { StructureElement } from '../src/core/connections/registry';

export class Builder {
  readonly p: Project;
  private keys = new Map<string, Id>();
  constructor(p = createProject('Auto-connect')) {
    this.p = p;
  }
  node(q: Vec3): Id {
    const k = `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)}`;
    let id = this.keys.get(k);
    if (!id) {
      id = newId('n');
      this.p.nodes[id] = { id, p: { x: q.x, y: q.y, z: q.z } };
      this.keys.set(k, id);
    }
    return id;
  }
  line(a: Vec3, b: Vec3, props: Partial<Member> = {}): Id {
    const id = newId('m');
    this.p.members[id] = { ...memberDefaults(this.p), ...props, id, start: this.node(a), end: this.node(b) };
    return id;
  }
}

const deg = Math.PI / 180;

export interface SlopedV {
  p: Project;
  /** Wing normals (exterior, after orientation), up-slope directions and plan directions. */
  N: [Vec3, Vec3];
  u: [Vec3, Vec3];
  h: [Vec3, Vec3];
  /** The valley mullion's pieces. */
  apex: Id[];
  /** Transom ends that land on a mullion (T-junction member ends). */
  teeEnds: number;
  /** Stack joints: the two member ends and the gap along the axis. */
  stacks: { lower: Id; upper: Id; gap: number }[];
  /** Mullion lengths (between stack joints) per mullion line. */
  lengths: number;
  /** Heights of the slab levels the reference structure has (between transom rows, like the sample facade). */
  slabLevels: number[];
  /** A point on wing i at plan station x and height z (on the facade surface). */
  at(i: number, x: number, z: number): Vec3;
}

export const ROWS = [0, 1200, 2400, 3600, 4800];
const XS = [1500, 3000, 4500];
/** Stack joints of the wing mullions sit at this height, gap 30 mm along the axis. */
export const STACK_Z = 3000;
export const STACK_GAP = 30;

/**
 * Two planar wings ±20° from X in plan, leaning 29° from vertical, meeting at a
 * valley mullion. Mullions are cut at every transom row (shared nodes); each
 * wing mullion has a 30 mm stack joint at z = 3000 (two end nodes). Transoms
 * run between neighbouring mullions. Profiles by role (mullion SHS 100x100x5,
 * transom RHS 100x50x4), oriented perpendicular to the surface.
 */
export function slopedV(): SlopedV {
  const b = new Builder();
  const wings = [0, 1].map((i) => {
    const h = i === 0 ? v3(Math.cos(20 * deg), Math.sin(20 * deg), 0) : v3(-Math.cos(20 * deg), Math.sin(20 * deg), 0);
    const nh = normalize(i === 0 ? cross(v3(0, 0, 1), h) : cross(h, v3(0, 0, 1)));
    const u = add(scale(v3(0, 0, 1), Math.cos(29 * deg)), scale(nh, Math.sin(29 * deg)));
    return { h, u };
  });
  const N0 = normalize(cross(wings[0].h, wings[0].u));
  let N1 = normalize(cross(wings[1].h, wings[1].u));
  if (dot(N0, N1) < 0) N1 = scale(N1, -1);
  const e0 = normalize(cross(N0, N1));
  const e = e0.z < 0 ? scale(e0, -1) : e0;
  const apexAt = (z: number) => scale(e, z / e.z);
  const at = (i: number, x: number, z: number) => (x === 0 ? apexAt(z) : add(scale(wings[i].h, x), scale(wings[i].u, z / wings[i].u.z)));
  const mullion = { role: 'mullion' as const, profile: 'SHS 100x100x5' };
  const transom = { role: 'transom' as const, profile: 'RHS 100x50x4' };
  const stacks: SlopedV['stacks'] = [];
  let teeEnds = 0;
  let lengths = 0;
  // Valley mullion: one length, cut at every row.
  const apex: Id[] = [];
  for (let r = 0; r + 1 < ROWS.length; r++) apex.push(b.line(apexAt(ROWS[r]), apexAt(ROWS[r + 1]), mullion));
  lengths++;
  for (const i of [0, 1]) {
    for (const x of XS) {
      const pts = [0, 1200, 2400, STACK_Z];
      let lowerId = '';
      for (let r = 0; r + 1 < pts.length; r++) lowerId = b.line(at(i, x, pts[r]), at(i, x, pts[r + 1]), mullion);
      const start = add(at(i, x, STACK_Z), scale(wings[i].u, STACK_GAP));
      const upper = b.line(start, at(i, x, 3600), mullion);
      b.line(at(i, x, 3600), at(i, x, 4800), mullion);
      stacks.push({ lower: lowerId, upper, gap: STACK_GAP });
      lengths += 2;
    }
    for (const z of ROWS) {
      const xs = [0, ...XS];
      for (let l = 0; l + 1 < xs.length; l++) {
        b.line(at(i, xs[l], z), at(i, xs[l + 1], z), transom);
        teeEnds += 2;
      }
    }
  }
  const p = b.p;
  orientToSurface(p, null);
  // Exterior normals as oriented.
  const nOf = (i: number) => {
    const m = Object.values(p.members).find((q) => q.role === 'transom' && q.normal && Math.abs(dot(normalize(sub(p.nodes[q.end].p, p.nodes[q.start].p)), wings[i].h)) > 0.99)!;
    return normalize(m.normal!);
  };
  return { p, N: [nOf(0), nOf(1)], u: [wings[0].u, wings[1].u], h: [wings[0].h, wings[1].h], apex, teeEnds, stacks, lengths, slabLevels: [1800, 4200], at };
}

/** Triangles of an axis box given by a corner and three edge vectors. */
function boxTris(o: Vec3, a: Vec3, b: Vec3, c: Vec3): number[] {
  const P = (i: number, j: number, k: number) => add(add(add(o, scale(a, i)), scale(b, j)), scale(c, k));
  const quads: Vec3[][] = [
    [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)],
    [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)],
    [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)],
    [P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)],
    [P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)],
    [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const [q0, q1, q2, q3] of quads) for (const t of [[q0, q1, q2], [q0, q2, q3]]) for (const v of t) out.push(v.x, v.y, v.z);
  return out;
}

/**
 * Slab edges behind (on the interior side of) each wing at the given levels:
 * 250 mm thick slabs whose edge is `setback` mm behind the facade surface,
 * measured horizontally at the slab top.
 */
export function slabStructure(f: SlopedV, setback = 180): StructureElement[] {
  const out: StructureElement[] = [];
  for (const i of [0, 1]) {
    // Horizontal direction into the building (against the exterior normal).
    const inward = normalize(v3(-f.N[i].x, -f.N[i].y, 0));
    for (const z of f.slabLevels) {
      const edge = add(f.at(i, 0, z), scale(inward, setback));
      const o = add(edge, v3(0, 0, -250));
      out.push({ key: `slab:${i}:${z}`, type: 'IfcSlab', name: `Slab ${z} wing ${i + 1}`, tris: boxTris(o, scale(f.h[i], 5100), scale(inward, 4000), v3(0, 0, 250)) });
    }
  }
  return out;
}
