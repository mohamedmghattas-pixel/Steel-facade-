/**
 * Minimal ASCII DXF R12 (AC1009) writer — the most widely readable flavour.
 * Units are whatever the caller uses (drawings use paper millimetres).
 */

export type DxfLinetype = 'CONTINUOUS' | 'DASHED' | 'CENTER';

export interface DxfLayer {
  name: string;
  color: number;
  linetype?: DxfLinetype;
}

export type TextAlign = 'left' | 'center' | 'right';

const f = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(4)).toString() : '0');

export class DxfWriter {
  private layers = new Map<string, DxfLayer>();
  private ents: string[] = [];

  constructor(layers: DxfLayer[] = []) {
    this.addLayer({ name: '0', color: 7, linetype: 'CONTINUOUS' });
    for (const l of layers) this.addLayer(l);
  }

  addLayer(l: DxfLayer): this {
    this.layers.set(l.name, { linetype: 'CONTINUOUS', ...l });
    return this;
  }

  private ensure(layer: string) {
    if (!this.layers.has(layer)) this.addLayer({ name: layer, color: 7 });
  }

  private push(...pairs: (string | number)[]) {
    for (let i = 0; i < pairs.length; i += 2) {
      const v = pairs[i + 1];
      this.ents.push(String(pairs[i]), typeof v === 'number' ? f(v) : v);
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, layer = '0'): this {
    this.ensure(layer);
    this.push(0, 'LINE', 8, layer, 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0);
    return this;
  }

  circle(cx: number, cy: number, r: number, layer = '0'): this {
    this.ensure(layer);
    this.push(0, 'CIRCLE', 8, layer, 10, cx, 20, cy, 30, 0, 40, r);
    return this;
  }

  /** Angles in degrees, counter-clockwise from +x. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, layer = '0'): this {
    this.ensure(layer);
    this.push(0, 'ARC', 8, layer, 10, cx, 20, cy, 30, 0, 40, r, 50, a0, 51, a1);
    return this;
  }

  text(x: number, y: number, h: number, text: string, opts: { layer?: string; align?: TextAlign; rot?: number } = {}): this {
    const layer = opts.layer ?? '0';
    this.ensure(layer);
    const align = opts.align ?? 'left';
    const clean = text.replace(/[\r\n]+/g, ' ');
    this.push(0, 'TEXT', 8, layer, 10, x, 20, y, 30, 0, 40, h, 1, clean);
    if (opts.rot) this.push(50, opts.rot);
    if (align !== 'left') {
      this.push(72, align === 'center' ? 1 : 2, 11, x, 21, y, 31, 0);
    }
    return this;
  }

  polyline(pts: { x: number; y: number }[], closed = false, layer = '0'): this {
    if (pts.length < 2) return this;
    this.ensure(layer);
    this.push(0, 'POLYLINE', 8, layer, 66, '1', 10, 0, 20, 0, 30, 0, 70, closed ? '1' : '0');
    for (const p of pts) this.push(0, 'VERTEX', 8, layer, 10, p.x, 20, p.y, 30, 0);
    this.push(0, 'SEQEND', 8, layer);
    return this;
  }

  /** Filled triangle / quadrilateral (DXF SOLID: the 3rd and 4th corners are listed crosswise). */
  solid(pts: { x: number; y: number }[], layer = '0'): this {
    if (pts.length < 3) return this;
    this.ensure(layer);
    const [a, b, c, d = pts[2]] = pts;
    this.push(0, 'SOLID', 8, layer, 10, a.x, 20, a.y, 30, 0, 11, b.x, 21, b.y, 31, 0, 12, d.x, 22, d.y, 32, 0, 13, c.x, 23, c.y, 33, 0);
    return this;
  }

  toString(): string {
    const out: string[] = [];
    const p = (...pairs: (string | number)[]) => {
      for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1]));
    };
    p(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
    p(0, 'SECTION', 2, 'TABLES');
    // Linetypes
    p(0, 'TABLE', 2, 'LTYPE', 70, 3);
    p(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, '0.0');
    // ISO 128-2 patterns for 0.25 mm lines: dashed 12d/3d, long-dash dotted 24d/3d/0.5d/3d.
    p(0, 'LTYPE', 2, 'DASHED', 70, 0, 3, 'ISO dashed __ __ __', 72, 65, 73, 2, 40, '3.75', 49, '3.0', 49, '-0.75');
    p(0, 'LTYPE', 2, 'CENTER', 70, 0, 3, 'ISO long-dash dotted ____ . ____', 72, 65, 73, 4, 40, '7.625', 49, '6.0', 49, '-0.75', 49, '0.125', 49, '-0.75');
    p(0, 'ENDTAB');
    // Layers
    p(0, 'TABLE', 2, 'LAYER', 70, this.layers.size);
    for (const l of this.layers.values()) p(0, 'LAYER', 2, l.name, 70, 0, 62, l.color, 6, l.linetype ?? 'CONTINUOUS');
    p(0, 'ENDTAB');
    p(0, 'ENDSEC');
    out.push('0', 'SECTION', '2', 'ENTITIES', ...this.ents, '0', 'ENDSEC', '0', 'EOF');
    return out.join('\n') + '\n';
  }
}
