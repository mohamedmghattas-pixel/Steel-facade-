import { describe, expect, it } from 'vitest';
import { addLine, createProject } from '../src/core/model/ops';
import { memberAxes, mirrorMembers, reverseMembers, rotateMembers } from '../src/core/model/modify';
import { dot } from '../src/core/model/geometry';

describe('modify operations keep the surface normal', () => {
  it('rotate, mirror and reverse keep the section depth along the (transformed) surface normal', () => {
    const p = createProject('n');
    // A transom on a facade inclined 30° from vertical; surface normal tilted accordingly.
    const id = addLine(p, { x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }, { profile: 'RHS 100x50x4', role: 'transom' })!;
    const n = { x: 0, y: -Math.cos(Math.PI / 6), z: Math.sin(Math.PI / 6) };
    p.members[id].normal = { ...n };
    const z0 = memberAxes(p, p.members[id]).z;
    expect(Math.abs(dot(z0, n))).toBeGreaterThan(0.999);

    rotateMembers(p, [id], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 90);
    const m1 = p.members[id];
    const z1 = memberAxes(p, m1).z;
    expect(Math.abs(dot(z1, m1.normal!))).toBeGreaterThan(0.999);
    // The stored normal turned with the member (−Y·cos30 → +X·cos30 after 90° about Z).
    expect(m1.normal!.x).toBeCloseTo(Math.cos(Math.PI / 6), 6);

    reverseMembers(p, [id]);
    const m2 = p.members[id];
    expect(Math.abs(dot(memberAxes(p, m2).z, m2.normal!))).toBeGreaterThan(0.999);

    mirrorMembers(p, [id], { point: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } });
    const m3 = p.members[id];
    expect(Math.abs(dot(memberAxes(p, m3).z, m3.normal!))).toBeGreaterThan(0.999);
  });
});
