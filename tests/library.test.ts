import { afterEach, describe, expect, it } from 'vitest';
import {
  PROFILES,
  customProfileDefs,
  getProfile,
  parseProfileCsv,
  profileDefsToCsv,
  profileFromDef,
  profileLibraryRevision,
  registerProfiles,
  searchProfiles,
  subscribeProfiles,
  unregisterProfiles,
  type ProfileDef,
} from '../src/core/library/profiles';
import { MATERIALS, densityFactor, findMaterial, getMaterial, yieldStrength } from '../src/core/library/materials';
import { BOLT_GRADES, BOLT_SIZES, boltLength, findBolt, getBolt, getBoltGrade } from '../src/core/library/bolts';
import { ANCHORS, ANCHOR_DISCLAIMER, FASTENERS, SCREWS, anchorsOfType, getFastener } from '../src/core/library/fasteners';
import { STANDARD_DOCS, getStandardDoc, standardsFor } from '../src/core/library/standards';

describe('custom profiles', () => {
  afterEach(() => void unregisterProfiles(customProfileDefs().map((d) => d.name)));

  it('builds a profile from a definition with computed mass', () => {
    const p = profileFromDef({ name: 'Rail 60x40x3', shape: { type: 'RHS', h: 60, b: 40, t: 3, ro: 6 } });
    expect(p.standard).toBe('Custom');
    expect(p.family).toBe('Custom RHS');
    expect(p.massSource).toBe('computed');
    expect(p.mass).toBeCloseTo(getProfile('RHS 60x40x3')!.mass, 6);
    expect(() => profileFromDef({ name: 'Bad', shape: { type: 'CHS', d: 20, t: 12 } })).toThrow(/wall/);
    expect(() => profileFromDef({ name: ' ', shape: { type: 'RD', d: 20 } })).toThrow(/name/);
  });

  it('registers, finds, replaces and removes custom profiles in the live catalogue', () => {
    const before = PROFILES.length;
    const rev = profileLibraryRevision();
    let calls = 0;
    const off = subscribeProfiles(() => calls++);
    const n = registerProfiles([
      { name: 'Mullion T 120', family: 'Mullions', shape: { type: 'T', h: 120, b: 60, tw: 6, tf: 8, r: 4 }, mass: 9.5 },
      { name: 'Broken', shape: { type: 'FL', h: -1, t: 5 } },
    ]);
    expect(n).toBe(1);
    expect(PROFILES.length).toBe(before + 1);
    expect(profileLibraryRevision()).toBeGreaterThan(rev);
    expect(calls).toBe(1);
    const p = getProfile('Mullion T 120')!;
    expect(p.custom).toBe(true);
    expect(p.mass).toBe(9.5);
    expect(p.massSource).toBe('user');
    expect(searchProfiles('mullion', 'Custom').map((x) => x.name)).toEqual(['Mullion T 120']);

    // replace
    expect(registerProfiles([{ name: 'Mullion T 120', shape: { type: 'T', h: 120, b: 80, tw: 6, tf: 8, r: 4 } }])).toBe(1);
    expect(getProfile('Mullion T 120')!.b).toBe(80);
    expect(PROFILES.length).toBe(before + 1);

    // built-ins are protected unless asked
    const ipe = getProfile('IPE 200')!;
    expect(registerProfiles([{ name: 'IPE 200', shape: { type: 'FL', h: 200, t: 10 } }])).toBe(0);
    expect(getProfile('IPE 200')).toBe(ipe);
    expect(registerProfiles([{ name: 'IPE 200', shape: { type: 'FL', h: 200, t: 10 } }], { replaceBuiltIn: true })).toBe(1);
    expect(getProfile('IPE 200')!.shape.type).toBe('FL');
    expect(unregisterProfiles(['IPE 200', 'Mullion T 120', 'not there'])).toBe(2);
    expect(getProfile('IPE 200')).toBe(ipe);
    expect(getProfile('Mullion T 120')).toBeUndefined();
    expect(PROFILES.length).toBe(before);
    off();
  });

  it('round-trips profiles through the documented CSV format', () => {
    const csv = [
      '# custom facade sections',
      'name,family,type,h,b,tw,tf,r,t,d,c,mass',
      'Rail C120,Rails,C,120,50,,,2,2,,15,',
      'Bracket tee,Tees,T,80,100,8,10,6,,,,',
      'Tube 60x3,,CHS,,,,,,3,60,,4.22',
      '"Box 80x40, special",,RHS,80,40,,,8,4,,,',
      'Pin 30,,RD,,,,,,,30,,',
      'Plate strip,,FL,150,,,,,12,,,',
      'Angle 70x50x6,Angles,L,70,50,,,7,6,,,',
      'Purlin Z,,Z,200,70,,,3,2.5,,20,',
      'Sq 25,,SQ,25,,,,,,,,',
      'Heavy I,,I,300,150,8,12,15,,,,',
    ].join('\n');
    const { defs, errors } = parseProfileCsv(csv);
    expect(errors).toEqual([]);
    expect(defs.map((d) => d.name)).toEqual([
      'Rail C120', 'Bracket tee', 'Tube 60x3', 'Box 80x40, special', 'Pin 30', 'Plate strip', 'Angle 70x50x6', 'Purlin Z', 'Sq 25', 'Heavy I',
    ]);
    expect(defs[0].shape).toEqual({ type: 'C', h: 120, b: 50, c: 15, t: 2, r: 2 });
    expect(defs[2]).toMatchObject({ mass: 4.22, shape: { type: 'CHS', d: 60, t: 3 } });
    expect(defs[3].shape).toEqual({ type: 'RHS', h: 80, b: 40, t: 4, ro: 8 });
    expect(defs[8].shape).toEqual({ type: 'FL', h: 25, t: 25 });

    expect(registerProfiles(defs)).toBe(defs.length);
    expect(getProfile('Rail C120')!.family).toBe('Rails');
    expect(getProfile('Tube 60x3')!.mass).toBe(4.22);

    const again = parseProfileCsv(profileDefsToCsv(customProfileDefs()));
    expect(again.errors).toEqual([]);
    const strip = (d: ProfileDef) => ({ ...d, standard: d.standard ?? 'Custom' });
    expect(again.defs.map(strip)).toEqual(customProfileDefs().map(strip));
  });

  it('accepts semicolon CSV with decimal commas and reports bad rows', () => {
    const { defs, errors } = parseProfileCsv(
      [
        'NAME;Type;h;b;t;r;standard',
        'Hoek 40;L;40;40;4;6;EN',
        'Buis 2,5;SHS;50;;2,5;;',
        'Leeg;L;40;;4;;',
        'Fout;X;1;1;1;;',
        'Dik;RHS;20;20;12;;',
        'Hoek 40;L;40;40;4;;',
        'Std;FL;40;;5;;ISO',
      ].join('\r\n'),
    );
    expect(defs.map((d) => d.name)).toEqual(['Hoek 40', 'Buis 2,5']);
    expect(defs[0].standard).toBe('EN');
    expect(defs[1].shape).toEqual({ type: 'RHS', h: 50, b: 50, t: 2.5, ro: 5 });
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatch(/line 4 .*needs b/);
    expect(errors.join('\n')).toMatch(/unknown type "X"/);
    expect(errors.join('\n')).toMatch(/wall too thick/);
    expect(errors.join('\n')).toMatch(/duplicate name/);
    expect(errors.join('\n')).toMatch(/unknown standard "ISO"/);
    expect(parseProfileCsv('name,h\nA,1').errors[0]).toMatch(/header/);
  });
});

