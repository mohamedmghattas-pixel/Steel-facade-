/**
 * Composite section preview: every component of a profile assembly (or of a
 * detail under review) in the assembly's section coordinates, coloured by
 * material class, the main component outlined, and the base point (BP) marked.
 */
import { useMemo } from 'react';
import type { ProfileAssembly, Vec2 } from '../core/model/types';
import { assemblySections, materialClass, type MaterialClass } from '../core/library/profileAssembly';
import { useStore } from '../state/store';
import { profileContext, type PreviewLoop } from './profileContext';

export { profileContext, type PreviewLoop } from './profileContext';


const path = (pts: Vec2[]) => `M${pts.map((q) => `${q.x.toFixed(2)},${(-q.y).toFixed(2)}`).join('L')}Z`;
export const CLASS_COLOR: Record<MaterialClass, string> = { steel: '#5f86c0', stainless: '#8fa3b8', aluminium: '#c3ccd6', rubber: '#2f3338', plastic: '#e2a63c' };

/** Loops (base-point coordinates) as an SVG with the base point at the origin. */
export function LoopsPreview({ loops, size = 160, height, label, onPick }: { loops: PreviewLoop[]; size?: number; height?: number; label?: string; onPick?: (key: string) => void }) {
  let x0 = 0;
  let x1 = 0;
  let y0 = 0;
  let y1 = 0;
  for (const l of loops)
    for (const q of l.outer) {
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y);
      y1 = Math.max(y1, q.y);
    }
  const ext = Math.max(x1 - x0, y1 - y0, 1);
  const pad = ext * 0.08;
  const r = ext * 0.025;
  const h = height ?? size;
  return (
    <svg className="asm-preview" viewBox={`${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} width={size} height={h} role="img" aria-label={label ?? 'Composite section with its base point'}>
      {loops.map((l) => (
        <path
          key={l.key}
          className={`asm-loop ${l.main ? 'main' : ''} ${l.off ? 'off' : ''} ${l.hot ? 'hot' : ''} ${onPick ? 'pick' : ''}`}
          d={[l.outer, ...l.holes].map(path).join(' ')}
          fillRule="evenodd"
          style={{ fill: CLASS_COLOR[materialClass(l.material)] }}
          onClick={onPick ? () => onPick(l.key) : undefined}
        >
          {l.title && <title>{l.title}</title>}
        </path>
      ))}
      <g className="asm-bp">
        <line x1={-r * 2.6} y1={0} x2={r * 2.6} y2={0} />
        <line x1={0} y1={-r * 2.6} x2={0} y2={r * 2.6} />
        <circle cx={0} cy={0} r={r * 1.3} />
        <title>Base point (assembly insertion point)</title>
      </g>
    </svg>
  );
}

/** Preview of a saved profile assembly. */
export function AssemblyPreview({ asm, size = 96, rotation = 0 }: { asm: ProfileAssembly; size?: number; rotation?: number }) {
  const rot = (rotation * Math.PI) / 180;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const turn = (q: Vec2) => (rotation ? { x: q.x * c - q.y * s, y: q.x * s + q.y * c } : q);
  const loops: PreviewLoop[] = assemblySections(asm).map((x) => ({
    key: x.comp.key,
    outer: x.outer.map(turn),
    holes: x.holes.map((h) => h.map(turn)),
    material: x.comp.material,
    main: x.comp.key === asm.main,
    title: `${x.comp.name} · ${x.comp.material}`,
  }));
  return <LoopsPreview loops={loops} size={size} label={`${asm.name}: composite section with its base point`} />;
}

/** A profile drawn in its detail (see profileContext); null when it has none. */
export function ProfileContextPreview({ name, size = 96, height }: { name: string; size?: number; height?: number }) {
  const lib = useStore((s) => s.project.library);
  const ctx = useMemo(() => profileContext(lib, name), [lib, name]);
  if (!ctx) return null;
  return <LoopsPreview loops={ctx.loops} size={size} height={height} label={`${ctx.title}: the profile highlighted in its detail, base point = shared insertion point`} />;
}
