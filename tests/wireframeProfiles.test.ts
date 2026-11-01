import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../src/state/store';
import { addLine, createProject } from '../src/core/model/ops';
import { applyWireframeCheck, runWireframeCheck } from '../src/ui/wireframeActions';

/** A sloped facade strip: two mullions down the slope, three transoms ending on them (no profiles yet). */
function sloped() {
  const p = createProject('Wireframe + role profiles');
  const mull = (x: number) => addLine(p, { x, y: 0, z: 0 }, { x, y: 2000, z: 3464 }, { profile: null })!;
  mull(0);
  mull(1500);
  for (const t of [0.25, 0.5, 0.75]) addLine(p, { x: 0, y: 2000 * t, z: 3464 * t }, { x: 1500, y: 2000 * t, z: 3464 * t }, { profile: null });
  p.settings.roleProfiles = { mullion: { profile: 'SHS 100x100x5' }, transom: { profile: 'RHS 100x50x4' } };
  return p;
}

describe('wireframe check assigns role profiles', () => {
  beforeEach(() => useStore.getState().replaceProject(sloped()));

  it('gives unprofiled mullions and transoms their role profile in the same undo step', () => {
    const plan = runWireframeCheck({}, null);
    const accepted = new Set(plan.items.filter((i) => i.accepted).map((i) => i.id));
    const res = applyWireframeCheck(plan, accepted, undefined, 'all');
    const ms = Object.values(useStore.getState().project.members);
    const mullions = ms.filter((m) => m.role === 'mullion');
    const transoms = ms.filter((m) => m.role === 'transom');
    expect(mullions.length).toBeGreaterThan(0);
    expect(transoms.length).toBe(3);
    expect(mullions.every((m) => m.profile === 'SHS 100x100x5')).toBe(true);
    expect(transoms.every((m) => m.profile === 'RHS 100x50x4')).toBe(true);
    expect(res.profiled).toBe(ms.length);
    useStore.getState().undo();
    expect(Object.values(useStore.getState().project.members).every((m) => m.profile === null)).toBe(true);
  });

  it('keeps profiles the user already assigned and can be switched off', () => {
    const p = useStore.getState().project;
    const first = Object.values(p.members)[0].id;
    useStore.getState().apply('preset', (d) => void (d.members[first].profile = 'SHS 120x120x6'));
    const plan = runWireframeCheck({}, null);
    const accepted = new Set(plan.items.filter((i) => i.accepted).map((i) => i.id));
    applyWireframeCheck(plan, accepted, undefined, 'all');
    expect(Object.values(useStore.getState().project.members).some((m) => m.profile === 'SHS 120x120x6')).toBe(true);
    useStore.getState().undo();
    const plan2 = runWireframeCheck({}, null);
    const res2 = applyWireframeCheck(plan2, new Set(plan2.items.filter((i) => i.accepted).map((i) => i.id)), undefined, 'all', { assignRoleProfiles: false });
    expect(res2.profiled).toBe(0);
  });
});
