/**
 * Wavefront OBJ + MTL of the part meshes: one group per assembly instance, one
 * object per part, one material per member role (the 3D view's colours).
 * Units: millimetres, Z up (as the model; most importers ask for the scale).
 */
import type { PartMesh } from './meshes';
import { roleColor } from './meshes';

const n6 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
/** Names without spaces (OBJ splits names at whitespace). */
const safe = (s: string) => s.replace(/\s+/g, '_') || '_';

export function objMaterialName(role: string): string {
  return `role_${safe(role)}`;
}

/** OBJ text (referencing `mtlFile`) and the MTL text. */
export function meshesToObj(meshes: PartMesh[], o: { mtlFile: string; title?: string }): { obj: string; mtl: string } {
  const L: string[] = [`# ${o.title ?? 'FacadeSteel model'}`, '# Units: millimetres, Z up. One group per assembly, one object per part.', `mtllib ${o.mtlFile}`];
  let base = 1;
  let group = '';
  const roles = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of meshes) {
    const g = m.assembly ? `${safe(m.assembly)}_${safe(m.assemblyId)}` : 'loose';
    if (g !== group) {
      L.push(`g ${g}`);
      group = g;
    }
    const k = `${m.assembly}/${m.mark}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    L.push(`o ${safe(m.assembly || 'part')}.${safe(m.mark)}.${n}`);
    const mat = objMaterialName(m.role);
    roles.add(m.role);
    L.push(`usemtl ${mat}`);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) L.push(`v ${n6(p[i])} ${n6(p[i + 1])} ${n6(p[i + 2])}`);
    const t = m.indices;
    for (let i = 0; i < t.length; i += 3) L.push(`f ${t[i] + base} ${t[i + 1] + base} ${t[i + 2] + base}`);
    base += p.length / 3;
  }
  const M: string[] = ['# FacadeSteel materials: one per member role'];
  for (const r of [...roles].sort()) {
    const [cr, cg, cb] = roleColor(r);
    M.push('', `newmtl ${objMaterialName(r)}`, `Ka 0.1 0.1 0.1`, `Kd ${cr.toFixed(4)} ${cg.toFixed(4)} ${cb.toFixed(4)}`, 'Ks 0.2 0.2 0.2', 'Ns 20', 'd 1', 'illum 2');
  }
  return { obj: L.join('\n') + '\n', mtl: M.join('\n') + '\n' };
}
