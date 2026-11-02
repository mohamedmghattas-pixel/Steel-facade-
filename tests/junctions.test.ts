import { beforeEach, describe, expect, it } from 'vitest';
import { addConnection, createProject, memberDefaults, membersAtNode, newId } from '../src/core/model/ops';
import type { Id, Member, Project, Vec3 } from '../src/core/model/types';
import { pointSegment, v3 } from '../src/core/model/geometry';
import { cutAtCrossing, cutAtTee, divideAtMullions, findMullionJunctions } from '../src/core/model/junctions';
import { analyzeWireframe } from '../src/core/wireframe';
import { AUTO_DEFAULTS, planAutoConnect } from '../src/core/connections/autoConnect';
import { useStore } from '../src/state/store';
import { useAsk } from '../src/ui/askState';
import { applyRoleProfile, setRoleProfileUi } from '../src/ui/profileActions';
import { assignActiveProfile, autoAssignSelection } from '../src/ui/actions';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';

// ---------------------------------------------------------------------------
// A vertical facade strip (XZ plane): three continuous mullions, transoms of several kinds.

interface Strip {
  p: Project;
  mullions: Id[];
  /** z = 1200: one transom line drawn across the middle mullion (a crossing). */
  across: Id;
  /** z = 3500: two bays, ends stopping 20 mm short of the axes and 3 mm off the plane. */
  short: Id[];
  /** z = 4700: ends running 15 mm past the outer mullion axes. */
  over: Id[];
  /** z = 6000: already on the mullions (through-nodes). */
  done: Id[];
}

function strip(profiles = true): Strip {
  const p = createProject('Junctions');
  const nodes = new Map<string, Id>();
  const node = (q: Vec3) => {
    const k = `${q.x},${q.y},${q.z}`;
    let id = nodes.get(k);
    if (!id) {
      id = newId('n');
      p.nodes[id] = { id, p: q };
      nodes.set(k, id);
    }
    return id;
  };
  const line = (a: Vec3, b: Vec3, props: Partial<Member>) => {
    const id = newId('m');
    p.members[id] = { ...memberDefaults(p), ...props, id, start: node(a), end: node(b) };
    return id;
  };
  const M = { role: 'mullion' as const, profile: profiles ? 'SHS 100x100x5' : null };
  const T = { role: 'transom' as const, profile: profiles ? 'RHS 100x50x4' : null };
  const mullions = [0, 1500, 3000].map((x) => line(v3(x, 0, 0), v3(x, 0, 7000), M));
  const across = line(v3(0, 0, 1200), v3(3000, 0, 1200), T);
  const short = [line(v3(20, 3, 3500), v3(1480, 3, 3500), T), line(v3(1520, 3, 3500), v3(2980, 3, 3500), T)];
  const over = [line(v3(-15, 0, 4700), v3(1500, 0, 4700), T), line(v3(1500, 0, 4700), v3(3015, 0, 4700), T)];
  const done = [line(v3(0, 0, 6000), v3(1500, 0, 6000), T), line(v3(1500, 0, 6000), v3(3000, 0, 6000), T)];
  return { p, mullions, across, short, over, done };
}

const byRole = (p: Project, role: string) => Object.values(p.members).filter((m) => m.role === role);
const onAxisOfSomeMullion = (p: Project, n: Id) => byRole(p, 'mullion').some((m) => pointSegment(p.nodes[n].p, p.nodes[m.start].p, p.nodes[m.end].p).d < 1e-6);

describe('junction rule (shared with the wireframe check)', () => {
  it('cuts transoms, and mullions only with splitMullions', () => {
    expect(cutAtTee('mullion', 'transom', false)).toBe(false);
    expect(cutAtTee('mullion', 'transom', true)).toBe(true);
    expect(cutAtTee('transom', 'mullion', false)).toBe(true);
    expect(cutAtTee('transom', 'transom', true)).toBe(false);
    expect(cutAtCrossing('mullion', 'rail', false)).toEqual([false, true]);
    expect(cutAtCrossing('rail', 'post', true)).toEqual([true, true]);
    expect(cutAtCrossing('mullion', 'mullion', true)).toEqual([false, false]);
  });
});

