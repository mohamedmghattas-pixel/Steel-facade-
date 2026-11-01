/**
 * Client confirmation of the wireframe: a content fingerprint of the geometry
 * and member roles / profiles, and the approvals recorded against it.
 *
 * The fingerprint does not depend on ids or object order: node positions
 * (rounded to 0.1 mm) and every member as its two rounded end points plus role
 * and profile, each list sorted, hashed with cyrb128. Undo, redo, save and
 * load therefore give the same value; any move, split, merge, role or profile
 * change gives a new one.
 */
import type { Project, WireframeApproval, WireframeSummary, Vec3 } from '../model/types';
import { hash128 } from '../io/guid';

const r = (v: number) => {
  const n = Math.round(v * 10);
  return n === 0 ? 0 : n;
};
const pt = (q: Vec3) => `${r(q.x)},${r(q.y)},${r(q.z)}`;

/**
 * Order- and id-independent hash of node positions, member end points, roles and
 * profiles. Not cached (drafts are mutated in place); the UI memoises per project object.
 */
export function wireframeFingerprint(p: Project): string {
  const nodes = Object.values(p.nodes).map((n) => pt(n.p));
  nodes.sort();
  const members: string[] = [];
  for (const m of Object.values(p.members)) {
    const a = p.nodes[m.start];
    const b = p.nodes[m.end];
    if (!a || !b) continue;
    let x = pt(a.p);
    let y = pt(b.p);
    if (x > y) [x, y] = [y, x];
    members.push(`${x}|${y}|${m.role}|${m.profile ?? ''}`);
  }
  members.sort();
  const bytes = hash128(`n:${nodes.join(';')}\nm:${members.join(';')}`);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 24);
}

export type WireframeStatus = 'verified' | 'changed' | 'unverified';

export interface WireframeStatusInfo {
  status: WireframeStatus;
  fingerprint: string;
  last: WireframeApproval | null;
  /** Members in the model (the UI hides the status of an empty model). */
  members: number;
}

/** verified: the model matches the last confirmation; changed: edited since; unverified: never confirmed. */
export function wireframeStatus(p: Project): WireframeStatusInfo {
  const fingerprint = wireframeFingerprint(p);
  const approvals = p.wireframe?.approvals ?? [];
  const last = approvals.length ? approvals[approvals.length - 1] : null;
  const status: WireframeStatus = !last ? 'unverified' : last.fingerprint === fingerprint ? 'verified' : 'changed';
  return { status, fingerprint, last, members: Object.keys(p.members).length };
}

export const STATUS_LABEL: Record<WireframeStatus, string> = {
  verified: 'Wireframe verified',
  changed: 'Wireframe changed since verification',
  unverified: 'Wireframe not verified',
};

/** Record a client confirmation of the project's current wireframe (call inside store.apply). */
export function recordApproval(p: Project, o: { by: string; note?: string; summary: WireframeSummary; changes?: number; date?: string }): WireframeApproval {
  const by = o.by.trim();
  if (!by) throw new Error('A confirmation needs the name of the person who confirmed it.');
  const a: WireframeApproval = {
    date: o.date ?? new Date().toISOString(),
    by,
    ...(o.note?.trim() ? { note: o.note.trim() } : {}),
    fingerprint: wireframeFingerprint(p),
    summary: o.summary,
    changes: o.changes ?? 0,
  };
  p.wireframe.approvals.push(a);
  return a;
}
