/**
 * Exact geometry fingerprints of derived connections, for "bit-identical"
 * regression tests (tests/fixtures/vertical-geometry.json). Every number of the
 * connection outputs (plates, profile parts, bolts, member holes and slots,
 * welds, warnings) and of the joint members' trimmed geometry is hashed at full
 * precision (−0 counted as 0). Ids are replaced by their creation index, and
 * the connections are sorted, so the hash does not depend on ids or on the
 * order the connections were created in.
 */
import { createHash } from 'node:crypto';
import { deriveModel } from '../src/core/derive/model';
import type { Project } from '../src/core/model/types';

/** Canonical JSON of a value with ids replaced and −0 normalised. */
function canon(v: unknown, ids: Map<string, string>): unknown {
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (typeof v === 'string') {
    let s = v;
    for (const part of s.split(/[:|]/)) {
      const r = ids.get(part);
      if (r) s = s.split(part).join(r);
    }
    return ids.get(s) ?? s;
  }
  if (Array.isArray(v)) return v.map((x) => canon(x, ids));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      // The member object of a geometry is identified by its id only.
      if (k === 'member' && typeof (v as Record<string, unknown>)[k] === 'object') {
        out[k] = canon(((v as Record<string, { id: string }>)[k]).id, ids);
        continue;
      }
      if (k === 'profile' && typeof (v as Record<string, unknown>)[k] === 'object') {
        out[k] = ((v as Record<string, { name: string }>)[k]).name;
        continue;
      }
      out[k] = canon((v as Record<string, unknown>)[k], ids);
    }
    return out;
  }
  return v;
}

/** Fingerprint of every connection's derived geometry (and its joint members) in a project. */
export function connectionGeometryHash(p: Project): { hash: string; connections: number } {
  const ids = new Map<string, string>();
  Object.keys(p.nodes).forEach((id, i) => ids.set(id, `N${i}`));
  Object.keys(p.members).forEach((id, i) => ids.set(id, `M${i}`));
  const dm = deriveModel(p);
  const entries: string[] = [];
  for (const c of Object.values(p.connections)) {
    const out = dm.connectionOut.get(c.id);
    const members = [...(c.main ? [c.main] : []), ...c.secondary];
    const geoms = members.map((id) => {
      const g = dm.geoms.get(id);
      return g ? { id, frame: g.frame, length: g.length, trimStart: g.trimStart, trimEnd: g.trimEnd } : null;
    });
    const local = new Map(ids);
    local.set(c.id, 'C');
    entries.push(JSON.stringify(canon({ type: c.type, node: c.node, main: c.main, secondary: c.secondary, out: out ?? null, geoms }, local)));
  }
  entries.sort();
  const hash = createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 24);
  return { hash, connections: entries.length };
}

// ---------------------------------------------------------------------------
// Fixture cases: vertical-facade geometry that must not change

import { CONNECTIONS } from '../src/core/connections/registry';
import { previewJoint } from '../src/core/connections/preview';
import { autoConnect } from '../src/core/connections/registry';
import { createProject, facadeGrid } from '../src/core/model/ops';
import { sampleProject } from '../src/core/sample';
import type { ConnectionType, ParamValue } from '../src/core/model/types';
import { sampleFacade } from './helpers';

export interface GeometryCase {
  name: string;
  make(): Project;
}

/** The representative joint of every catalogue type and its select / bool / side variants (as tests/connectionsFollow.test.ts). */
export function catalogCases(): GeometryCase[] {
  const out: GeometryCase[] = [];
  for (const type of Object.keys(CONNECTIONS) as ConnectionType[]) {
    if (type === 'custom') continue;
    const vs: { name: string; params: Record<string, ParamValue> }[] = [{ name: type, params: {} }];
    for (const ps of CONNECTIONS[type].params) {
      if (ps.kind === 'select' && ps.key !== 'grade') for (const o of ps.options ?? []) if (o !== ps.default) vs.push({ name: `${type} ${ps.key}=${o}`, params: { [ps.key]: o } });
      if (ps.kind === 'bool') vs.push({ name: `${type} ${ps.key}=${!ps.default}`, params: { [ps.key]: !ps.default } });
      if (ps.kind === 'number' && ps.flip) vs.push({ name: `${type} ${ps.key}*`, params: { [ps.key]: ps.default === 1 ? -1 : 15 } });
    }
    for (const v of vs) out.push({ name: `joint: ${v.name}`, make: () => previewJoint(type, v.params).project });
  }
  return out;
}

/** Auto-connected vertical facades: the app sample, the test facade, and facades on the YZ plane and on a vertical plane at 30° in plan. */
export function facadeCases(): GeometryCase[] {
  const grid = (plane: Parameters<typeof facadeGrid>[1]['plane'], name: string): GeometryCase => ({
    name,
    make: () => {
      const p = createProject(name);
      facadeGrid(p, {
        plane,
        u0: 0,
        v0: 0,
        bays: [1200, 1800],
        rows: [300, 1500, 1700, 300],
        floorLines: [0, 2, 4],
        mullionProfile: 'SHS 120x120x6',
        transomProfile: 'RHS 120x60x5',
        transomDepthNormal: true,
        addLevels: true,
      });
      autoConnect(p);
      return p;
    },
  });
  return [
    { name: 'facade: sample project', make: sampleProject },
    { name: 'facade: test facade (tests/helpers)', make: sampleFacade },
    grid({ kind: 'YZ', offset: 250 }, 'facade: YZ plane'),
    grid({ kind: 'custom', offset: 0, origin: { x: 100, y: 200, z: 0 }, xAxis: { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6), z: 0 }, yAxis: { x: 0, y: 0, z: 1 } }, 'facade: vertical plane at 30° in plan'),
  ];
}
