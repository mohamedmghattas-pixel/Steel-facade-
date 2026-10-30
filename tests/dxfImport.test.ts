import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dxfUnitScale, importDxfWireframe, parseDxf } from '../src/core/io/dxfImport';
import { createProject } from '../src/core/model/ops';

const text = readFileSync(new URL('./fixtures/facade-elevation.dxf', import.meta.url), 'utf8');

describe('DXF wireframe import', () => {
  const parsed = parseDxf(text);

  it('reads lines and polylines, skipping annotation', () => {
    expect(parsed.layers).toEqual(['MULLION', 'TRANSOM']);
    expect(parsed.segments).toHaveLength(3 + 2 + 2);
    expect(parsed.insunits).toBe(4);
    expect(parsed.bounds.max.x).toBe(3000);
    expect(parsed.bounds.max.y).toBe(3500);
  });

  it('maps units', () => {
    expect(dxfUnitScale(4)).toBe(1);
    expect(dxfUnitScale(6)).toBe(1000);
    expect(dxfUnitScale(1)).toBe(25.4);
    expect(dxfUnitScale(null)).toBe(1);
  });

  it('places a 2D elevation on the XZ plane, applies layer rules and splits', () => {
    const p = createProject();
    const ids = importDxfWireframe(p, parsed, {
      plane: { kind: 'XZ', offset: 500 },
      scale: 1,
      offset: { x: 0, y: 0 },
      layerRules: {
        MULLION: { profile: 'SHS 100x100x5', role: 'mullion' },
        TRANSOM: { profile: 'RHS 80x40x3', role: 'transom' },
      },
      splitIntersections: true,
      use3d: false,
    });
    expect(ids).toHaveLength(12);
    expect(Object.keys(p.members)).toHaveLength(12);
    expect(Object.keys(p.nodes)).toHaveLength(9);
    const ms = Object.values(p.members);
    expect(ms.filter((m) => m.role === 'mullion')).toHaveLength(6);
    expect(ms.filter((m) => m.layer === 'TRANSOM' && m.profile === 'RHS 80x40x3')).toHaveLength(6);
    for (const n of Object.values(p.nodes)) expect(n.p.y).toBe(500);
    expect(Math.max(...Object.values(p.nodes).map((n) => n.p.z))).toBe(3500);
  });

  it('filters layers and scales', () => {
    const p = createProject();
    importDxfWireframe(p, parsed, {
      plane: { kind: 'XY', offset: 0 },
      scale: 2,
      offset: { x: 100, y: 0 },
      layers: ['MULLION'],
      splitIntersections: false,
      use3d: false,
    });
    expect(Object.keys(p.members)).toHaveLength(3);
    const xs = Object.values(p.nodes).map((n) => n.p.x);
    expect(Math.max(...xs)).toBe(6100);
  });
});