describe('divideAtMullions', () => {
  it('finds crossings and ends that stop short or run past, but not junctions that already meet', () => {
    const s = strip();
    const js = findMullionJunctions(s.p);
    expect(js.filter((j) => j.kind === 'cross').map((j) => j.transom)).toEqual([s.across]);
    // 2 short bays (4 ends; the two at the middle mullion share one node) + the 2 overshooting outer ends.
    expect(js.filter((j) => j.kind === 'end')).toHaveLength(6);
    expect(js.some((j) => s.done.includes(j.transom))).toBe(false);
  });

  it('divides crossing transoms at a node on the mullion axis and moves ends onto it; mullions stay continuous', () => {
    const s = strip();
    const p = s.p;
    const r = divideAtMullions(p);
    expect(r).toMatchObject({ divided: 1, cuts: 1, snapped: 6, nodes: 1, skipped: [] });
    expect(r.message).toMatch(/Divided 1 transom at the mullions \(1 cut, mullions continuous\); 6 transom ends moved onto a mullion axis/);
    // The mullions are not cut.
    expect(byRole(p, 'mullion').map((m) => m.id).sort()).toEqual([...s.mullions].sort());
    // Every transom end now sits on a mullion axis; the mullion passes through the node.
    for (const t of byRole(p, 'transom')) {
      for (const n of [t.start, t.end]) {
        expect(onAxisOfSomeMullion(p, n)).toBe(true);
        expect(membersAtNode(p, n).some((x) => x.member.role === 'mullion' && x.at === 'through')).toBe(true);
      }
    }
    // The crossing transom is two pieces sharing the junction node at x = 1500.
    const pieces = byRole(p, 'transom').filter((m) => p.nodes[m.start].p.z === 1200);
    expect(pieces).toHaveLength(2);
    const shared = [pieces[0].start, pieces[0].end].find((n) => n === pieces[1].start || n === pieces[1].end)!;
    expect(p.nodes[shared].p).toEqual({ x: 1500, y: 0, z: 1200 });
    // The two short bays meet the middle mullion at one node (clustered within the tolerance).
    const [l, rr] = s.short.map((id) => p.members[id]);
    expect(l.end).toBe(rr.start);
    expect(p.nodes[l.end].p).toEqual({ x: 1500, y: 0, z: 3500 });
    // Overshooting ends are trimmed back onto the outer axes.
    expect(p.nodes[p.members[s.over[0]].start].p.x).toBeCloseTo(0, 9);
    expect(p.nodes[p.members[s.over[1]].end].p.x).toBeCloseTo(3000, 9);
    // Nothing left; the wireframe check agrees (no junction to snap or cut with continuous mullions).
    expect(findMullionJunctions(p)).toEqual([]);
    expect(divideAtMullions(p).junctions).toBe(0);
    const check = analyzeWireframe(p);
    expect(check.items.filter((i) => i.actionable && i.accepted && (i.group === 'junction' || i.group === 'crossing'))).toEqual([]);
    expect(check.after.connected).toBe(check.after.junctions);
  });

  it('auto-connect then places a transom joint at every through-node', () => {
    const s = strip();
    // Before: only the ends already on a mullion axis (z = 6000, the crossing line's ends, the overshooting lines' inner ends).
    expect(planAutoConnect(s.p, AUTO_DEFAULTS).counts.transomJoint).toBe(8);
    divideAtMullions(s.p);
    expect(planAutoConnect(s.p, AUTO_DEFAULTS).counts.transomJoint).toBe(byRole(s.p, 'transom').length * 2);
  });

  it('scope: touching members (a mullion divides the transoms crossing it), or only the given transoms', () => {
    const a = strip();
    const r = divideAtMullions(a.p, { members: [a.mullions[1]] });
    // The crossing and the two short ends at the middle mullion.
    expect(r.divided).toBe(1);
    expect(r.snapped).toBe(2);
    const b = strip();
    const r2 = divideAtMullions(b.p, { members: [b.short[0]], mode: 'divide' });
    expect(r2).toMatchObject({ divided: 0, snapped: 2 });
    expect(findMullionJunctions(b.p).some((j) => j.transom === b.short[0])).toBe(false);
    expect(findMullionJunctions(b.p).some((j) => j.transom === b.across)).toBe(true);
  });

  it('keeps connections, end details and manual assemblies on the right piece', () => {
    const s = strip();
    const p = s.p;
    const t = p.members[s.across];
    t.startExt = 7;
    t.endPrep = { kind: 'bevel', angleWeb: 10, angleFlange: 0 };
    const c = addConnection(p, 'angleCleat', t.end, s.mullions[2], [t.id]);
    p.assemblyGroups.push({ id: 'ag1', members: [t.id], plates: [] });
    divideAtMullions(p);
    const pieces = byRole(p, 'transom').filter((m) => p.nodes[m.start].p.z === 1200);
    const first = pieces.find((m) => m.id === s.across)!;
    const second = pieces.find((m) => m.id !== s.across)!;
    expect(first.startExt).toBe(7);
    expect(first.endExt).toBe(0);
    expect(first.endPrep).toBeUndefined();
    expect(second.endPrep).toMatchObject({ kind: 'bevel' });
    expect(second.startExt).toBe(0);
    expect(p.connections[c].secondary).toEqual([second.id]);
    expect(p.assemblyGroups[0].members.sort()).toEqual([first.id, second.id].sort());
  });

  it('leaves junctions it cannot fix for review', () => {
    const s = strip();
    const p = s.p;
    // A transom end shared with a bracket (another role): not moved.
    const end = p.members[s.short[0]].start;
    const id = newId('m');
    p.nodes.nb = { id: 'nb', p: v3(20, 400, 3500) };
    p.members[id] = { ...memberDefaults(p), role: 'bracket', id, start: end, end: 'nb' };
    const r = divideAtMullions(p);
    expect(r.skipped.some((x) => /other members/.test(x.reason))).toBe(true);
    expect(p.nodes[end].p).toEqual({ x: 20, y: 3, z: 3500 });
  });
});

