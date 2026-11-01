/**
 * Facade surfaces from the wireframe topology, for "profiles perpendicular to
 * the surface" (Member.normal). Pure: works on logical lines and the junctions
 * between them (WireframePlan.lines / .links from analyze.ts), never on the
 * project.
 *
 * 1. Junction normals: where two lines meet at 20°–160° (T-junctions,
 *    crossings, corners), n = norm(d1 × d2). Lines of one family (mullion with
 *    mullion, transom with transom) and brackets / outriggers do not define a
 *    surface there.
 * 2. Patches: junctions along a line (sorted by station) whose normals are
 *    within the patch angle (default 10°) of each other are one patch; through
 *    the lines they share, patches spread over the facade (union-find). A
 *    curved surface stays one patch as long as neighbouring junctions agree.
 * 3. Signs: inside a patch, a BFS flips each junction normal to agree with its
 *    neighbour. Between patches (at fold lines) the side on which each patch
 *    leaves the line decides (an oriented surface crossing a fold: the two
 *    patches lie on opposite sides of it), else the sign of n_A·n_B. The
 *    relations are solved strongest first on a parity union-find.
 * 4. Exterior side per connected facade, first rule that decides: existing
 *    member normals; away from a given inside point (reference models); away
 *    from the facade's own centre (curved / folded facades); upwards (sloped
 *    facades); the side most section depths already point to; else as found.
 *    The caller can flip the whole model or single patches.
 * 5. Line normals: one patch → mean of its junction normals (samples along the
 *    line are kept for per-piece normals on warped surfaces); two or more
 *    patches (a fold, e.g. the valley line of a V) → the bisector of the patch
 *    normals, or follow patch A (larger) / B.
 *
 * Linear in the number of lines and junctions (union-find, BFS, no pairwise
 * loops); the spatial work (finding junctions) is done by the analysis grid.
 */
import type { FoldNormal, Id, MemberRole, Vec3 } from '../model/types';

export interface SurfaceLine {
  a: Vec3;
  b: Vec3;
  /** Unit direction a → b and length. */
  dir: Vec3;
  len: number;
  role: MemberRole;
  /** Member pieces of the line (the smallest id names patches and folds). */
  pieces: Id[];
  /** Mean of the pieces' Member.normal, when they have one (exterior seed). */
  existing?: Vec3 | null;
  /** Current section depth (local z) of the line's longest piece (last-resort exterior vote). */
  currentZ?: Vec3 | null;
  /** Skip the line entirely (out of scope, duplicate …). */
  skip?: boolean;
}

/** Two lines meeting at a point (T-junction, crossing or corner). */
export interface SurfaceLink {
  a: number;
  b: number;
  at: Vec3;
}

export interface SurfaceOptions {
  /** Junctions whose normals differ by more than this are in different patches, degrees. Default 10. */
  patchAngle?: number;
  /** Lines meeting at less than this angle (or more than 180° − it) do not define a surface, degrees. Default 20. */
  minAngle?: number;
  /** Fold members: bisector (default) or follow patch A (the larger) / B. */
  foldNormal?: FoldNormal;
  /** Per-fold choice by fold key. */
  folds?: Record<string, FoldNormal>;
  /** Flip the exterior side of the whole model. */
  flip?: boolean;
  /** Flip these patches (by patch key) relative to the automatic choice. */
  flipPatches?: string[];
  /** A point inside the building (e.g. the centre of the reference models): exterior = away from it. */
  insidePoint?: Vec3 | null;
}

export type ExteriorRule = 'existing' | 'reference' | 'centre' | 'up' | 'current' | 'default';

export const EXTERIOR_RULE_TEXT: Record<ExteriorRule, string> = {
  existing: 'the normals already set on these members',
  reference: 'away from the reference models',
  centre: 'away from the centre of the facades (they are curved, folded or wrap around)',
  up: 'upwards (the facade is sloped)',
  current: 'the side most section depths already point to',
  default: 'as found (no rule decided)',
};

