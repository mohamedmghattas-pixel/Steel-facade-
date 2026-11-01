import type { Align, AlignMode, Vec2 } from '../core/model/types';
import { getProfile, type Profile } from '../core/library/profiles';
import { shapeOutline, type Shape } from '../core/library/shapes';

const path = (pts: Vec2[]) => `M${pts.map((q) => `${q.x.toFixed(2)},${(-q.y).toFixed(2)}`).join('L')}Z`;

/**
 * Small cross-section with the 3×3 alignment grid and the profile insertion
 * point (outline coordinates, x across = local y, y up = local z). The point
 * the wire line passes through is ringed; with `onGrid` / `onInsertion` the
 * points are clickable.
 */
export function SectionPreview({
  profile,
  shape,
  insertion,
  size = 132,
  mode,
  alignY,
  alignZ,
  onGrid,
  onInsertion,
  title,
}: {
  profile?: string | Profile | null;
  /** Instead of a catalogue profile: a shape and its insertion point (outline coordinates). */
  shape?: Shape;
  insertion?: Vec2 | null;
  size?: number;
  mode?: AlignMode;
  alignY?: Align;
  alignZ?: Align;
  onGrid?: (y: Align, z: Align) => void;
  onInsertion?: () => void;
  title?: string;
}) {
  const prof = typeof profile === 'string' ? getProfile(profile) : (profile ?? undefined);
  const sh = shape ?? prof?.shape;
  if (!sh) return <div className="sec-preview empty" style={{ width: size, height: size }} />;
  const ins = shape ? (insertion ?? undefined) : prof?.insertion;
  const o = shapeOutline(sh);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const q of o.outer) {
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const all = [minX, maxX, ...(ins ? [ins.x] : [])];
  const allY = [minY, maxY, ...(ins ? [ins.y] : [])];
  const x0 = Math.min(...all);
  const x1 = Math.max(...all);
  const y0 = Math.min(...allY);
  const y1 = Math.max(...allY);
  const ext = Math.max(x1 - x0, y1 - y0, 1);
  const pad = ext * 0.14;
  const vb = `${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`;
  const r = ext * 0.035;
  const gridOn = mode !== 'insertion' || !ins;
  const dots: { ay: Align; az: Align; x: number; y: number }[] = [];
  for (const az of [1, 0, -1] as Align[]) for (const ay of [-1, 0, 1] as Align[]) dots.push({ ay, az, x: (minX + maxX) / 2 + (ay * w) / 2, y: (minY + maxY) / 2 + (az * h) / 2 });
  return (
    <svg className="sec-preview" viewBox={vb} width={size} height={size} role="img" aria-label={title ?? `${prof?.name ?? 'Section'} with insertion point`}>
      <path className="sec-fill" d={[o.outer, ...o.holes].map(path).join(' ')} fillRule="evenodd" />
      <rect className="sec-box" x={minX} y={-maxY} width={w} height={h} />
      {dots.map((d) => {
        const on = gridOn && d.ay === (alignY ?? 0) && d.az === (alignZ ?? 0);
        return (
          <circle
            key={`${d.ay},${d.az}`}
            className={`sec-dot ${on ? 'on' : ''} ${onGrid ? 'pick' : ''}`}
            cx={d.x}
            cy={-d.y}
            r={on ? r * 1.25 : r * 0.8}
            onClick={onGrid ? () => onGrid(d.ay, d.az) : undefined}
          >
            <title>{`Grid: ${d.az > 0 ? 'top' : d.az < 0 ? 'bottom' : 'middle'} ${d.ay > 0 ? 'right (+y)' : d.ay < 0 ? 'left (−y)' : 'centre'}`}</title>
          </circle>
        );
      })}
      {ins && (
        <g className={`sec-ins ${!gridOn ? 'on' : ''} ${onInsertion ? 'pick' : ''}`} onClick={onInsertion}>
          <line x1={ins.x - r * 2.4} y1={-ins.y} x2={ins.x + r * 2.4} y2={-ins.y} />
          <line x1={ins.x} y1={-ins.y - r * 2.4} x2={ins.x} y2={-ins.y + r * 2.4} />
          <circle cx={ins.x} cy={-ins.y} r={r * (gridOn ? 1.1 : 1.5)} />
          <title>Profile insertion point</title>
        </g>
      )}
    </svg>
  );
}
