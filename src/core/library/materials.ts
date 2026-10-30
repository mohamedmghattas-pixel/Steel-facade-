/**
 * Material catalogue: structural carbon, weathering and stainless steels and
 * facade aluminium alloys.
 *
 * fy / fu are the product-standard MINIMUM values for the thickness range in
 * `range` (t ≤ 16 mm unless stated; aluminium: the band covering t ≤ 15/25 mm,
 * stainless: hot-rolled strip "H" per EN 1993-1-4 Table 2.1). Thicker material
 * has lower values — see `fyT` and the product standard. EN carbon steels also
 * carry `ec3`, the simplified nominal values of EN 1993-1-1 Table 3.1 (t ≤ 40 mm),
 * which some National Annexes allow instead of the product-standard values.
 * Verify against the mill certificate / National Annex before design.
 */

export type MaterialFamily = 'carbon' | 'stainless' | 'aluminium' | 'weathering';
/** Picker category, kept compatible with the original field: 'Stainless' covers EN and ASTM stainless grades. */
export type MaterialStandard = 'EN' | 'AISC' | 'Stainless' | 'Aluminium';

export interface Material {
  /** Unique id shown in pickers and written to IFC/DSTV (e.g. "S355J2", "A992", "1.4401"). */
  name: string;
  /** Category for pickers/rules (original meaning): EN, AISC (ASTM), Stainless or Aluminium. */
  standard: MaterialStandard;
  /** Product standard, e.g. "EN 10025-2", "ASTM A992", "EN 10088-4" (see standards.ts). */
  spec: string;
  /** Regional grouping for pickers. */
  region: 'EN' | 'US';
  family: MaterialFamily;
  /** IFC material category. */
  category: 'Steel' | 'Aluminium';
  /** Minimum yield / 0.2 % proof strength, MPa (for `range`). */
  fy: number;
  /** Minimum tensile strength, MPa (for `range`). */
  fu: number;
  /** Thickness range that fy/fu apply to. */
  range: string;
  /** Minimum yield by thickness: [t_max mm, fy MPa] ascending (product standard). */
  fyT?: [number, number][];
  /** EN 1993-1-1 Table 3.1 nominal values for t ≤ 40 mm. */
  ec3?: { fy: number; fu: number };
  /** Stainless product forms per EN 1993-1-4 Table 2.1: C cold-rolled strip (t ≤ 8), H hot-rolled strip (t ≤ 13.5), P hot-rolled plate (t ≤ 75): [fy, fu]. */
  forms?: { C: [number, number]; H: [number, number]; P: [number, number] };
  /** kg/m³ */
  density: number;
  /** Elastic and shear modulus, MPa; Poisson's ratio. */
  E: number;
  G: number;
  nu: number;
  /** Linear thermal expansion coefficient, 1/K (20–100 °C). */
  alpha: number;
  /** IFC/DSTV friendly description. */
  description: string;
  /** Other names that resolve to this material (e.g. "S355JR+AR", "304"). */
  aliases?: string[];
}

const CARBON = { density: 7850, E: 210000, G: 81000, nu: 0.3, alpha: 12e-6, category: 'Steel' as const };
// AISC: E = 29 000 ksi, G = 11 200 ksi, α = 6.5e-6 /°F
const US_CARBON = { density: 7850, E: 199948, G: 77221, nu: 0.3, alpha: 11.7e-6, category: 'Steel' as const };
const AUSTENITIC = { E: 200000, G: 76900, nu: 0.3, alpha: 16e-6, category: 'Steel' as const };
const DUPLEX = { E: 200000, G: 76900, nu: 0.3, alpha: 13e-6, category: 'Steel' as const };
const ALU = { density: 2700, E: 70000, G: 27000, nu: 0.3, alpha: 23e-6, category: 'Aluminium' as const };

const T16 = 't ≤ 16 mm';
const KSI = 6.894757;
const ksi = (v: number) => Math.round(v * KSI);

