/**
 * A profile in its detail, for previews: the profile assembly it is a
 * component of, or the profiles uploaded with it from one detail
 * (ProfileDef.group), in base-point coordinates (pure; see AssemblyPreview).
 */
import type { Project, Vec2 } from '../core/model/types';
import { assemblyOfProfile, assemblySections } from '../core/library/profileAssembly';
import { getProfile, type ProfileDef } from '../core/library/profiles';
import { shapeOutline } from '../core/library/shapes';

export interface PreviewLoop {
  key: string;
  outer: Vec2[];
  holes: Vec2[][];
  material: string;
  main?: boolean;
  off?: boolean;
  /** Highlighted (hover in the components list). */
  hot?: boolean;
  title?: string;
}

/**
 * The detail a profile belongs to, in base-point coordinates, with the profile
 * highlighted and every other outline dimmed: the profile assembly it is a
 * component of, else the profiles uploaded with it from one detail
 * (ProfileDef.group, which share one base point). Null for a profile on its own.
 */
export function profileContext(lib: Project['library'] | undefined, name: string): { loops: PreviewLoop[]; title: string; of: string } | null {
  const found = assemblyOfProfile({ library: lib } as Pick<Project, 'library'>, name);
  if (found) {
    const loops: PreviewLoop[] = assemblySections(found.asm).map((x) => ({
      key: x.comp.key,
      outer: x.outer,
      holes: x.holes,
      material: x.comp.material,
      off: x.comp.key !== found.comp.key,
      hot: x.comp.key === found.comp.key,
      title: `${x.comp.name} · ${x.comp.material}`,
    }));
    return { loops, title: `${found.comp.name} in ${found.asm.name}`, of: `component of the profile assembly ${found.asm.name}` };
  }
  const defs = (lib?.profiles ?? []) as unknown as ProfileDef[];
  const group = defs.find((d) => d.name === name)?.group;
  if (!group) return null;
  const loops: PreviewLoop[] = [];
  for (const d of defs) {
    if (d.group !== group) continue;
    const prof = getProfile(d.name);
    if (!prof) continue;
    const ins = prof.insertion ?? { x: 0, y: 0 };
    const o = shapeOutline(prof.shape);
    const mv = (pts: Vec2[]) => pts.map((q) => ({ x: q.x - ins.x, y: q.y - ins.y }));
    loops.push({ key: d.name, outer: mv(o.outer), holes: o.holes.map(mv), material: d.material ?? 'S355', off: d.name !== name, hot: d.name === name, title: d.name });
  }
  return loops.length > 1 ? { loops, title: `${name} in ${group}`, of: `uploaded with ${group}` } : null;
}

