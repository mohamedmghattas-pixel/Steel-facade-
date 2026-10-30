import { describe, expect, it } from 'vitest';
import {
  PROFILES,
  STANDARDS_LIST,
  getProfile,
  parseInch,
  profileFamilies,
  searchProfiles,
} from '../src/core/library/profiles';
import { shapeBox, shapeOutline } from '../src/core/library/shapes';

const LBFT = 1.48816394;

/** Catalogue masses (kg/m) for sections whose mass is computed from geometry. */
const CATALOGUE: [string, number][] = [
  ['SHS 100x100x5', 14.4],
  ['SHS 50x50x3', 4.25],
  ['RHS 100x50x4', 8.59],
  ['RHS 200x100x6', 26.4],
  ['CHS 88.9x4', 8.38],
  ['CHS 48.3x3.2', 3.56],
  ['CHS 168.3x6.3', 25.2],
  ['L 50x50x5', 3.77],
  ['L 100x100x10', 15.0],
  ['L 100x50x6', 6.85],
  ['L 150x150x15', 33.8],
  ['L 200x200x20', 59.9],
  ['L 150x90x10', 18.2],
  ['FL 100x10', 7.85],
  ['SHS 100x100x5 HF', 14.7],
  ['SHS 200x200x10 HF', 58.8],
  ['RHS 200x100x6.3 HF', 28.1],
  ['RD 20', 2.47],
  ['HSS4x4x1/4', 12.21 * LBFT],
  ['HSS6x4x1/4', 15.62 * LBFT],
  ['HSS6x6x1/4', 19.02 * LBFT],
  ['HSS8x8x1/2', 48.85 * LBFT],
  ['HSS6.625x0.280', 18.97 * LBFT],
  ['Pipe2STD', 3.66 * LBFT],
  ['Pipe4STD', 10.79 * LBFT],
  ['L4x4x1/4', 6.6 * LBFT],
  ['L6x6x3/8', 14.9 * LBFT],
];

/** Catalogue masses of rolled sections (kg/m). */
const ROLLED: [string, number][] = [
  ['IPE 300', 42.2],
  ['IPE 600', 122],
  ['HEA 200', 42.3],
  ['HEB 300', 117],
  ['HEM 300', 238],
  ['IPN 200', 26.2],
  ['UPN 200', 25.3],
  ['UPE 200', 22.8],
  ['T 50x50x6', 4.44],
  ['UB 305x165x40', 40.3],
  ['UB 533x210x92', 92.1],
  ['UC 203x203x46', 46.1],
  ['PFC 200x90x30', 29.7],
  ['W12x26', 26 * LBFT],
  ['W8x31', 31 * LBFT],
  ['WT6x13', 13 * LBFT],
  ['S8x18.4', 18.4 * LBFT],
  ['C10x15.3', 15.3 * LBFT],
  ['MC8x21.4', 21.4 * LBFT],
];