// EN 10025-2 ReH steps for t ≤ 16, 40, 63, 80, 100, 150 mm.
const steps = (v: number[]): [number, number][] => [16, 40, 63, 80, 100, 150].slice(0, v.length).map((t, i) => [t, v[i]]);
const S235_T = steps([235, 225, 215, 215, 215, 195]);
const S275_T = steps([275, 265, 255, 245, 235, 225]);
const S355_T = steps([355, 345, 335, 325, 315, 295]);
// EN 10025-3 (N/NL) and EN 10025-4 (M/ML), t ≤ 16, 40, 63, 80, 100 mm.
const S275N_T = steps([275, 265, 255, 245, 235]);
const S355N_T = steps([355, 345, 335, 325, 315]);
const S420N_T = steps([420, 400, 390, 370, 360]);
const S460N_T = steps([460, 440, 430, 410, 400]);
const S355M_T = steps([355, 345, 335, 325, 325]);
const S420M_T = steps([420, 400, 390, 380, 370]);
const S460M_T = steps([460, 440, 430, 410, 400]);

const charpy: Record<string, string> = {
  JR: '27 J at +20 °C',
  J0: '27 J at 0 °C',
  J2: '27 J at −20 °C',
  K2: '40 J at −20 °C',
  N: '40 J at −20 °C',
  NL: '27 J at −50 °C',
  M: '40 J at −20 °C',
  ML: '27 J at −50 °C',
};

function en(
  name: string,
  spec: string,
  fy: number,
  fu: number,
  ec3: [number, number] | null,
  fyT: [number, number][] | null,
  description: string,
  family: MaterialFamily = 'carbon',
  aliases?: string[],
): Material {
  return {
    name,
    standard: 'EN',
    spec,
    region: 'EN',
    family,
    ...CARBON,
    fy,
    fu,
    range: T16,
    ...(fyT ? { fyT } : {}),
    ...(ec3 ? { ec3: { fy: ec3[0], fu: ec3[1] } } : {}),
    description,
    ...(aliases ? { aliases } : {}),
  };
}

function sub(grade: string, q: string, spec: string, fy: number, fu: number, ec3: [number, number], fyT: [number, number][], family: MaterialFamily = 'carbon') {
  return en(`${grade}${q}`, spec, fy, fu, ec3, fyT, `${spec} ${grade}${q} (Charpy ${charpy[q.replace(/W$|H$/, '')] ?? q})`, family);
}

function stainless(
  name: string,
  steel: string,
  aisi: string,
  density: number,
  C: [number, number],
  H: [number, number],
  P: [number, number],
  duplex = false,
): Material {
  return {
    name,
    standard: 'Stainless',
    spec: 'EN 10088-4',
    region: 'EN',
    family: 'stainless',
    ...(duplex ? DUPLEX : AUSTENITIC),
    density,
    fy: H[0],
    fu: H[1],
    range: 'hot-rolled strip, t ≤ 13.5 mm (EN 1993-1-4 Table 2.1)',
    forms: { C, H, P },
    description: `Stainless ${name} ${steel} (${aisi}), EN 10088`,
    aliases: [aisi, steel],
  };
}

function us(name: string, spec: string, fyKsi: number, fuKsi: number, description: string, family: MaterialFamily = 'carbon', range = 'all thicknesses in the standard', aliases?: string[]): Material {
  return {
    name,
    standard: family === 'stainless' ? 'Stainless' : 'AISC',
    spec,
    region: 'US',
    family,
    ...US_CARBON,
    fy: ksi(fyKsi),
    fu: ksi(fuKsi),
    range,
    description,
    ...(aliases ? { aliases } : {}),
  };
}

function alu(name: string, alloy: string, temper: string, fy: number, fu: number, range: string, fyT: [number, number][], description: string): Material {
  return { name, standard: 'Aluminium', spec: 'EN 755-2', region: 'EN', family: 'aluminium', ...ALU, fy, fu, range, fyT, description: `${description} (EN AW-${alloy} ${temper})`, aliases: [`${alloy} ${temper}`, `${alloy}-${temper}`, `AW-${alloy} ${temper}`] };
}

