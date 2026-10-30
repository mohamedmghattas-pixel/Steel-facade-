/**
 * DSTV NC1 export (one file per unique part) for CNC saw/drill lines and plate
 * cutting. Holes drilled along local y land on the web/front face "v", holes
 * drilled along local z on the top face "o". Slots are written as elongated
 * holes ("l"); check the slot convention against your machine's post-processor.
 */
import type { Project } from '../model/types';
import { bbox2 } from '../model/geometry';
import { getProfile } from '../library/profiles';
import type { Shape } from '../library/shapes';
import { uniqueParts, type DerivedModel, type Part } from '../derive/model';

const f = (n: number, w = 10) => n.toFixed(2).padStart(w);
const line = (s: string | number) => `  ${s}`;

function profileCode(shape: Shape | undefined, kind: Part['kind']): string {
  if (kind === 'plate' || !shape) return 'B';
  switch (shape.type) {
    case 'I':
      return 'I';
    case 'U':
      return 'U';
    case 'L':
      return 'L';
    case 'RHS':
      return 'M';
    case 'CHS':
      return 'RO';
    case 'FL':
      return 'B';
    case 'C':
      return 'C';
    case 'T':
      return 'T';
    case 'RD':
      return 'RU';
    case 'Z':
      return 'SO';
  }
}

/** Height, flange width, flange thickness, web thickness, radius. */
function sectionDims(shape: Shape): [number, number, number, number, number] {
  switch (shape.type) {
    case 'I':
    case 'U':
      return [shape.h, shape.b, shape.tf, shape.tw, shape.r];
    case 'L':
      return [shape.h, shape.b, shape.t, shape.t, shape.r];
    case 'RHS':
      return [shape.h, shape.b, shape.t, shape.t, shape.ro];
    case 'CHS':
      return [shape.d, shape.d, shape.t, shape.t, 0];
    case 'FL':
      return [shape.h, shape.t, shape.t, shape.t, 0];
    case 'C':
    case 'Z':
      return [shape.h, shape.b, shape.t, shape.t, 0];
    case 'T':
      return [shape.h, shape.b, shape.tf, shape.tw, shape.r];
    case 'RD':
      return [shape.d, shape.d, 0, 0, 0];
  }
}

function holeLine(face: string, x: number, y: number, d: number, slot?: number, angle = 0): string {
  let s = `  ${face}${f(x)}s${f(y)}${f(d)}`;
  if (slot && slot > 0) {
    const vertical = Math.abs(Math.abs(angle) - 90) < 1e-6;
    const sx = vertical ? 0 : slot;
    const sy = vertical ? slot : 0;
    const a = vertical || Math.abs(angle) < 1e-6 ? 0 : angle;
    s += `${f(0)}l${f(sx)}${f(sy)}${f(a)}`;
  }
  return s;
}

export function partToDstv(part: Part, qty: number, p: Project): string {
  const out: string[] = [];
  const isPlate = part.kind === 'plate';
  const prof = isPlate ? undefined : getProfile(part.profile);
  const shape = prof?.shape ?? part.shape;
  const code = profileCode(shape, part.kind);
  const lengthM = Math.max(part.length, 1e-6) / 1000;

  let length = part.length;
  let height: number, flangeW: number, flangeT: number, webT: number, radius: number;
  let profileName = part.profile;
  let bb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (isPlate && part.outline) {
    bb = bbox2(part.outline);
    length = bb.maxX - bb.minX;
    height = bb.maxY - bb.minY;
    flangeW = part.thickness;
    flangeT = part.thickness;
    webT = part.thickness;
    radius = 0;
    profileName = `PL${part.thickness}*${Math.round(height)}`;
  } else if (shape) {
    [height, flangeW, flangeT, webT, radius] = sectionDims(shape);
  } else {
    height = flangeW = flangeT = webT = radius = 0;
  }
  const massPerM = prof ? prof.mass : part.mass / lengthM;
  const surfPerM = prof ? prof.surface : part.surface / lengthM;

  out.push('ST');
  out.push(`** FacadeSteel ${part.mark}.nc1`);
  out.push(line(p.info.number || p.info.name || 'FacadeSteel'));
  out.push(line(part.assembly || part.mark));
  out.push(line('1'));
  out.push(line(part.mark));
  out.push(line(part.material));
  out.push(line(qty));
  out.push(line(profileName));
  out.push(line(code));
  out.push(f(length, 12));
  out.push(f(length, 12));
  out.push(f(height, 12));
  out.push(f(flangeW, 12));
  out.push(f(flangeT, 12));
  out.push(f(webT, 12));
  out.push(f(radius, 12));
  out.push(f(massPerM, 12));
  out.push(f(surfPerM, 12));
  for (let i = 0; i < 4; i++) out.push(f(0, 12)); // web/flange start and end cuts
  out.push(line(part.assembly || '-'));
  out.push(line(part.finish));
  out.push(line(part.name));
  out.push(line('FacadeSteel'));

  if (isPlate && part.outline) {
    out.push('AK');
    const pts = part.outline.map((v) => ({ x: v.x - bb.minX, y: v.y - bb.minY }));
    pts.push(pts[0]);
    for (const q of pts) out.push(`  v${f(q.x)}${f(q.y)}${f(0)}`);
    const holes = [...(part.plateHoles ?? [])].sort((a, b) => a.x - b.x || a.y - b.y);
    if (holes.length) {
      out.push('BO');
      for (const h of holes) out.push(holeLine('v', h.x - bb.minX, h.y - bb.minY, h.d, h.slot, h.angle));
    }
  } else if (part.holes.length && shape) {
    const [h, b] = [prof?.h ?? height, prof?.b ?? flangeW];
    out.push('BO');
    for (const hole of part.holes) {
      if (hole.face === 'y') out.push(holeLine('v', hole.x, hole.z + h / 2, hole.d, hole.slot));
      else out.push(holeLine('o', hole.x, hole.y + b / 2, hole.d, hole.slot));
    }
  }
  out.push('EN');
  return out.join('\n') + '\n';
}

/** One NC1 file per unique part mark. */
export function exportDstvAll(p: Project, dm: DerivedModel): { name: string; content: string }[] {
  return uniqueParts(dm).map(({ part, qty }) => ({ name: `${part.mark}.nc1`, content: partToDstv(part, qty, p) }));
}
