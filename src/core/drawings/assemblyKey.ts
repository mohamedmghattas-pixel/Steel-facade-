/**
 * "Position in assembly" on the single-part drawing of a composite component
 * (a profile assembly, docs/PROFILE_ASSEMBLIES.md): the whole composite
 * section at a small scale, this component hatched with a heavy outline, the
 * others thin, and the base point BP, the insertion point every component
 * shares, so the part reads in relation to its detail.
 */
import type { ProfileAssembly, Vec2 } from '../model/types';
import { assemblySections } from '../library/profileAssembly';
import { wrap, type Sheet } from './dims';
import type { Block } from './layout';
import { hatch } from './section';
import { ISO_SCALES, TEXT, scaleLabel } from './standards';
import { textExtent } from './viewLayout';

/** Largest side of the drawn section, mm on the sheet. */
const KEY_SIZE = 44;

/** The block, or null when the assembly has fewer than two components drawn. */
export function assemblyKeyBlock(asm: ProfileAssembly, key: string, maxW = 90): Block | null {
  const secs = assemblySections(asm);
  if (secs.length < 2 || !secs.some((x) => x.comp.key === key)) return null;
  // Extent in base-point coordinates, the base point included.
  let x0 = 0;
  let x1 = 0;
  let y0 = 0;
  let y1 = 0;
  for (const x of secs)
    for (const q of x.outer) {
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y);
      y1 = Math.max(y1, q.y);
    }
  const ext = Math.max(x1 - x0, y1 - y0, 1);
  const den = ISO_SCALES.find((d) => ext / d <= KEY_SIZE) ?? ISO_SCALES[ISO_SCALES.length - 1];
  const dw = (x1 - x0) / den;
  const dh = (y1 - y0) / den;
  const comp = secs.find((x) => x.comp.key === key)!.comp;
  const title = `POSITION IN ASSEMBLY ${asm.name}   ${scaleLabel(den)}`;
  const notes = wrap(`Hatched: this part (${comp.name}). BP: base point, the insertion point every component shares; all are extruded and cut about it.`, Math.min(maxW, Math.max(dw + 16, 60)) - 2, TEXT.label);
  // The section, then room for the BP label beside it.
  const w = Math.min(maxW, Math.max(dw + 16, textExtent(title, TEXT.small, true), ...notes.map((l) => textExtent(l, TEXT.label))) + 2);
  const h = 8 + dh + 6 + notes.length * 3;
  return {
    w,
    h,
    right: true,
    id: 'block:assembly-key',
    draw: (s: Sheet, x: number, yTop: number) => {
      s.text({ x, y: yTop - 3.6 }, title, TEXT.small, 'start', 'text', 0, true);
      const left = x + 4;
      const top = yTop - 8;
      const M = (q: Vec2): Vec2 => ({ x: left + (q.x - x0) / den, y: top - (y1 - q.y) / den });
      // The other components first, thin; this one last, heavy and hatched.
      const ordered = [...secs.filter((x) => x.comp.key !== key), ...secs.filter((x) => x.comp.key === key)];
      for (const sec of ordered) {
        const mine = sec.comp.key === key;
        s.withTag({ id: `assembly-key:${sec.comp.key}` }, () => {
          const outer = sec.outer.map(M);
          const holes = sec.holes.map((hl) => hl.map(M));
          s.poly(outer, true, mine ? 'visible' : 'thin');
          for (const hl of holes) s.poly(hl, true, mine ? 'visible' : 'thin');
          if (mine) hatch(s, [outer], { spacing: 0.6, angle: 45, exclude: holes });
        });
      }
      // Base point: a small cross in a circle, labelled BP.
      const bp = M({ x: 0, y: 0 });
      s.withTag({ id: 'assembly-key:bp' }, () => {
        s.circle(bp, 0.9, 'visible');
        s.line({ x: bp.x - 2, y: bp.y }, { x: bp.x + 2, y: bp.y }, 'thin');
        s.line({ x: bp.x, y: bp.y - 2 }, { x: bp.x, y: bp.y + 2 }, 'thin');
        // Label beside the section, on a leader from the base point (clear of the parts).
        const lx = left + dw + 3;
        s.line({ x: bp.x + 0.9, y: bp.y }, { x: lx - 0.6, y: bp.y }, 'thin');
        s.text({ x: lx, y: bp.y - TEXT.small / 2.5 }, 'BP', TEXT.small, 'start', 'text');
      });
      notes.forEach((l, i) => s.text({ x, y: top - dh - 4 - i * 3 }, l, TEXT.label, 'start', 'text'));
    },
  };
}