export interface SurfacePatch {
  /** Index in SurfaceResult.patches (1-based in texts). */
  id: number;
  /** Stable key: the smallest member id of its lines. */
  key: string;
  /** Lines whose normal follows this patch (folds are listed under each of their patches too). */
  lines: number[];
  /** Mean oriented normal. */
  normal: Vec3;
  /** Total length of its lines, mm. */
  length: number;
  /** Largest angle between its junction normals and its mean (curvature), degrees. */
  spread: number;
  /** Connected facade it belongs to. */
  component: number;
  /** Flipped by the user (flipPatches). */
  flipped: boolean;
  /** A representative point (for zoom-to). */
  at: Vec3;
}

export interface SurfaceFold {
  line: number;
  key: string;
  /** Patch ids, largest first (A, B …). */
  patches: number[];
  /** Angle between the patch normals, degrees. */
  angle: number;
  mode: FoldNormal;
}

export interface LineNormal {
  /** Oriented line normal (unit). */
  n: Vec3;
  /** Junction normals along the line (station from `a`), for per-piece normals; absent on folds. */
  samples?: { s: number; n: Vec3 }[];
  /** Main patch (A for folds). */
  patch: number;
  fold: boolean;
  /** Bracket: depth along the line it is attached to. */
  bracket?: boolean;
}

