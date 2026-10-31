/** Grid / level references for reports ("Grid 2 +35 / L01"). */
import type { Project, Vec3 } from '../model/types';

const fmtOff = (d: number) => (Math.abs(d) < 1 ? '' : ` ${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))}`);

/** Nearest grid line across the facade (`along` picks x or y grids) and nearest level. */
export function locationLabel(p: Project, pt: Vec3, along?: Vec3): string {
  const parts: string[] = [];
  const preferX = along ? Math.abs(along.x) >= Math.abs(along.y) : true;
  const pick = (axis: 'x' | 'y') => {
    const gs = p.grids.filter((g) => g.axis === axis);
    if (!gs.length) return null;
    const c = axis === 'x' ? pt.x : pt.y;
    const g = gs.reduce((a, b) => (Math.abs(b.pos - c) < Math.abs(a.pos - c) ? b : a));
    return `Grid ${g.name}${fmtOff(c - g.pos)}`;
  };
  const grid = pick(preferX ? 'x' : 'y') ?? pick(preferX ? 'y' : 'x');
  if (grid) parts.push(grid);
  if (p.levels.length) {
    const l = p.levels.reduce((a, b) => (Math.abs(b.z - pt.z) < Math.abs(a.z - pt.z) ? b : a));
    parts.push(`${l.name}${fmtOff(pt.z - l.z)}`);
  }
  if (!parts.length) parts.push(`X ${Math.round(pt.x)} Y ${Math.round(pt.y)} Z ${Math.round(pt.z)}`);
  return parts.join(' / ');
}