export const MATERIALS: Material[] = [
  // Generic grades kept for existing projects (IFC/DSTV write these names).
  en('S235', 'EN 10025-2', 235, 360, [235, 360], S235_T, 'EN 10025 S235JR'),
  en('S275', 'EN 10025-2', 275, 410, [275, 430], S275_T, 'EN 10025 S275JR'),
  en('S355', 'EN 10025-2', 355, 470, [355, 510], S355_T, 'EN 10025 S355J2 / EN 10219 S355J2H'),

  // EN 10025-2 non-alloy structural steels
  sub('S235', 'JR', 'EN 10025-2', 235, 360, [235, 360], S235_T),
  sub('S235', 'J0', 'EN 10025-2', 235, 360, [235, 360], S235_T),
  sub('S235', 'J2', 'EN 10025-2', 235, 360, [235, 360], S235_T),
  sub('S275', 'JR', 'EN 10025-2', 275, 410, [275, 430], S275_T),
  sub('S275', 'J0', 'EN 10025-2', 275, 410, [275, 430], S275_T),
  sub('S275', 'J2', 'EN 10025-2', 275, 410, [275, 430], S275_T),
  sub('S355', 'JR', 'EN 10025-2', 355, 470, [355, 510], S355_T),
  sub('S355', 'J0', 'EN 10025-2', 355, 470, [355, 510], S355_T),
  sub('S355', 'J2', 'EN 10025-2', 355, 470, [355, 510], S355_T),
  sub('S355', 'K2', 'EN 10025-2', 355, 470, [355, 510], S355_T),
  // EN 10025-3 normalized
  sub('S275', 'N', 'EN 10025-3', 275, 370, [275, 390], S275N_T),
  sub('S355', 'N', 'EN 10025-3', 355, 470, [355, 490], S355N_T),
  sub('S355', 'NL', 'EN 10025-3', 355, 470, [355, 490], S355N_T),
  sub('S420', 'N', 'EN 10025-3', 420, 520, [420, 520], S420N_T),
  sub('S460', 'N', 'EN 10025-3', 460, 540, [460, 540], S460N_T),
  sub('S460', 'NL', 'EN 10025-3', 460, 540, [460, 540], S460N_T),
  // EN 10025-4 thermomechanical
  sub('S355', 'M', 'EN 10025-4', 355, 470, [355, 470], S355M_T),
  sub('S420', 'M', 'EN 10025-4', 420, 520, [420, 520], S420M_T),
  sub('S420', 'ML', 'EN 10025-4', 420, 520, [420, 520], S420M_T),
  sub('S460', 'M', 'EN 10025-4', 460, 540, [460, 540], S460M_T),
  sub('S460', 'ML', 'EN 10025-4', 460, 540, [460, 540], S460M_T),
  // EN 10025-6 quenched and tempered (fy/fu for 3 ≤ t ≤ 50 mm)
  { ...en('S460Q', 'EN 10025-6', 460, 550, [460, 570], null, 'EN 10025-6 S460Q (quenched and tempered)'), range: '3 ≤ t ≤ 50 mm' },
  { ...en('S690Q', 'EN 10025-6', 690, 770, null, null, 'EN 10025-6 S690Q (quenched and tempered)'), range: '3 ≤ t ≤ 50 mm' },
  // EN 10025-5 weathering
  sub('S235', 'J2W', 'EN 10025-5', 235, 360, [235, 360], S235_T, 'weathering'),
  sub('S355', 'J0W', 'EN 10025-5', 355, 470, [355, 510], S355_T, 'weathering'),
  sub('S355', 'J2W', 'EN 10025-5', 355, 470, [355, 510], S355_T, 'weathering'),
  sub('S355', 'K2W', 'EN 10025-5', 355, 470, [355, 510], S355_T, 'weathering'),
  // Hollow sections EN 10210-1 (hot finished) / EN 10219-1 (cold formed); same minima for t ≤ 16 mm
  sub('S235', 'JRH', 'EN 10210-1 / EN 10219-1', 235, 360, [235, 360], S235_T),
  sub('S275', 'J0H', 'EN 10210-1 / EN 10219-1', 275, 410, [275, 430], S275_T),
  sub('S275', 'J2H', 'EN 10210-1 / EN 10219-1', 275, 410, [275, 430], S275_T),
  sub('S355', 'J0H', 'EN 10210-1 / EN 10219-1', 355, 470, [355, 510], S355_T),
  sub('S355', 'J2H', 'EN 10210-1 / EN 10219-1', 355, 470, [355, 510], S355_T),
  sub('S355', 'K2H', 'EN 10210-1 / EN 10219-1', 355, 470, [355, 510], S355_T),
  en('S355NH', 'EN 10210-1 / EN 10219-1', 355, 470, [355, 490], null, 'EN 10210-1 / EN 10219-1 S355NH (normalized hollow)'),
  en('S355MH', 'EN 10219-1', 355, 470, [355, 470], null, 'EN 10219-1 S355MH (thermomechanical cold-formed hollow)'),
  en('S420MH', 'EN 10219-1', 420, 500, [420, 500], null, 'EN 10219-1 S420MH (thermomechanical cold-formed hollow)'),
  en('S460NH', 'EN 10210-1 / EN 10219-1', 460, 540, [460, 540], null, 'EN 10210-1 / EN 10219-1 S460NH (normalized hollow)'),
  en('S460MH', 'EN 10219-1', 460, 530, [460, 530], null, 'EN 10219-1 S460MH (thermomechanical cold-formed hollow)'),

  // Stainless EN 10088 (C / H / P per EN 1993-1-4 Table 2.1)
  stainless('1.4301', 'X5CrNi18-10', '304', 7900, [230, 540], [210, 520], [210, 520]),
  stainless('1.4307', 'X2CrNi18-9', '304L', 7900, [220, 520], [200, 520], [200, 500]),
  stainless('1.4401', 'X5CrNiMo17-12-2', '316', 8000, [240, 530], [220, 530], [220, 520]),
  stainless('1.4404', 'X2CrNiMo17-12-2', '316L', 8000, [240, 530], [220, 530], [220, 520]),
  stainless('1.4571', 'X6CrNiMoTi17-12-2', '316Ti', 8000, [240, 540], [220, 540], [220, 520]),
  stainless('1.4462', 'X2CrNiMoN22-5-3', '2205 duplex', 7800, [500, 700], [460, 700], [460, 640], true),
  stainless('1.4162', 'X2CrMnNiN21-5-1', 'LDX 2101 lean duplex', 7800, [530, 700], [480, 680], [450, 650], true),
  stainless('1.4362', 'X2CrNiN23-4', '2304 duplex', 7800, [450, 650], [400, 650], [400, 630], true),

  // ASTM (US)
  us('A36', 'ASTM A36', 36, 58, 'ASTM A36', 'carbon', 't ≤ 8 in (plates); shapes'),
  us('A572 Gr 50', 'ASTM A572', 50, 65, 'ASTM A572 Grade 50', 'carbon', 't ≤ 4 in'),
  us('A992', 'ASTM A992', 50, 65, 'ASTM A992 (W shapes)'),
  us('A500 Gr B', 'ASTM A500', 46, 58, 'ASTM A500 Grade B (rectangular/square HSS)'),
  us('A500 Gr B round', 'ASTM A500', 42, 58, 'ASTM A500 Grade B (round HSS)'),
  us('A500 Gr C', 'ASTM A500', 50, 62, 'ASTM A500 Grade C (HSS)', 'carbon', 'rectangular/square HSS (round: Fy 46 ksi)'),
  us('A500 Gr C round', 'ASTM A500', 46, 62, 'ASTM A500 Grade C (round HSS)'),
  us('A1085', 'ASTM A1085', 50, 65, 'ASTM A1085 Grade A (HSS, tdes = tnom)', 'carbon', 'all HSS', ['A1085 Gr A']),
  us('A53 Gr B', 'ASTM A53', 35, 60, 'ASTM A53 Grade B (pipe)'),
  us('A588', 'ASTM A588', 50, 70, 'ASTM A588 weathering steel', 'weathering', 't ≤ 4 in'),
  us('A847', 'ASTM A847', 50, 70, 'ASTM A847 weathering cold-formed HSS', 'weathering'),
  { ...us('A240 304', 'ASTM A240', 30, 75, 'ASTM A240 Type 304 stainless', 'stainless', 'plate, sheet and strip'), ...AUSTENITIC, alpha: 17.3e-6, E: 193000, G: 74000, density: 8000, aliases: ['S30400'] },
  { ...us('A240 304L', 'ASTM A240', 25, 70, 'ASTM A240 Type 304L stainless', 'stainless', 'plate, sheet and strip'), ...AUSTENITIC, alpha: 17.3e-6, E: 193000, G: 74000, density: 8000, aliases: ['S30403'] },
  { ...us('A240 316', 'ASTM A240', 30, 75, 'ASTM A240 Type 316 stainless', 'stainless', 'plate, sheet and strip'), ...AUSTENITIC, alpha: 16.0e-6, E: 193000, G: 74000, density: 8000, aliases: ['S31600'] },
  { ...us('A240 316L', 'ASTM A240', 25, 70, 'ASTM A240 Type 316L stainless', 'stainless', 'plate, sheet and strip'), ...AUSTENITIC, alpha: 16.0e-6, E: 193000, G: 74000, density: 8000, aliases: ['S31603'] },

  // Facade aluminium extrusions (EN 755-2 minima; f0 = 0.2 % proof stress)
  alu('6060 T66', '6060', 'T66', 150, 195, '3 < t ≤ 25 mm (t ≤ 3: 160/215)', [[3, 160], [25, 150]], 'Aluminium 6060 T66 extrusion'),
  alu('6063 T6', '6063', 'T6', 160, 195, '10 < t ≤ 25 mm (t ≤ 10: 170/215)', [[10, 170], [25, 160]], 'Aluminium 6063 T6 extrusion'),
  alu('6082 T6', '6082', 'T6', 250, 290, 't ≤ 5 mm (5 < t ≤ 25: 260/310)', [[5, 250], [25, 260]], 'Aluminium 6082 T6 extrusion'),
  alu('6005A T6', '6005A', 'T6', 200, 250, '10 < t ≤ 15 mm (t ≤ 5: 225/270, 5 < t ≤ 10: 215/260)', [[5, 225], [10, 215], [15, 200]], 'Aluminium 6005A T6 open extrusion'),
];

