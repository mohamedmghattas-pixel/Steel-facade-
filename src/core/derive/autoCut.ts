/**
 * Auto-cut (Project settings → End fitting, `settings.autoCut`): a member end
 * that meets another member's side with no connection at that end and no end
 * preparation or extension of its own is cut to that member's face less the
 * project gap, so profiles never run into the member they meet
 * (docs/CONNECTION_GEOMETRY.md §3.4a).
 *
 * Which member it is cut to follows auto-connect's joints (same member kinds,
 * same choice of main member), so the joint placed later keeps the cut:
 * - transoms, rails, braces and bracket stubs: the mullion / post at the node
 *   (passing through first, else the piece continuing upwards, else any), else
 *   any member passing through the node;
 * - mullions and posts: a member passing through the node (a sill, head or
 *   edge member), unless a collinear piece continues the mullion there (a split
 *   or a stack joint is not a junction).
 * Square joints get a square cut-back (face + gap, like a connection's); other
 * joints follow the face (an EndFit with a plane). Ends steeper than the saw
 * range are left as drawn, with a warning. Pure: no DOM.
 */
import type { Id, Member, Project } from '../model/types';
import { dot, normalize, sub } from '../model/geometry';
import { membersAtNodeIndex, type MemberAtNode } from '../model/ops';
import { cutAngle, envelopeFace, SAW_LIMIT, type EndFit } from '../geometry/endPrep';
import { centreAt, faceDistance, faceTrim, inward } from '../connections/common';
import { memberKind, type Kind } from '../connections/autoConnect';
import type { MemberGeom } from './memberGeom';
import type { DerivedModel } from './model';

export interface AutoCutEnd {
  member: Id;
  end: 'start' | 'end';
  /** Cut-back along the axis (face + gap at the axis). */
  amount: number;
  fit: EndFit;
}

const COLLINEAR = 0.999;

/**
 * Auto-cut ends of a project. `raw`: untrimmed member geometry (derivation
 * pass 1); `skip(id, end)`: ends a connection governs or the user prepared.
 */
export function autoCutEnds(
  p: Project,
  raw: Map<Id, MemberGeom>,
  skip: (id: Id, end: 'start' | 'end') => boolean,
  gap: number,
  warn: (memberId: Id, text: string) => void,
): AutoCutEnd[] {
  const out: AutoCutEnd[] = [];
  let membersAt: ((nodeId: Id) => MemberAtNode[]) | null = null;
  const kinds = new Map<Id, Kind>();
  const kind = (m: Member) => {
    let k = kinds.get(m.id);
    if (!k) kinds.set(m.id, (k = memberKind(p, m)));
    return k;
  };
  const dir = (m: Member) => normalize(sub(p.nodes[m.end].p, p.nodes[m.start].p));
  for (const m of Object.values(p.members)) {
    const gA = raw.get(m.id);
    if (!gA?.profile || !(gA.length > 1)) continue;
    for (const end of ['start', 'end'] as const) {
      if (skip(m.id, end) || (end === 'start' ? m.startExt : m.endExt)) continue;
      const nodeId = end === 'start' ? m.start : m.end;
      const N = p.nodes[nodeId]?.p;
      if (!N) continue;
      membersAt ??= membersAtNodeIndex(p);
      const here = membersAt(nodeId).filter((x) => x.member.id !== m.id && raw.get(x.member.id)?.profile);
      if (!here.length) continue;
      const dA = dir(m);
      const collinear = (x: MemberAtNode) => Math.abs(dot(dA, dir(x.member))) > COLLINEAR;
      const cands = here.filter((x) => !collinear(x));
      const kA = kind(m);
      let B: MemberAtNode | undefined;
      if (kA === 'main') {
        if (here.some(collinear)) continue;
        B = cands.find((x) => x.at === 'through' && kind(x.member) !== 'main') ?? cands.find((x) => x.at === 'through');
      } else {
        const mains = cands.filter((x) => kind(x.member) === 'main');
        const otherZ = (x: MemberAtNode) => p.nodes[x.member.start === nodeId ? x.member.end : x.member.start].p.z;
        B = mains.find((x) => x.at === 'through') ?? mains.find((x) => otherZ(x) > N.z) ?? mains[0] ?? cands.find((x) => x.at === 'through');
      }
      if (!B) continue;
      const gB = raw.get(B.member.id)!;
      const { dir: dIn } = inward(gA, N);
      if (!envelopeFace(gB.frame, gB.w, gB.h, gB.profile?.shape, dIn)) continue;
      const t = faceTrim(gB, gA, end, dIn, faceDistance(gB, centreAt(gA, N), dIn), gap);
      // An end that does not reach into the other member (a section offset away from it) is left as drawn.
      if (!(t.amount > 0.05)) continue;
      const name = B.member.name || B.member.profile || 'member';
      if (t.fit) {
        const n = t.fit.n;
        const a = cutAngle({ n: { x: dot(n, gA.frame.x), y: dot(n, gA.frame.y), z: dot(n, gA.frame.z) } });
        if (a > SAW_LIMIT) {
          warn(m.id, `${end === 'start' ? 'Start' : 'End'} meets the ${name} at ${a.toFixed(1)}° from square, beyond the usual saw range (${SAW_LIMIT}°): not cut automatically — fit it by hand (Fit to) or place a connection.`);
          continue;
        }
      }
      out.push({ member: m.id, end, amount: t.amount, fit: { to: B.member.id, by: 'auto-cut', auto: true, ...(t.fit ? { plane: { p: t.fit.p, n: t.fit.n } } : {}) } });
    }
  }
  return out;
}

/** Ends cut by the auto-cut, and connection ends that follow the main face (not square). */
export function endFitCounts(dm: Pick<DerivedModel, 'geoms'>): { auto: number; autoAngled: number; connection: number } {
  let auto = 0;
  let autoAngled = 0;
  let connection = 0;
  for (const g of dm.geoms.values()) {
    for (const f of [g.fits?.start, g.fits?.end]) {
      if (!f) continue;
      if (f.auto) {
        auto++;
        if (f.plane) autoAngled++;
      } else if (f.plane) connection++;
    }
  }
  return { auto, autoAngled, connection };
}