export interface SurfaceResult {
  patches: SurfacePatch[];
  folds: SurfaceFold[];
  /** Per line: its oriented normal, or null (no junction: left as is). */
  normals: (LineNormal | null)[];
  /** Lines that define no surface (no junction at 20°–160°, not a bracket): left as they are. */
  free: number[];
  /** Brackets / outriggers oriented along the line they are attached to. */
  brackets: number[];
  /** Junctions used. */
  junctions: number;
  /** How the exterior side was chosen, per connected facade (index = component). */
  exterior: ExteriorRule[];
  ms: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const addv = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sc = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dotv = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const crossv = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const lenv = (a: Vec3) => Math.sqrt(dotv(a, a));
const unit = (a: Vec3): Vec3 => {
  const l = lenv(a);
  return l > 1e-12 ? sc(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
/** a projected perpendicular to the unit vector d. */
const perp = (a: Vec3, d: Vec3): Vec3 => sub(a, sc(d, dotv(a, d)));
const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const deg = (r: number) => (r * 180) / Math.PI;
export const angleBetween = (a: Vec3, b: Vec3) => deg(Math.acos(Math.max(-1, Math.min(1, dotv(unit(a), unit(b))))));

const isMain = (r: MemberRole) => r === 'mullion' || r === 'post';
const isSecondary = (r: MemberRole) => r === 'transom' || r === 'rail';
/** Lines that stand off the surface (their junctions do not lie in it). */
export const isStandOff = (r: MemberRole) => r === 'bracket' || r === 'outrigger';

/** Normal of a member of a line at stations [s0, s1] (per-piece on warped surfaces). */
export function normalOnSpan(ln: LineNormal, dir: Vec3, s0: number, s1: number, tol = 10): Vec3 {
  const sm = ln.samples;
  if (!sm || sm.length < 2) return ln.n;
  const lo = Math.min(s0, s1) - tol;
  const hi = Math.max(s0, s1) + tol;
  let acc = { x: 0, y: 0, z: 0 };
  let k = 0;
  for (const q of sm) if (q.s >= lo && q.s <= hi) (acc = addv(acc, q.n)), k++;
  if (!k) {
    // Nearest samples on either side, weighted by distance.
    const c = (s0 + s1) / 2;
    let below: { s: number; n: Vec3 } | null = null;
    let above: { s: number; n: Vec3 } | null = null;
    for (const q of sm) {
      if (q.s <= c && (!below || q.s > below.s)) below = q;
      if (q.s >= c && (!above || q.s < above.s)) above = q;
    }
    if (below && above && above.s > below.s) {
      const t = (c - below.s) / (above.s - below.s);
      acc = addv(sc(below.n, 1 - t), sc(above.n, t));
    } else acc = (below ?? above)!.n;
  }
  const n = unit(perp(acc, dir));
  return lenv(n) > 0.5 && dotv(n, ln.n) > 0 ? n : ln.n;
}

/**
 * Surface patches, folds and oriented normals of the lines. `links` are the
 * junctions between lines (any order, duplicates allowed); `continuations`
 * pair collinear lines of one family across a gap (stack joints), so facade
 * parts that only meet there still get the same exterior side.
 */
export function detectSurfaces(lines: SurfaceLine[], links: SurfaceLink[], opts: SurfaceOptions = {}, continuations: { a: number; b: number }[] = []): SurfaceResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cosPatch = Math.cos(((opts.patchAngle ?? 10) * Math.PI) / 180);
  const maxCos = Math.cos(((opts.minAngle ?? 20) * Math.PI) / 180);
  const nL = lines.length;

  // 1. Junction normals.
  type J = { a: number; b: number; at: Vec3; n: Vec3; w: number; sa: number; sb: number };
  const js: J[] = [];
  const brLinks: SurfaceLink[] = [];
  const seen = new Set<string>();
  for (const k of links) {
    if (k.a === k.b) continue;
    const A = lines[k.a];
    const B = lines[k.b];
    if (!A || !B || A.skip || B.skip || !(A.len > 0) || !(B.len > 0)) continue;
    const key = k.a < k.b ? `${k.a}|${k.b}` : `${k.b}|${k.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isStandOff(A.role) || isStandOff(B.role)) {
      brLinks.push(k);
      continue;
    }
    if ((isMain(A.role) && isMain(B.role)) || (isSecondary(A.role) && isSecondary(B.role))) continue;
    const c = Math.abs(dotv(A.dir, B.dir));
    if (c > maxCos) continue;
    const cr = crossv(A.dir, B.dir);
    const w = lenv(cr);
    js.push({ a: k.a, b: k.b, at: k.at, n: sc(cr, 1 / w), w, sa: dotv(sub(k.at, A.a), A.dir), sb: dotv(sub(k.at, B.a), B.dir) });
  }
  const nJ = js.length;
  const onLine: number[][] = lines.map(() => []);
  js.forEach((j, i) => {
    onLine[j.a].push(i);
    onLine[j.b].push(i);
  });
  const stationOn = (j: J, li: number) => (j.a === li ? j.sa : j.sb);

  // 2. Patches: chain similar junctions along each line (open clusters), union-find over all lines.
  const up = new Int32Array(nJ).map((_, i) => i);
  const find = (x: number) => {
    while (up[x] !== x) {
      up[x] = up[up[x]];
      x = up[x];
    }
    return x;
  };
  const adj: number[][] = js.map(() => []);
  for (let li = 0; li < nL; li++) {
    const list = onLine[li];
    if (list.length < 2) continue;
    list.sort((x, y) => stationOn(js[x], li) - stationOn(js[y], li));
    const open: number[] = [];
    for (const j of list) {
      let best = -1;
      let bc = cosPatch;
      for (let k = 0; k < open.length; k++) {
        const c = Math.abs(dotv(js[open[k]].n, js[j].n));
        if (c >= bc) {
          bc = c;
          best = k;
        }
      }
      if (best >= 0) {
        const prev = open[best];
        adj[prev].push(j);
        adj[j].push(prev);
        const ra = find(prev);
        const rb = find(j);
        if (ra !== rb) up[rb] = ra;
        open[best] = j;
      } else {
        open.push(j);
        if (open.length > 12) open.shift();
      }
    }
  }
  // Collinear continuations join the patches on both sides of a stack joint when they agree.
  for (const c of continuations) {
    const la = onLine[c.a];
    const lb = onLine[c.b];
    if (!la?.length || !lb?.length) continue;
    const A = lines[c.a];
    const B = lines[c.b];
    // The facing ends: the pair of end points closest to each other.
    let best = Infinity;
    let gap: Vec3 = A.a;
    for (const p of [A.a, A.b]) for (const q of [B.a, B.b]) {
      const d = lenv(sub(p, q));
      if (d < best) (best = d), (gap = mid(p, q));
    }
    const nearest = (list: number[]) => list.reduce((x, y) => (lenv(sub(js[y].at, gap)) < lenv(sub(js[x].at, gap)) ? y : x));
    const ja = nearest(la);
    const jb = nearest(lb);
    if (Math.abs(dotv(js[ja].n, js[jb].n)) < cosPatch) continue;
    adj[ja].push(jb);
    adj[jb].push(ja);
    const ra = find(ja);
    const rb = find(jb);
    if (ra !== rb) up[rb] = ra;
  }

  // 3a. Signs inside each patch (BFS).
  const sign = new Int8Array(nJ);
  const queue: number[] = [];
  for (let s = 0; s < nJ; s++) {
    if (sign[s]) continue;
    sign[s] = 1;
    queue.length = 0;
    queue.push(s);
    for (let qi = 0; qi < queue.length; qi++) {
      const j = queue[qi];
      const nj = sc(js[j].n, sign[j]);
      for (const k of adj[j]) {
        if (sign[k]) continue;
        sign[k] = dotv(nj, js[k].n) >= 0 ? 1 : -1;
        queue.push(k);
      }
    }
  }
  const on = (j: number) => sc(js[j].n, sign[j]);
  const rootIdx = new Map<number, number>();
  const patchOf = new Int32Array(nJ);
  for (let j = 0; j < nJ; j++) {
    const r = find(j);
    let id = rootIdx.get(r);
    if (id === undefined) {
      id = rootIdx.size;
      rootIdx.set(r, id);
    }
    patchOf[j] = id;
  }
  const nP = rootIdx.size;

  // Per line and patch: weight, summed oriented normal (perpendicular to the line), side vector.
  type LP = { w: number; n: Vec3; side: Vec3; ends: number; count: number };
  const lineP: Map<number, LP>[] = lines.map(() => new Map());
  const endReach = (L: SurfaceLine) => Math.max(60, 0.05 * L.len);
  for (let li = 0; li < nL; li++) {
    const L = lines[li];
    for (const j of onLine[li]) {
      const J = js[j];
      const P = patchOf[j];
      let e = lineP[li].get(P);
      if (!e) lineP[li].set(P, (e = { w: 0, n: { x: 0, y: 0, z: 0 }, side: { x: 0, y: 0, z: 0 }, ends: 0, count: 0 }));
      e.w += J.w;
      e.count++;
      e.n = addv(e.n, sc(perp(on(j), L.dir), J.w));
      // The other line ends here: it leaves the line on one side.
      const oi = J.a === li ? J.b : J.a;
      const O = lines[oi];
      const so = J.a === li ? J.sb : J.sa;
      const r = endReach(O);
      if (so <= r || so >= O.len - r) {
        const out = so <= O.len / 2 ? O.dir : sc(O.dir, -1);
        e.side = addv(e.side, unit(perp(out, L.dir)));
        e.ends++;
      }
    }
  }

  // 3b. Relations between patches (at the lines they share), solved strongest first.
  const votes = new Map<string, { p: number; q: number; v: number }>();
  for (let li = 0; li < nL; li++) {
    const m = lineP[li];
    if (m.size < 2) continue;
    const L = lines[li];
    const ps = [...m.entries()];
    for (let x = 0; x < ps.length; x++)
      for (let y = x + 1; y < ps.length; y++) {
        const [P, eP] = ps[x];
        const [Q, eQ] = ps[y];
        const nP_ = unit(eP.n);
        const nQ_ = unit(eQ.n);
        let rel = 0;
        let w = Math.min(eP.w, eQ.w);
        const sP = lenv(eP.side);
        const sQ = lenv(eQ.side);
        if (eP.ends && eQ.ends && sP > 0.5 * eP.ends && sQ > 0.5 * eQ.ends) {
          const sigP = Math.sign(dotv(nP_, crossv(L.dir, sc(eP.side, 1 / sP))));
          const sigQ = Math.sign(dotv(nQ_, crossv(L.dir, sc(eQ.side, 1 / sQ))));
          if (sigP && sigQ) rel = sigP === sigQ ? -1 : 1;
        }
        if (!rel) {
          const d = dotv(nP_, nQ_);
          if (Math.abs(d) > 0.2) {
            rel = d > 0 ? 1 : -1;
            w *= 0.5 * Math.abs(d);
          }
        }
        if (!rel) continue;
        const [p, q] = P < Q ? [P, Q] : [Q, P];
        const k = `${p}|${q}`;
        const e = votes.get(k);
        if (e) e.v += rel * w;
        else votes.set(k, { p, q, v: rel * w });
      }
  }
  // Collinear continuations (stack joints): the two lengths face the same way.
  for (const c of continuations) {
    const ma = lineP[c.a];
    const mb = lineP[c.b];
    if (!ma?.size || !mb?.size) continue;
    const [P, eP] = [...ma.entries()].sort((x, y) => y[1].w - x[1].w)[0];
    const [Q, eQ] = [...mb.entries()].sort((x, y) => y[1].w - x[1].w)[0];
    if (P === Q) continue;
    const d = dotv(unit(eP.n), unit(eQ.n));
    if (Math.abs(d) < 0.5) continue;
    const [p, q] = P < Q ? [P, Q] : [Q, P];
    const k = `${p}|${q}`;
    const v = (d > 0 ? 1 : -1) * Math.min(eP.w, eQ.w) * Math.abs(d);
    const e = votes.get(k);
    if (e) e.v += v;
    else votes.set(k, { p, q, v });
  }
  const pUp = new Int32Array(nP).map((_, i) => i);
  const pPar = new Uint8Array(nP);
  const pRoot = (i: number): number => {
    let r = i;
    let x = 0;
    while (pUp[r] !== r) {
      x ^= pPar[r];
      r = pUp[r];
    }
    let c = i;
    let cx = x;
    while (pUp[c] !== c) {
      const next = pUp[c];
      const px = pPar[c];
      pUp[c] = r;
      pPar[c] = cx;
      cx ^= px;
      c = next;
    }
    return r;
  };
  const pParity = (i: number) => {
    pRoot(i);
    return pUp[i] === i ? 0 : pPar[i];
  };
  for (const e of [...votes.values()].sort((x, y) => Math.abs(y.v) - Math.abs(x.v))) {
    if (!e.v) continue;
    const ra = pRoot(e.p);
    const rb = pRoot(e.q);
    if (ra === rb) continue;
    const a = pParity(e.p);
    const b = pParity(e.q);
    pUp[rb] = ra;
    pPar[rb] = a ^ b ^ (e.v < 0 ? 1 : 0);
  }
  const compOf = new Int32Array(nP);
  const compIdx = new Map<number, number>();
  const pFlip = new Int8Array(nP);
  for (let P = 0; P < nP; P++) {
    const r = pRoot(P);
    let c = compIdx.get(r);
    if (c === undefined) compIdx.set(r, (c = compIdx.size));
    compOf[P] = c;
    pFlip[P] = pParity(P) ? -1 : 1;
  }
  const nC = compIdx.size;

  // Patch summaries (before the exterior choice).
  const pW = new Float64Array(nP);
  const pN: Vec3[] = Array.from({ length: nP }, () => ({ x: 0, y: 0, z: 0 }));
  const pAt: (Vec3 | null)[] = Array.from({ length: nP }, () => null);
  for (let j = 0; j < nJ; j++) {
    const P = patchOf[j];
    pW[P] += js[j].w;
    pN[P] = addv(pN[P], sc(on(j), js[j].w * pFlip[P]));
    if (!pAt[P]) pAt[P] = js[j].at;
  }

  // Line patches: significant ones (≥ 25 % of the line's junction weight; patches of one junction only count alone).
  const pCount = new Int32Array(nP);
  for (let j = 0; j < nJ; j++) pCount[patchOf[j]]++;
  const linePatches: number[][] = lines.map(() => []);
  for (let li = 0; li < nL; li++) {
    const m = lineP[li];
    if (!m.size) continue;
    let tot = 0;
    for (const e of m.values()) tot += e.w;
    let ps = [...m.entries()].filter(([P, e]) => e.w >= 0.25 * tot && (pCount[P] > 1 || m.size === 1));
    if (!ps.length) ps = [...m.entries()].sort((x, y) => y[1].w - x[1].w).slice(0, 1);
    ps.sort((x, y) => pW[y[0]] - pW[x[0]] || x[0] - y[0]);
    linePatches[li] = ps.map(([P]) => P);
  }

  // Raw (pre-exterior) line normals for the exterior votes.
  const rawN = (li: number): Vec3 | null => {
    const ps = linePatches[li];
    if (!ps.length) return null;
    let s = { x: 0, y: 0, z: 0 };
    for (const P of ps) s = addv(s, sc(unit(lineP[li].get(P)!.n), pFlip[P]));
    const n = unit(s);
    return lenv(n) > 0.5 ? n : sc(unit(lineP[li].get(ps[0])!.n), pFlip[ps[0]]);
  };

  // Patch keys: the smallest member id of the lines that belong to that patch only (fold lines are shared).
  const userFlip = new Set(opts.flipPatches ?? []);
  const patchKeyOf: string[] = Array.from({ length: nP }, () => '');
  const minIdOf = (li: number) => lines[li].pieces.reduce((m, id) => (m === '' || id < m ? id : m), '');
  for (let li = 0; li < nL; li++) {
    if (linePatches[li].length !== 1) continue;
    const P = linePatches[li][0];
    const minId = minIdOf(li);
    if (minId && (!patchKeyOf[P] || minId < patchKeyOf[P])) patchKeyOf[P] = minId;
  }
  for (let li = 0; li < nL; li++)
    for (const P of lineP[li].keys()) if (!patchKeyOf[P]) patchKeyOf[P] = `${minIdOf(li)}#${P}`;

  // 4. Exterior side per component (patches whose members already carry normals keep their side).
  const compSign = new Int8Array(nC).fill(1);
  const exterior: ExteriorRule[] = Array.from({ length: nC }, () => 'default');
  const patchSeed = new Int8Array(nP);
  {
    const exP = new Float64Array(nP);
    const exPW = new Float64Array(nP);
    const lineComp = new Int32Array(nL).fill(-1);
    const raw: (Vec3 | null)[] = lines.map((_, li) => rawN(li));
    for (let li = 0; li < nL; li++) if (linePatches[li].length) lineComp[li] = compOf[linePatches[li][0]];
    const acc = Array.from({ length: nC }, () => ({ w: 0, ex: 0, exW: 0, ref: 0, cen: { x: 0, y: 0, z: 0 }, up: 0, cur: 0, centre: 0 }));
    for (let li = 0; li < nL; li++) {
      const c = lineComp[li];
      const n = raw[li];
      if (c < 0 || !n) continue;
      const L = lines[li];
      const A = acc[c];
      A.w += L.len;
      A.cen = addv(A.cen, sc(mid(L.a, L.b), L.len));
      if (L.existing && lenv(L.existing) > 0.5) {
        const v = L.len * Math.sign(dotv(n, L.existing));
        A.ex += v;
        A.exW += L.len;
        exP[linePatches[li][0]] += v;
        exPW[linePatches[li][0]] += L.len;
      }
      if (opts.insidePoint) A.ref += L.len * dotv(n, unit(sub(mid(L.a, L.b), opts.insidePoint)));
      A.up += L.len * n.z;
      if (L.currentZ) A.cur += L.len * dotv(n, L.currentZ);
    }
    // The centre of all the facades together (a building wraps around it).
    let cen = { x: 0, y: 0, z: 0 };
    let cw = 0;
    for (const A of acc) {
      cen = addv(cen, A.cen);
      cw += A.w;
    }
    const centre = cw > 0 ? sc(cen, 1 / cw) : cen;
    for (let li = 0; li < nL; li++) {
      const c = lineComp[li];
      const n = raw[li];
      if (c < 0 || !n || !(acc[c].w > 0)) continue;
      const L = lines[li];
      acc[c].centre += L.len * dotv(n, unit(sub(mid(L.a, L.b), centre)));
    }
    for (let c = 0; c < nC; c++) {
      const A = acc[c];
      if (!(A.w > 0)) continue;
      const pick = (v: number, rule: ExteriorRule) => {
        compSign[c] = v >= 0 ? 1 : -1;
        exterior[c] = rule;
      };
      if (A.exW > 0 && Math.abs(A.ex) > 0.1 * A.exW) pick(A.ex, 'existing');
      else if (opts.insidePoint && Math.abs(A.ref) > 0.05 * A.w) pick(A.ref, 'reference');
      else if (Math.abs(A.centre) > 0.05 * A.w) pick(A.centre, 'centre');
      else if (Math.abs(A.up) > 0.05 * A.w) pick(A.up, 'up');
      else if (Math.abs(A.cur) > 1e-6 * A.w) pick(A.cur, 'current');
    }
    for (let P = 0; P < nP; P++) if (exPW[P] > 0 && Math.abs(exP[P]) > 0.1 * exPW[P]) patchSeed[P] = exP[P] > 0 ? 1 : -1;
  }
  const sideOf = (P: number) => (patchSeed[P] || compSign[compOf[P]]) * (opts.flip ? -1 : 1) * (userFlip.has(patchKeyOf[P]) ? -1 : 1);

  // Final patch orientation: relations × exterior × user flips.
  const fin = new Int8Array(nP);
  for (let P = 0; P < nP; P++) fin[P] = pFlip[P] * sideOf(P);

  // 5. Line normals.
  const normals: (LineNormal | null)[] = lines.map(() => null);
  const folds: SurfaceFold[] = [];
  const patchLines: number[][] = Array.from({ length: nP }, () => []);
  const free: number[] = [];
  for (let li = 0; li < nL; li++) {
    const L = lines[li];
    if (L.skip) continue;
    const ps = linePatches[li];
    if (!ps.length) {
      if (!isStandOff(L.role) && L.len > 0) free.push(li);
      continue;
    }
    const pn = (P: number) => sc(unit(lineP[li].get(P)!.n), fin[P]);
    for (const P of ps) patchLines[P].push(li);
    if (ps.length === 1) {
      const P = ps[0];
      const samples: { s: number; n: Vec3 }[] = [];
      for (const j of onLine[li]) if (patchOf[j] === P) samples.push({ s: stationOn(js[j], li), n: unit(perp(sc(on(j), fin[P]), L.dir)) });
      normals[li] = { n: pn(P), patch: P, fold: false, ...(samples.length > 1 ? { samples } : {}) };
      continue;
    }
    const key = L.pieces.reduce((m, id) => (m === '' || id < m ? id : m), '');
    const mode = opts.folds?.[key] ?? opts.foldNormal ?? 'bisector';
    const nA = pn(ps[0]);
    const nB = pn(ps[1]);
    let n: Vec3;
    if (mode === 'a') n = nA;
    else if (mode === 'b') n = nB;
    else {
      let s = { x: 0, y: 0, z: 0 };
      for (const P of ps) s = addv(s, pn(P));
      n = unit(s);
      // Patches turned more than 90° against each other (a user flip): follow the larger one.
      if (lenv(n) < 0.5 || dotv(nA, nB) < 0) n = nA;
    }
    normals[li] = { n: unit(perp(n, L.dir)), patch: ps[0], fold: true };
    folds.push({ line: li, key, patches: ps, angle: angleBetween(nA, nB), mode });
  }

  // Brackets / outriggers: depth along the line they are attached to (upwards).
  const brackets: number[] = [];
  const brSeen = new Set<number>();
  for (const k of brLinks) {
    const [bi, oi] = isStandOff(lines[k.a].role) ? [k.a, k.b] : [k.b, k.a];
    if (brSeen.has(bi) || isStandOff(lines[oi].role) || lines[bi].skip) continue;
    const B = lines[bi];
    const O = lines[oi];
    if (Math.abs(dotv(B.dir, O.dir)) > maxCos) continue;
    brSeen.add(bi);
    let d = O.dir;
    const on2 = normals[oi];
    // "Up" along the attached line: world up, else the patch's own up (normal × line).
    if (Math.abs(d.z) > 0.05) d = d.z < 0 ? sc(d, -1) : d;
    else if (on2) {
      const u = crossv(on2.n, d);
      if (u.z < 0) d = sc(d, -1);
    }
    // The attached line's direction itself (axesFor projects it): stays exact when the bracket end is snapped.
    normals[bi] = { n: unit(d), patch: on2?.patch ?? -1, fold: false, bracket: true };
    brackets.push(bi);
  }

  const patches: SurfacePatch[] = [];
  for (let P = 0; P < nP; P++) {
    const n = sc(unit(pN[P]), sideOf(P));
    let spread = 0;
    for (const li of patchLines[P]) {
      const ln = normals[li];
      if (ln && !ln.fold) spread = Math.max(spread, angleBetween(ln.n, n));
    }
    patches.push({
      id: P,
      key: patchKeyOf[P],
      lines: patchLines[P],
      normal: n,
      length: patchLines[P].reduce((s, li) => s + lines[li].len, 0),
      spread: Math.max(0, spread),
      component: compOf[P],
      flipped: userFlip.has(patchKeyOf[P]),
      at: pAt[P] ?? { x: 0, y: 0, z: 0 },
    });
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { patches, folds, normals, free, brackets, junctions: nJ, exterior, ms: Math.round(t1 - t0) };
}