/** Name used when a lookup fails (keeps old behaviour: S355). */
export const DEFAULT_MATERIAL = 'S355';

const byName = new Map<string, Material>();
const byKey = new Map<string, Material>();
const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '').replace(/^en(aw)?/, '');
for (const m of MATERIALS) byName.set(m.name, m);
for (const m of MATERIALS) for (const k of [m.name, ...(m.aliases ?? [])]) if (!byKey.has(key(k))) byKey.set(key(k), m);

/** Exact name, then alias / loose match ("s355j2h", "316L", "6060-T66"); falls back to S355. */
export function getMaterial(name: string): Material {
  return findMaterial(name) ?? byName.get(DEFAULT_MATERIAL)!;
}

/** Like getMaterial but returns undefined instead of the S355 fallback. */
export function findMaterial(name: string | null | undefined): Material | undefined {
  if (!name) return undefined;
  return byName.get(name) ?? byKey.get(key(name));
}

/** Scale a carbon-steel mass to the material's density. */
export function densityFactor(material: string): number {
  return getMaterial(material).density / 7850;
}

/** Minimum yield strength for a given thickness (product-standard steps when known). */
export function yieldStrength(material: string | Material, t: number): number {
  const m = typeof material === 'string' ? getMaterial(material) : material;
  if (!m.fyT) return m.fy;
  for (const [tmax, fy] of m.fyT) if (t <= tmax) return fy;
  return m.fyT[m.fyT.length - 1][1];
}

export function materialsByFamily(family: MaterialFamily): Material[] {
  return MATERIALS.filter((m) => m.family === family);
}