describe('profile library', () => {
  it('has unique names across the whole catalogue', () => {
    const names = PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of ['EN', 'BS', 'AISC'] as const) expect(PROFILES.some((p) => p.standard === s), s).toBe(true);
    expect(PROFILES.length).toBeGreaterThan(1800);
  });

  it('keeps every original profile name resolving', () => {
    // Names that existed before the library was expanded (saved projects reference them).
    const legacy = [
      'SHS 100x100x5', 'SHS 80x80x4', 'SHS 40x40x2', 'SHS 200x200x10', 'RHS 100x50x4', 'RHS 80x40x3', 'RHS 120x60x4', 'RHS 250x150x8',
      'CHS 48.3x3.2', 'CHS 88.9x4', 'CHS 219.1x10', 'L 60x60x6', 'L 100x50x8', 'L 20x20x3', 'L 150x100x10', 'FL 100x10', 'FL 250x5', 'FL 20x5',
      'C 150x65x20x2', 'Z 200x75x20x2.5', 'C 100x50x15x1.5', 'IPE 80', 'IPE 400', 'HEA 300', 'HEB 100', 'UPN 50', 'UPN 300',
      'W4x13', 'W8x31', 'W12x35', 'C3x4.1', 'C12x20.7', 'L2x2x1/8', 'L6x4x3/8', 'L3-1/2x2-1/2x1/4', 'HSS4x4x1/4', 'HSS6x4x1/4', 'HSS2x2x1/8',
      'HSS8x6x1/4', 'HSS1.900x0.145', 'HSS6.625x0.280',
    ];
    for (const n of legacy) expect(getProfile(n)?.name, n).toBe(n);
  });

  it('computes area of every rolled section (I, U, T) within 3 % of the catalogue mass', () => {
    const rolled = PROFILES.filter((p) => p.massSource === 'catalogue');
    expect(rolled.length).toBeGreaterThan(450);
    for (const p of rolled) {
      expect(['I', 'U', 'T']).toContain(p.shape.type);
      const computed = (p.area * 7850) / 1e6;
      expect(Math.abs(computed - p.mass) / p.mass, p.name).toBeLessThan(0.03);
    }
  });

  it.each(ROLLED)('%s catalogue mass %d kg/m', (name, mass) => {
    const p = getProfile(name);
    expect(p, name).toBeDefined();
    expect(Math.abs(p!.mass - mass) / mass).toBeLessThan(0.005);
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

  it('computes plastic moduli and principal axes', () => {
    const ipe = getProfile('IPE 300')!;
    expect(ipe.Wply! / 1e3).toBeCloseTo(628, -1); // catalogue 628.4 cm³
    expect(ipe.Wplz! / 1e3).toBeCloseTo(125, -1); // 125.2 cm³
    const shs = getProfile('SHS 100x100x5')!;
    expect(shs.Wply! / 1e3).toBeCloseTo(64.6, 0);
    const chs = getProfile('CHS 168.3x6.3')!;
    expect(chs.Iy / 1e4).toBeCloseTo(1053, -1); // catalogue 1053 cm⁴
    const l = getProfile('L 100x100x10')!;
    expect(l.Iu! / 1e4).toBeCloseTo(281, -1); // 280.7 cm⁴
    expect(Math.abs(l.Iv! / 1e4 / 72.9 - 1)).toBeLessThan(0.02); // 72.9 cm⁴
    expect(Math.abs(l.alpha!)).toBeCloseTo(Math.PI / 4, 5);
    expect(l.cy! + 50).toBeCloseTo(28.2, 0); // centroid 28.2 mm from the heel
  });

  it('draws outlines centred on the bounding box for every shape type', () => {
    const seen = new Set<string>();
    const types = new Set<string>();
    for (const p of PROFILES) {
      types.add(p.shape.type);
      if (seen.has(p.shape.type + p.family)) continue;
      seen.add(p.shape.type + p.family);
      const o = shapeOutline(p.shape);
      const xs = o.outer.map((v) => v.x);
      const ys = o.outer.map((v) => v.y);
      const box = shapeBox(p.shape);
      expect(Math.max(...xs) - Math.min(...xs), p.name).toBeCloseTo(box.w, 0);
      expect(Math.max(...ys) - Math.min(...ys), p.name).toBeCloseTo(box.h, 0);
      expect(Math.abs(Math.max(...xs) + Math.min(...xs)), p.name).toBeLessThan(0.5);
      expect(Math.abs(Math.max(...ys) + Math.min(...ys)), p.name).toBeLessThan(0.5);
      expect(p.area).toBeGreaterThan(0);
    }
    expect([...types].sort()).toEqual(['C', 'CHS', 'FL', 'I', 'L', 'RD', 'RHS', 'T', 'U', 'Z']);
  });

  it('parses inch fractions and searches loosely', () => {
    expect(parseInch('2-1/2')).toBe(2.5);
    expect(parseInch('3/8')).toBe(0.375);
    expect(searchProfiles('shs100').length).toBeGreaterThan(2);
    expect(searchProfiles('hss4x4', 'AISC').every((p) => p.standard === 'AISC')).toBe(true);
    expect(searchProfiles('L 60')[0].name.startsWith('L 60')).toBe(true);
    expect(searchProfiles('ub305', 'BS').length).toBeGreaterThan(5);
  });

  it('resolves aliases and loose spellings', () => {
    expect(getProfile('HE 200 A')?.name).toBe('HEA 200');
    expect(getProfile('hea200')?.name).toBe('HEA 200');
    expect(getProfile('UKB 305x165x40')?.name).toBe('UB 305x165x40');
    expect(getProfile('shs 100x100x5')?.name).toBe('SHS 100x100x5');
    expect(getProfile('nope 1x2')).toBeUndefined();
    expect(getProfile(undefined)).toBeUndefined();
  });

  it('lists standards and families for pickers', () => {
    expect(STANDARDS_LIST.map((s) => s.value)).toEqual(['EN', 'BS', 'AISC', 'Custom']);
    expect(profileFamilies('BS')).toEqual(['UB', 'UC', 'PFC']);
    expect(profileFamilies('EN')).toEqual(expect.arrayContaining(['IPE', 'HEA', 'SHS', 'SHS HF', 'RHS HF', 'CHS', 'RD', 'T', 'C (cold-formed)']));
    expect(profileFamilies('AISC')).toEqual(expect.arrayContaining(['W', 'WT', 'S', 'C', 'MC', 'L', 'HSS rect', 'HSS round', 'Pipe']));
  });
});