describe('materials', () => {
  it('keeps the original names resolving with sensible values', () => {
    for (const n of ['S235', 'S275', 'S355', '1.4301', '1.4401', 'A36', 'A992', 'A500 Gr C', 'A572 Gr 50']) {
      expect(getMaterial(n).name, n).toBe(n);
    }
    expect(getMaterial('S355').fy).toBe(355);
    expect(getMaterial('A36').fy).toBe(248);
    expect(getMaterial('A992').fu).toBe(448);
    expect(getMaterial('A500 Gr C').fy).toBe(345);
    expect(getMaterial('1.4301').standard).toBe('Stainless');
    expect(getMaterial('unknown grade').name).toBe('S355');
    expect(densityFactor('1.4401')).toBeCloseTo(8000 / 7850, 6);
    expect(densityFactor('6060 T66')).toBeCloseTo(2700 / 7850, 6);
  });

  it('has unique names and complete data', () => {
    const names = MATERIALS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of MATERIALS) {
      expect(m.fu, m.name).toBeGreaterThan(m.fy);
      expect(m.E, m.name).toBeGreaterThan(60000);
      expect(m.alpha, m.name).toBeGreaterThan(1e-5);
      expect(['carbon', 'stainless', 'aluminium', 'weathering']).toContain(m.family);
      expect(m.spec.length, m.name).toBeGreaterThan(3);
    }
    for (const n of ['S235JR', 'S275JR', 'S355J2', 'S355K2', 'S420ML', 'S460M', 'S460N', 'S355J2H', 'S355J2W', '1.4307', '1.4404', '1.4571', '1.4462', '1.4162',
      'A500 Gr B', 'A1085', 'A53 Gr B', 'A588', 'A847', 'A240 304', 'A240 316', '6060 T66', '6063 T6', '6082 T6', '6005A T6']) {
      expect(findMaterial(n)?.name, n).toBe(n);
    }
  });

  it('finds materials by alias and gives thickness-dependent yield', () => {
    expect(findMaterial('316L')?.name).toBe('1.4404');
    expect(findMaterial('EN AW-6060 T66')?.name).toBe('6060 T66');
    expect(findMaterial('s355j2h')?.name).toBe('S355J2H');
    expect(findMaterial('nope')).toBeUndefined();
    expect(yieldStrength('S355J2', 10)).toBe(355);
    expect(yieldStrength('S355J2', 30)).toBe(345);
    expect(yieldStrength('S275JR', 50)).toBe(255);
    expect(yieldStrength('6082 T6', 4)).toBe(250);
    expect(getMaterial('S355J2').ec3).toEqual({ fy: 355, fu: 510 });
    const al = getMaterial('6063 T6');
    expect([al.density, al.E, al.category, al.family]).toEqual([2700, 70000, 'Aluminium', 'aluminium']);
    expect(getMaterial('1.4462').forms?.P).toEqual([460, 640]);
  });
});

