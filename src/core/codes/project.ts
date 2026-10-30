/** Which code a project is detailed to, and whether it works in inch sizes. */
import type { Project } from '../model/types';
import { getProfile } from '../library/profiles';
import type { DesignCode } from './types';
import { boltSpec } from './units';

const AISC_MATERIAL = /^(A\d{2,4}|ASTM)\b/i;
const EN_MATERIAL = /^S\d{3}|^1\.4\d{3}/i;

interface Votes {
  en: number;
  aisc: number;
  imperialBolts: number;
  metricBolts: number;
}

function vote(p: Project): Votes {
  const v: Votes = { en: 0, aisc: 0, imperialBolts: 0, metricBolts: 0 };
  for (const m of Object.values(p.members ?? {})) {
    const std = getProfile(m.profile)?.standard;
    if (std === 'EN') v.en++;
    else if (std === 'AISC') v.aisc++;
    if (AISC_MATERIAL.test(m.material ?? '')) v.aisc += 0.5;
    else if (EN_MATERIAL.test(m.material ?? '')) v.en += 0.5;
  }
  for (const c of Object.values(p.connections ?? {})) {
    for (const [k, val] of Object.entries(c.params ?? {})) {
      if (typeof val !== 'string' || !/bolt|anchor/i.test(k)) continue;
      const b = boltSpec(val);
      if (b?.system === 'imperial') v.imperialBolts++;
      else if (b) v.metricBolts++;
    }
  }
  return v;
}

/**
 * The project's design code: `settings.designCode` when set to a code, else
 * inferred from the profile standards, materials and bolt system in use
 * (EN / BS / metric → EC3, AISC / imperial → AISC360). Ties follow the drawing
 * standard (ASME → AISC360).
 */
export function codeForProject(p: Project): DesignCode {
  const set = (p.settings as { designCode?: string } | undefined)?.designCode;
  if (set === 'AISC360' || set === 'EC3') return set;
  const v = vote(p);
  const aisc = v.aisc + v.imperialBolts;
  const en = v.en + v.metricBolts;
  if (aisc > en) return 'AISC360';
  if (en > aisc) return 'EC3';
  return p.drawings?.settings?.standard === 'ASME' ? 'AISC360' : 'EC3';
}

/** True when the project works in inch sizes (imperial bolts, or AISC sections with no metric bolts). */
export function isImperialProject(p: Project): boolean {
  const v = vote(p);
  if (v.imperialBolts || v.metricBolts) return v.imperialBolts > v.metricBolts;
  return v.aisc > v.en;
}
