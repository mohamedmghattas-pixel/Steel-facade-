/**
 * STEP AP214 (ISO 10303-21) of the part meshes: one product per part, its
 * shape a FACETED_BREP (CLOSED_SHELL of planar FACE_SURFACEs bounded by
 * POLY_LOOPs), lengths in millimetres. Product names are the part marks;
 * ids the part references. Pure writer, see docs/EXPORT_PACKAGE.md.
 */
import type { PartMesh } from './meshes';

const real = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  const s = (Object.is(r, -0) ? 0 : r).toString();
  return /[.eE]/.test(s) ? s : `${s}.`;
};
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '?')}'`;

export interface StepOptions {
  name: string;
  author?: string;
  organization?: string;
  /** ISO time stamp for the header (default now). */
  time?: string;
}

/** The STEP file text. */
export function meshesToStep(meshes: PartMesh[], o: StepOptions): string {
  const lines: string[] = [];
  let id = 0;
  const add = (s: string) => {
    id++;
    lines.push(`#${id}=${s};`);
    return `#${id}`;
  };
  const appCtx = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = add(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const defCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const len = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const ang = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const sol = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${len},${ang},${sol}))REPRESENTATION_CONTEXT('',''))`);
  const origin = add("CARTESIAN_POINT('',(0.,0.,0.))");
  const dz = add("DIRECTION('',(0.,0.,1.))");
  const dx = add("DIRECTION('',(1.,0.,0.))");
  const world = add(`AXIS2_PLACEMENT_3D('',${origin},${dz},${dx})`);
  const seen = new Map<string, number>();
  for (const m of meshes) {
    const n = (seen.get(m.mark) ?? 0) + 1;
    seen.set(m.mark, n);
    const name = m.assembly ? `${m.mark} (${m.assembly})` : m.mark;
    const prod = add(`PRODUCT(${str(m.ref)},${str(name)},${str(`${m.profile} ${m.material}`.trim())},(${prodCtx}))`);
    add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${prod}))`);
    const form = add(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
    const def = add(`PRODUCT_DEFINITION('design','',${form},${defCtx})`);
    const pds = add(`PRODUCT_DEFINITION_SHAPE('','',${def})`);
    // Vertices and faces of the solid.
    const p = m.positions;
    const pts: string[] = [];
    for (let i = 0; i < p.length; i += 3) pts.push(add(`CARTESIAN_POINT('',(${real(p[i])},${real(p[i + 1])},${real(p[i + 2])}))`));
    const faces: string[] = [];
    const t = m.indices;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i];
      const b = t[i + 1];
      const c = t[i + 2];
      const ax = p[a * 3];
      const ay = p[a * 3 + 1];
      const az = p[a * 3 + 2];
      const ux = p[b * 3] - ax;
      const uy = p[b * 3 + 1] - ay;
      const uz = p[b * 3 + 2] - az;
      const vx = p[c * 3] - ax;
      const vy = p[c * 3 + 1] - ay;
      const vz = p[c * 3 + 2] - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      const ul = Math.hypot(ux, uy, uz);
      if (nl < 1e-9 || ul < 1e-9) continue;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const loop = add(`POLY_LOOP('',(${pts[a]},${pts[b]},${pts[c]}))`);
      const bound = add(`FACE_OUTER_BOUND('',${loop},.T.)`);
      const nrm = add(`DIRECTION('',(${real(nx)},${real(ny)},${real(nz)}))`);
      const ref = add(`DIRECTION('',(${real(ux / ul)},${real(uy / ul)},${real(uz / ul)}))`);
      const place = add(`AXIS2_PLACEMENT_3D('',${pts[a]},${nrm},${ref})`);
      const plane = add(`PLANE('',${place})`);
      faces.push(add(`FACE_SURFACE('',(${bound}),${plane},.T.)`));
    }
    const shell = add(`CLOSED_SHELL('',(${faces.join(',')}))`);
    const brep = add(`FACETED_BREP(${str(`${m.mark}.${n}`)},${shell})`);
    const rep = add(`FACETED_BREP_SHAPE_REPRESENTATION(${str(m.mark)},(${brep},${world}),${ctx})`);
    add(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  }
  const time = o.time ?? new Date().toISOString().slice(0, 19);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('FacadeSteel model: one faceted solid per part'),'2;1');",
    `FILE_NAME(${str(o.name)},${str(time)},(${str(o.author ?? '')}),(${str(o.organization ?? '')}),'FacadeSteel','FacadeSteel','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** Light structural check: every #ref used is defined, ids unique, header present. Returns problems (empty = ok). */
export function checkStep(text: string): string[] {
  const out: string[] = [];
  if (!text.startsWith('ISO-10303-21;') || !text.includes('END-ISO-10303-21;')) out.push('missing ISO-10303-21 envelope');
  const data = text.slice(text.indexOf('DATA;'), text.lastIndexOf('ENDSEC;'));
  const defined = new Set<string>();
  for (const m of data.matchAll(/^#(\d+)=/gm)) {
    if (defined.has(m[1])) out.push(`#${m[1]} defined twice`);
    defined.add(m[1]);
  }
  for (const m of data.matchAll(/#(\d+)\b(?!=)/g)) if (!defined.has(m[1])) out.push(`#${m[1]} used but not defined`);
  return [...new Set(out)].slice(0, 20);
}
