import type { Standard } from './profiles';

export interface Material {
  name: string;
  standard: Standard | 'Stainless';
  /** Yield strength, MPa (for thickness ≤ 16 mm). */
  fy: number;
  /** Ultimate strength, MPa. */
  fu: number;
  /** kg/m³ */
  density: number;
  /** IFC/DSTV friendly description. */
  description: string;
}

export const MATERIALS: Material[] = [
  { name: 'S235', standard: 'EN', fy: 235, fu: 360, density: 7850, description: 'EN 10025 S235JR' },
  { name: 'S275', standard: 'EN', fy: 275, fu: 430, density: 7850, description: 'EN 10025 S275JR' },
  { name: 'S355', standard: 'EN', fy: 355, fu: 490, density: 7850, description: 'EN 10025 S355J2 / EN 10219 S355J2H' },
  { name: '1.4301', standard: 'Stainless', fy: 210, fu: 520, density: 7900, description: 'Stainless 304 (EN 10088)' },
  { name: '1.4401', standard: 'Stainless', fy: 220, fu: 530, density: 8000, description: 'Stainless 316 (EN 10088)' },
  { name: 'A36', standard: 'AISC', fy: 250, fu: 400, density: 7850, description: 'ASTM A36' },
  { name: 'A992', standard: 'AISC', fy: 345, fu: 450, density: 7850, description: 'ASTM A992 (W shapes)' },
  { name: 'A500 Gr C', standard: 'AISC', fy: 345, fu: 425, density: 7850, description: 'ASTM A500 Grade C (HSS)' },
  { name: 'A572 Gr 50', standard: 'AISC', fy: 345, fu: 450, density: 7850, description: 'ASTM A572 Grade 50' },
];

export function getMaterial(name: string): Material {
  return MATERIALS.find((m) => m.name === name) ?? MATERIALS[2];
}

/** Scale a carbon-steel mass to the material's density. */
export function densityFactor(material: string): number {
  return getMaterial(material).density / 7850;
}