describe('profile insertion divides transoms at the mullions (one undo step)', () => {
  beforeEach(() => {
    const s = strip(false);
    s.p.settings.roleProfiles = { mullion: { profile: 'SHS 100x100x5' }, transom: { profile: 'RHS 100x50x4' } };
    useStore.getState().replaceProject(s.p);
  });
  const st = () => useStore.getState();
  const transoms = () => byRole(st().project, 'transom').length;

  it('Profiles by role → Apply to all transoms', () => {
    expect(transoms()).toBe(7);
    applyRoleProfile('transom', 'all');
    expect(transoms()).toBe(8);
    expect(byRole(st().project, 'transom').every((m) => m.profile === 'RHS 100x50x4')).toBe(true);
    expect(findMullionJunctions(st().project)).toEqual([]);
    expect(st().toast?.text ?? '').toMatch(/Divided 1 transom/);
    st().undo();
    expect(transoms()).toBe(7);
    expect(byRole(st().project, 'transom').every((m) => m.profile === null)).toBe(true);
  });

  it('Profiles by role → choosing a profile and "Update all"', async () => {
    const done = setRoleProfileUi('mullion', { profile: 'SHS 120x120x6' });
    // It asks before updating the existing mullions: answer "Update all".
    await Promise.resolve();
    useAsk.getState().ask!.resolve('');
    await done;
    expect(byRole(st().project, 'mullion').every((m) => m.profile === 'SHS 120x120x6')).toBe(true);
    // Updating the mullions divides the transoms crossing them (the mullions stay continuous).
    expect(byRole(st().project, 'mullion')).toHaveLength(3);
    expect(transoms()).toBe(8);
    expect(st().toast?.text ?? '').toMatch(/Updated 3 mullions\. Divided 1 transom/);
    st().undo();
    expect(transoms()).toBe(7);
  });

  it('Assign (active profile and role) and Auto-assign', () => {
    const p = st().project;
    const ids = byRole(p, 'transom').map((m) => m.id);
    st().select({ members: ids });
    st().set({ activeProfile: 'RHS 100x50x4', activeRole: 'transom' });
    assignActiveProfile();
    expect(transoms()).toBe(8);
    st().undo();
    st().select({ members: [] });
    autoAssignSelection();
    // Direction rules: vertical → mullion, horizontal → transom; the crossing is divided in the same step.
    expect(transoms()).toBe(8);
    expect(findMullionJunctions(st().project)).toEqual([]);
  });

  it('assistant: set_role_profiles and auto_assign_profiles report the division', async () => {
    const run = async (name: string, input: Record<string, unknown>) => {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
      return JSON.parse(await runTool(name, input));
    };
    const r = await run('set_role_profiles', { roles: [{ role: 'transom', profile: 'RHS 100x50x4' }] });
    expect(r.dividedAtMullions).toMatchObject({ transoms: 1, cuts: 1, endsSnapped: 6 });
    st().undo();
    const a = await run('auto_assign_profiles', { filter: { all: true } });
    expect(a.dividedAtMullions).toBe(1);
  });
});

describe('performance', () => {
  it('divides a 21,000-member facade in well under the check time (grid broad phase)', () => {
    const p = createProject('Large');
    const keys = new Map<string, Id>();
    const node = (q: Vec3) => {
      const k = `${q.x},${q.y},${q.z}`;
      let id = keys.get(k);
      if (!id) {
        id = newId('n');
        p.nodes[id] = { id, p: q };
        keys.set(k, id);
      }
      return id;
    };
    const line = (a: Vec3, b: Vec3, role: 'mullion' | 'transom') => {
      const id = newId('m');
      p.members[id] = { ...memberDefaults(p), role, id, start: node(a), end: node(b) };
    };
    for (let k = 0; k <= 150; k++) line(v3(k * 1500, 0, 0), v3(k * 1500, 0, 168000), 'mullion');
    for (let j = 1; j <= 140; j++) for (let k = 0; k < 150; k++) line(v3(k * 1500 + 12, 0.5, j * 1200 - 600), v3((k + 1) * 1500 - 12, 0.5, j * 1200 - 600), 'transom');
    const t0 = performance.now();
    const r = divideAtMullions(p);
    const ms = performance.now() - t0;
    expect(r.snapped).toBe(42000);
    expect(byRole(p, 'mullion')).toHaveLength(151);
    expect(ms).toBeLessThan(5000);
  });
});
