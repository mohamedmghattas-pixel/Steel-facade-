/**
 * Aluminium (and other non-steel) components of composite members: a cutting
 * list per profile and the section of each extrusion as DXF (millimetres,
 * drawing coordinates with the assembly base point at the origin, written by
 * profileToDxf). Steel components get DSTV NC1 like every other linear part;
 * NC1 for aluminium components is optional (fabrication setting
 * `dstvAluminium`), because extrusions are usually cut and machined on
 * aluminium saws / machining centres that read cutting lists, not DSTV.
 */
import type { Project } from '../model/types';
import { uniqueParts, type DerivedModel, type Part } from '../derive/model';
import { getProfile, type ProfileDef } from '../library/profiles';
import { profileToDxf } from '../library/profileDxf';
import { shapeDrawCentre } from '../library/shapes';
import { materialClass } from '../library/profileAssembly';
import { toCsv, type Row } from '../reports/bom';

/** A component part that is not steel (aluminium extrusions, plastic packers made as parts …). */
export const isNonSteelComponent = (pt: Part) => !!pt.component && !['steel', 'stainless'].includes(materialClass(pt.material));

const r1 = (v: number) => Math.round(v * 10) / 10;
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

/** Cutting list of non-steel component parts: one row per mark (profile, material, length, end cuts, quantity, assemblies). */
export function extrusionRows(dm: DerivedModel): Row[] {
  const rows: Row[] = [['Mark', 'Qty', 'Name', 'Profile', 'Material', 'Cut length (mm)', 'Start cut (°)', 'End cut (°)', 'kg/pc', 'Total length (m)', 'Assemblies']];
  for (const { part, qty, refs } of uniqueParts(dm)) {
    if (!isNonSteelComponent(part)) continue;
    const asm = [...new Set(refs.map((r) => dm.partByRef.get(r)?.assembly ?? ''))].filter(Boolean).join(', ');
    const cut = (e?: { angleWeb: number; angleFlange: number }) => (e ? `${r1(e.angleWeb)} / ${r1(e.angleFlange)}` : '0');
    rows.push([part.mark, qty, part.name, part.profile, part.material, r1(part.length), cut(part.ends?.start), cut(part.ends?.end), Math.round(part.mass * 100) / 100, Math.round((part.length * qty) / 10) / 100, asm]);
  }
  return rows;
}

/** The profile definition behind a part's profile (the project's custom definition, else one built from the catalogue profile). */
function defOf(p: Project, name: string): ProfileDef | undefined {
  const own = (p.library.profiles as unknown as ProfileDef[]).find((d) => d.name === name);
  if (own) return own;
  const prof = getProfile(name);
  if (!prof) return undefined;
  const c = shapeDrawCentre(prof.shape);
  return { name: prof.name, shape: prof.shape, ...(prof.insertion ? { insertion: { x: prof.insertion.x + c.x, y: prof.insertion.y + c.y } } : {}) };
}

/** `extrusions/cutting-list.csv` plus `extrusions/<profile>.dxf` per profile; empty without non-steel component parts. */
export function extrusionFiles(p: Project, dm: DerivedModel): { name: string; content: string }[] {
  const rows = extrusionRows(dm);
  if (rows.length < 2) return [];
  const out = [{ name: 'extrusions/cutting-list.csv', content: toCsv(rows) }];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const name = String(r[3]);
    if (seen.has(name)) continue;
    seen.add(name);
    const def = defOf(p, name);
    if (def) out.push({ name: `extrusions/${safe(name)}.dxf`, content: profileToDxf(def) });
  }
  return out;
}
