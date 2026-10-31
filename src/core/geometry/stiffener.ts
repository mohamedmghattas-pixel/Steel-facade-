/**
 * Web stiffeners (full-depth transverse stiffeners) for I/H and channel members.
 *
 * Outline (plate x = outstand from the web, plate y = section depth): fills the
 * clear depth between the flanges, h − 2·tf, out to the flange tip less `inset`,
 * with 45° corner snips at the web–flange junction that clear the root radius
 * (snip leg ≥ r, rounded up to 5 mm, minimum 10 mm). Parallel-flange sections
 * only: tapered flanges (IPN, UPN) use the nominal tf, so check the fit.
 */
import type { Vec2 } from '../model/types';
import type { Shape } from '../library/shapes';

export const defaultSnip = (r: number) => Math.max(10, Math.ceil((r - 1e-9) / 5) * 5);

export interface StiffenerShape {
  /** Outline for the +y side; the −y side uses the same outline in a mirrored frame. */
  outline: Vec2[];
  snip: number;
  clearDepth: number;
  outstand: number;
  /** Sides the section offers: I/H both, channels only the open (+y) side. */
  sides: ('pos' | 'neg')[];
}

export function stiffenerShape(shape: Shape, opts: { snip?: number; inset?: number } = {}): StiffenerShape | null {
  if (shape.type !== 'I' && shape.type !== 'U') return null;
  const { h, b, tw, tf, r } = shape;
  const hc = h / 2 - tf;
  const x0 = shape.type === 'I' ? tw / 2 : -b / 2 + tw;
  const x1 = b / 2 - Math.max(0, opts.inset ?? 0);
  const outstand = x1 - x0;
  const snip = Math.max(0, opts.snip ?? defaultSnip(r));
  if (!(hc > 0) || !(outstand > 0)) return null;
  if (snip >= outstand || snip >= hc) return null;
  const outline: Vec2[] =
    snip > 0
      ? [
          { x: x0 + snip, y: -hc },
          { x: x1, y: -hc },
          { x: x1, y: hc },
          { x: x0 + snip, y: hc },
          { x: x0, y: hc - snip },
          { x: x0, y: -hc + snip },
        ]
      : [
          { x: x0, y: -hc },
          { x: x1, y: -hc },
          { x: x1, y: hc },
          { x: x0, y: hc },
        ];
  return { outline, snip, clearDepth: 2 * hc, outstand, sides: shape.type === 'I' ? ['pos', 'neg'] : ['pos'] };
}
