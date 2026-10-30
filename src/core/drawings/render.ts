/** Drawing → SVG (preview / PDF) and DXF (CAD exchange). */
import { DxfWriter } from '../io/dxfWriter';
import type { DEnt, DLayer, Drawing } from './types';

/** ISO 128-2 line group 0.5 (dashed: 12d dash / 3d gap; long-dash dotted: 24d / 3d / 0.5d / 3d). */
const STYLE: Record<DLayer, { w: number; dash?: string }> = {
  visible: { w: 0.5 },
  hidden: { w: 0.25, dash: '3 0.75' },
  center: { w: 0.25, dash: '6 0.75 0.4 0.75' },
  dim: { w: 0.25 },
  text: { w: 0.25 },
  thin: { w: 0.25 },
  medium: { w: 0.35 },
  border: { w: 0.7 },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 100) / 100).toString();

export function drawingToSvg(d: Drawing): string {
  const H = d.sheet.h;
  const Y = (y: number) => H - y;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d.sheet.w}mm" height="${H}mm" viewBox="0 0 ${d.sheet.w} ${H}" font-family="Arial, Helvetica, sans-serif">`,
    `<rect x="0" y="0" width="${d.sheet.w}" height="${H}" fill="#fff"/>`,
  );
  for (const e of d.entities) out.push(svgEnt(e, Y));
  out.push('</svg>');
  return out.join('\n');
}

function stroke(l: DLayer, fill?: boolean): string {
  const st = STYLE[l];
  return `stroke="#000" stroke-width="${st.w}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} fill="${fill ? '#000' : 'none'}" stroke-linecap="round" stroke-linejoin="round"`;
}

function svgEnt(e: DEnt, Y: (y: number) => number): string {
  switch (e.t) {
    case 'line':
      return `<line x1="${n(e.a.x)}" y1="${n(Y(e.a.y))}" x2="${n(e.b.x)}" y2="${n(Y(e.b.y))}" ${stroke(e.layer)}/>`;
    case 'circle':
      return `<circle cx="${n(e.c.x)}" cy="${n(Y(e.c.y))}" r="${n(e.r)}" ${stroke(e.layer, e.fill)}/>`;
    case 'poly': {
      const pts = e.pts.map((p) => `${n(p.x)},${n(Y(p.y))}`).join(' ');
      return `<${e.closed ? 'polygon' : 'polyline'} points="${pts}" ${stroke(e.layer, e.fill)}/>`;
    }
    case 'text': {
      const x = n(e.p.x);
      const y = n(Y(e.p.y));
      const rot = e.rot ? ` transform="rotate(${n(-e.rot)} ${x} ${y})"` : '';
      // ISO 3098 heights are cap heights; Arial cap height ≈ 0.716 of the font size.
      return `<text x="${x}" y="${y}" font-size="${n(e.h * 1.4)}" text-anchor="${e.anchor ?? 'start'}" fill="#000"${e.bold ? ' font-weight="bold"' : ''}${rot}>${esc(e.text)}</text>`;
    }
  }
}

const DXF_LAYERS: Record<DLayer, { name: string; color: number; linetype: 'CONTINUOUS' | 'DASHED' | 'CENTER' }> = {
  visible: { name: 'ISO-WIDE-0.50', color: 7, linetype: 'CONTINUOUS' },
  hidden: { name: 'ISO-HIDDEN-0.25', color: 8, linetype: 'DASHED' },
  center: { name: 'ISO-CENTER-0.25', color: 1, linetype: 'CENTER' },
  dim: { name: 'ISO-DIM-0.25', color: 3, linetype: 'CONTINUOUS' },
  text: { name: 'ISO-TEXT-0.25', color: 2, linetype: 'CONTINUOUS' },
  thin: { name: 'ISO-NARROW-0.25', color: 8, linetype: 'CONTINUOUS' },
  medium: { name: 'ISO-0.35', color: 4, linetype: 'CONTINUOUS' },
  border: { name: 'ISO-FRAME-0.70', color: 7, linetype: 'CONTINUOUS' },
};

export function drawingToDxf(d: Drawing): string {
  const w = new DxfWriter(Object.values(DXF_LAYERS));
  for (const e of d.entities) {
    const layer = DXF_LAYERS[e.layer].name;
    switch (e.t) {
      case 'line':
        w.line(e.a.x, e.a.y, e.b.x, e.b.y, layer);
        break;
      case 'circle':
        w.circle(e.c.x, e.c.y, e.r, layer);
        break;
      case 'poly':
        if (e.fill && e.pts.length >= 3 && e.pts.length <= 4) w.solid(e.pts, layer);
        else w.polyline(e.pts, e.closed, layer);
        break;
      case 'text':
        w.text(e.p.x, e.p.y, e.h, e.text, {
          layer,
          rot: e.rot,
          align: e.anchor === 'middle' ? 'center' : e.anchor === 'end' ? 'right' : 'left',
        });
        break;
    }
  }
  return w.toString();
}
