import { describe, expect, it } from 'vitest';
import { PROFILES, getProfile, parseInch, searchProfiles } from '../src/core/library/profiles';

/** Catalogue masses (kg/m) for sections whose mass is computed from geometry. */
const CATALOGUE: [string, number][] = [
  ['SHS 100x100x5', 14.4],
  ['SHS 50x50x3', 4.25],
  ['RHS 100x50x4', 8.59],
  ['RHS 200x100x6', 26.4],
  ['CHS 88.9x4', 8.38],
  ['CHS 48.3x3.2', 3.56],
  ['L 50x50x5', 3.77],
  ['L 100x100x10', 15.0],
  ['L 100x50x6', 6.85],
  ['FL 100x10', 7.85],
  ['HSS4x4x1/4', 12.21 * 1.48816],
  ['HSS6x4x1/4', 15.62 * 1.48816],
];

describe('profile library', () => {
  it('has unique names in both standards', () => {
    const names = PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(PROFILES.some((p) => p.standard === 'EN')).toBe(true);
    expect(PROFILES.some((p) => p.standard === 'AISC')).toBe(true);
  });

  it('computes area of rolled sections close to the catalogue mass', () => {
    for (const name of ['IPE 200', 'HEA 200', 'HEB 200', 'IPE 300']) {
      const p = getProfile(name)!;
      const computed = (p.area * 7850) / 1e6;
      expect(Math.abs(computed - p.mass) / p.mass).toBeLessThan(0.02);
    }
  });

  it.each(CATALOGUE)('%s mass close to %d kg/m', (name, mass) => {
    const p = getProfile(name);
    expect(p, name).toBeDefined();
    expect(Math.abs(p!.mass - mass) / mass).toBeLessThan(0.02);
  });

  it('has sensible stiffness (IPE 200 Iy about 1943 cm4)', () => {
    const p = getProfile('IPE 200')!;
    expect(p.Iy / 1e4).toBeGreaterThan(1900);
    expect(p.Iy / 1e4).toBeLessThan(1990);
    expect(p.Iz).toBeLessThan(p.Iy);
  });

  it('parses inch fractions and searches loosely', () => {
    expect(parseInch('2-1/2')).toBe(2.5);
    expect(parseInch('3/8')).toBe(0.375);
    expect(searchProfiles('shs100').length).toBeGreaterThan(2);
    expect(searchProfiles('hss4x4', 'AISC').every((p) => p.standard === 'AISC')).toBe(true);
  });
});