describe('fasteners', () => {
  it('keeps BOLT_SIZES / getBolt / boltLength compatible', () => {
    expect(getBolt('M12').hole).toBe(13);
    expect(getBolt('M16').hole).toBe(18);
    expect(getBolt('M20').hole).toBe(22);
    expect(getBolt('M24').hole).toBe(26);
    expect(getBolt('M27').hole).toBe(30);
    expect(getBolt('M14').hole).toBe(15);
    expect(getBolt('unknown').name).toBe('M12');
    expect(getBolt('M16')).toMatchObject({ head: 10, af: 24, nut: 14.8, washer: 3, washerOD: 30, As: 157 });
    expect(getBolt('1/2"').hole).toBeCloseTo(14.3, 1); // 9/16"
    expect(getBolt('3/4"').hole).toBeCloseTo(20.6, 1); // 13/16"
    expect(getBolt('1"').hole).toBeCloseTo(28.6, 1); // 1-1/8" (AISC 360-16)
    expect(getBolt('3/4"').af).toBeCloseTo(31.8, 1); // heavy hex 1-1/4"
    expect(getBolt('M20 HV')).toMatchObject({ af: 32, head: 13, nut: 16, washer: 4, preloadable: true });
    expect(findBolt('m16hv')?.name).toBe('M16 HV');
    expect(findBolt('5/8')?.name).toBe('5/8"');
    const names = BOLT_SIZES.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['M8', 'M10', 'M12', 'M16', 'M20', 'M24', 'M30', 'M36', '1/2"', '5/8"', '3/4"', '7/8"', '1"', '1-1/4"']) expect(names).toContain(n);
    const len = boltLength(getBolt('M16'), 20);
    expect(len).toBeGreaterThanOrEqual(20 + 6 + 14.8);
    expect(len % 5).toBe(0);
  });

  it('has bolt grades with strengths', () => {
    for (const g of ['4.6', '8.8', '10.9', 'A2-70', 'A4-70', 'A307', 'A325', 'F1554-36']) expect(BOLT_GRADES).toContain(g);
    expect(getBoltGrade('8.8')).toMatchObject({ fyb: 640, fub: 800 });
    expect(getBoltGrade('A4-80')).toMatchObject({ fyb: 600, fub: 800 });
    expect(getBoltGrade('F3125 A325')?.fub).toBe(827);
    expect(getBoltGrade('A490')?.fub).toBe(1034);
    expect(getBoltGrade('F1554-105')).toMatchObject({ fyb: 724, anchorRod: true });
  });

  it('lists generic anchors with typical (labelled) setting data', () => {
    for (const t of ['wedge', 'bonded', 'screw', 'undercut', 'headed', 'channel'] as const) expect(anchorsOfType(t).length, t).toBeGreaterThan(2);
    for (const a of ANCHORS) {
      expect(a.note).toBe(ANCHOR_DISCLAIMER);
      expect(a.fixtureHole, a.name).toBeGreaterThan(a.d);
      expect(a.hef, a.name).toBeGreaterThan(0);
      expect(a.sCrN).toBe(3 * a.hef);
      expect(a.cCrN).toBe(1.5 * a.hef);
      expect(a.hMin, a.name).toBeGreaterThan(a.hef);
      if (a.type === 'headed' || a.type === 'channel') expect(a.drill).toBe(0);
      else expect(a.drill, a.name).toBeGreaterThanOrEqual(a.d);
    }
    expect(getFastener('Wedge M12')).toMatchObject({ kind: 'anchor', drill: 12, fixtureHole: 14 });
    expect(getFastener('Bonded M16')).toMatchObject({ drill: 18, hef: 64, hefMax: 320, sMin: 80 });
    expect(getFastener('Headed M20')).toMatchObject({ hef: 240, cMin: 100 });
    expect(getFastener('Channel 40/22 M16')).toMatchObject({ channel: '40/22', fixtureHole: 18 });
  });

  it('combines bolts, anchors and screws into one catalogue', () => {
    const names = FASTENERS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(getFastener('M16')?.kind).toBe('bolt');
    expect(getFastener('SDS 5.5')).toMatchObject({ kind: 'screw', af: 8 });
    expect(SCREWS.length).toBeGreaterThan(2);
    expect(getFastener('nothing')).toBeUndefined();
  });
});

describe('standards registry', () => {
  it('documents every spec used by the library', () => {
    const ids = new Set(STANDARD_DOCS.map((d) => d.id));
    expect(ids.size).toBe(STANDARD_DOCS.length);
    const specs = new Set([...PROFILES.map((p) => p.spec), ...MATERIALS.map((m) => m.spec)]);
    for (const s of specs) expect(standardsFor(s).length, String(s)).toBeGreaterThan(0);
    expect(standardsFor(BOLT_SIZES[0].spec).map((d) => d.id)).toEqual(['ISO 4014', 'ISO 4017', 'ISO 4032', 'ISO 7089']);
    expect(getStandardDoc('EN 10219-2')?.year).toBe(2019);
  });
});
