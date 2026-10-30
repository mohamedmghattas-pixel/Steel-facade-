/** Drawing → SVG (preview / PDF) and DXF (CAD exchange). */
import { DxfWriter } from '../io/dxfWriter';
import type { DEnt, DLayer, Drawing } from './types';

const STYLE: Record<DLayer, { w: number; dash?: string; color: string }> = {
  visible: { w: 0.35, color: '#000' },
  hidden: { w: 0.22, dash: '2.5 1.2', color: '#000' },
  center: { w: 0.18, dash: '8 1.5 1 1.5', color: '#555' },
  dim: { w: 0.18, color: '#1f4e8c' },
  text: { w: 0.18, color: '#000' },
  border: { w: 0.5, color: '#000' },
  thin: { w: 0.18, color: '#000' },
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
  const stroke = (l: DLayer) => {
    const st = STYLE[l];
    return `stroke="${st.color}" stroke-width="${st.w}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  };
  for (const e of d.entities) out.push(svgEnt(e, Y, stroke));
  out.push('</svg>');
  return out.join('\n');
}

function svgEnt(e: DEnt, Y: (y: number) => number, stroke: (l: DLayer) => string): string {
  switch (e.t) {
    case 'line':
      return `<line x1="${n(e.a.x)}" y1="${n(Y(e.a.y))}" x2="${n(e.b.x)}" y2="${n(Y(e.b.y))}" ${stroke(e.layer)}/>`;
    case 'circle':
      return `<circle cx="${n(e.c.x)}" cy="${n(Y(e.c.y))}" r="${n(e.r)}" ${stroke(e.layer)}/>`;
    case 'poly': {
      const pts = e.pts.map((p) => `${n(p.x)},${n(Y(p.y))}`).join(' ');
      return `<${e.closed ? 'polygon' : 'polyline'} points="${pts}" ${stroke(e.layer)}/>`;
    }
    case 'text': {
      const x = n(e.p.x);
      const y = n(Y(e.p.y));
      const rot = e.rot ? ` transform="rotate(${n(-e.rot)} ${x} ${y})"` : '';
      const color = STYLE[e.layer].color;
      return `<text x="${x}" y="${y}" font-size="${n(e.h * 1.4)}" text-anchor="${e.anchor ?? 'start'}" fill="${color}"${rot}>${esc(e.text)}</text>`;
    }
  }
}

const DXF_LAYERS: Record<DLayer, { name: string; color: number; linetype: 'CONTINUOUS' | 'DASHED' | 'CENTER' }> = {
  visible: { name: 'VISIBLE', color: 7, linetype: 'CONTINUOUS' },
  hidden: { name: 'HIDDEN', color: 8, linetype: 'DASHED' },
  center: { name: 'CENTER', color: 1, linetype: 'CENTER' },
  dim: { name: 'DIMENSIONS', color: 5, linetype: 'CONTINUOUS' },
  text: { name: 'TEXT', color: 7, linetype: 'CONTINUOUS' },
  border: { name: 'BORDER', color: 7, linetype: 'CONTINUOUS' },
  thin: { name: 'THIN', color: 8, linetype: 'CONTINUOUS' },
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
        w.polyline(e.pts, e.closed, layer);
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
