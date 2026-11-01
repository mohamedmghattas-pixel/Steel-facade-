/**
 * Package outputs that have no menu export of their own: part schedule, fixing
 * schedule, bar cutting plan (CSV / PDF pages), sheet nesting pages, the
 * project input and profiles-used JSON, erection notes, and several drawing
 * sheets in one DXF. Pure (PDFs as SVG pages in mm for the PDF adapter).
 */
import type { Project } from '../model/types';
import { uniqueParts, type DerivedModel } from '../derive/model';
import type { DEnt, Drawing } from '../drawings/types';
import { anchorRows } from '../drawings';
import { planBars } from '../optimize/barNesting';
import { nestPlates } from '../optimize/plateNesting';
import { flatPlate } from '../fabrication/plateDxf';
import { getProfile, type ProfileDef } from '../library/profiles';
import { toCsv, type Row } from '../reports/bom';
import { pdfSafe, tablesToSvgPages, type SvgPage, type TableDoc } from '../reports/tablePages';
import { wireframeFingerprint } from '../wireframe/record';
import { drawingType } from './outputs';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const projectLine = (p: Project) => `${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}${p.info.client ? ` · Client: ${p.info.client}` : ''}`;
const esc = (s: string) => pdfSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

// ---------------------------------------------------------------------------
// Part schedule

export function partScheduleRows(dm: DerivedModel, drawings: Drawing[]): Row[] {
  const dwg = new Map(drawings.filter((d) => d.kind === 'part').map((d) => [d.mark, d.number]));
  const usedIn = new Map<string, Set<string>>();
  for (const a of dm.assemblies)
    for (const r of a.parts) {
      const m = dm.partByRef.get(r)?.mark;
      if (m) (usedIn.get(m) ?? usedIn.set(m, new Set()).get(m)!).add(a.mark);
    }
  return [
    ['Mark', 'Qty', 'Type', 'Profile / plate', 'Length / size (mm)', 'Material', 'Finish', 'kg each', 'kg total', 'Drawing', 'Used in'],
    ...uniqueParts(dm).map(({ part, qty }) => [
      part.mark,
      qty,
      part.kind === 'plate' ? 'Plate' : part.kind === 'member' ? 'Member' : 'Profile part',
      part.kind === 'plate' ? `PL${part.thickness}` : part.profile,
      part.kind === 'plate' ? `${Math.round(part.length)} x ${Math.round(part.width)}` : Math.round(part.length),
      part.material,
      part.finish === 'hdg+paint' ? 'HDG + paint' : part.finish === 'hdg' ? 'HDG' : part.finish === 'paint' ? 'Paint' : '-',
      r2(part.mass),
      r1(part.mass * qty),
      dwg.get(part.mark) ?? '',
      [...(usedIn.get(part.mark) ?? [])].join(', '),
    ]),
  ];
}

export function partSchedulePages(p: Project, dm: DerivedModel, drawings: Drawing[]): SvgPage[] {
  const rows = partScheduleRows(dm, drawings);
  const body = rows.slice(1);
  const pieces = body.reduce((s, r) => s + Number(r[1]), 0);
  const kg = body.reduce((s, r) => s + Number(r[8]), 0);
  const doc: TableDoc = {
    title: 'Part schedule',
    meta: [`Project: ${projectLine(p)}`, `${body.length} part marks · ${pieces} pieces · ${r1(kg)} kg · printed ${today()}`],
    sections: [{ title: 'Single parts', head: rows[0].map(String), rows: body, footer: ['Total', pieces, '', '', '', '', '', '', r1(kg), '', ''], widths: [7, 4, 8, 14, 11, 7, 7, 6, 7, 14, 15] }],
  };
  return tablesToSvgPages([doc], { w: 297, h: 210 }, `${p.info.name} · FacadeSteel part schedule`);
}

// ---------------------------------------------------------------------------
// Fixing schedule

/** Site fixings: every anchor (with bracket, grid and level reference) and every site bolt group. */
export function fixingScheduleCsv(p: Project, dm: DerivedModel): string {
  const rows: Row[] = [['Kind', 'Id', 'Bracket / assembly', 'Connection', 'Grid ref', 'Level ref', 'X', 'Y', 'Z', 'Fixing', 'Type / grade', 'Size', 'Length (mm)', 'Qty']];
  for (const a of anchorRows(p, dm)) rows.push(['Anchor', a.id, a.bracket, a.connectionId, a.grid, a.level, r1(a.x), r1(a.y), r1(a.z), a.mount, a.type, a.size, a.length, a.perBracket]);
  const asmOfConn = new Map<string, string>();
  for (const part of dm.parts) {
    if (!part.connectionId || asmOfConn.has(part.connectionId)) continue;
    const a = dm.assemblies.find((x) => x.parts.includes(part.ref));
    if (a) asmOfConn.set(part.connectionId, a.mark);
  }
  let n = 0;
  for (const b of dm.bolts) {
    if (b.kind !== 'bolt' || !b.positions.length) continue;
    n++;
    const c = b.positions[0];
    rows.push(['Bolt', `B${n}`, asmOfConn.get(b.connectionId) ?? '', b.connectionId, '', '', r1(c.x), r1(c.y), r1(c.z), 'site bolt', b.grade, b.size, Math.round(b.length), b.positions.length]);
  }
  return toCsv(rows);
}

// ---------------------------------------------------------------------------
// Bar cutting plan

export function cutPlanCsv(p: Project, dm: DerivedModel): string {
  const rows: Row[] = [['Profile', 'Material', 'Bar', 'Bar length (mm)', 'Source', 'Cut', 'Mark', 'Length (mm)', 'Used (mm)', 'Waste (mm)']];
  for (const g of planBars(p, dm).groups) {
    g.bars.forEach((b, i) => b.cuts.forEach((c, j) => rows.push([g.profile, g.material, i + 1, b.stock, b.source === 'stock' ? 'stock' : 'purchase', j + 1, c.mark, r1(c.length), Math.round(b.used), Math.round(b.waste)])));
    for (const u of g.unplaced) rows.push([g.profile, g.material, '', '', 'too long for stock', '', u.mark, r1(u.length), '', '']);
  }
  return toCsv(rows);
}

const SVG_HEAD = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">`;
const PAGE = { w: 420, h: 297 };
const M = 12;

function pageFrame(title: string, sub: string, n: number, of: number, foot: string): string {
  return (
    `<text x="${M}" y="${M + 6}" font-size="6" font-weight="bold">${esc(title)}</text>` +
    `<text x="${M}" y="${M + 12}" font-size="3.2">${esc(sub)}</text>` +
    `<line x1="${M}" y1="${PAGE.h - M}" x2="${PAGE.w - M}" y2="${PAGE.h - M}" stroke="#000" stroke-width="0.25"/>` +
    `<text x="${M}" y="${PAGE.h - M + 5}" font-size="2.8">${esc(foot)}</text>` +
    `<text x="${PAGE.w - M}" y="${PAGE.h - M + 5}" font-size="2.8" text-anchor="end">Page ${n} of ${of}</text>`
  );
}

/** Bars drawn to scale, one row per bar: pieces with mark and length, waste hatched grey. A3 landscape pages. */
export function cutPlanPages(p: Project, dm: DerivedModel): SvgPage[] {
  const groups = planBars(p, dm).groups;
  const rowH = 9;
  const top = M + 22;
  const bottom = PAGE.h - M - 6;
  const x0 = M + 46;
  const width = PAGE.w - M - x0 - 22;
  const pages: string[][] = [[]];
  let y = top;
  const room = (h: number) => {
    if (y + h > bottom) {
      pages.push([]);
      y = top;
    }
  };
  for (const g of groups) {
    room(10 + rowH);
    const longest = Math.max(...g.bars.map((b) => b.stock), 1);
    const k = width / longest;
    const head = `${g.profile} · ${g.material} — ${g.pieces} pieces, net ${r2(g.netLength / 1000)} m, ${(g.efficiency * 100).toFixed(1)} % used; buy ${g.purchase.map((x) => `${x.qty} x ${x.stock}`).join(' + ') || 'nothing'}${g.fromStock.length ? `; from stock ${g.fromStock.map((x) => `${x.qty} x ${x.stock}`).join(' + ')}` : ''}`;
    pages[pages.length - 1].push(`<text x="${M}" y="${n2(y + 5)}" font-size="3.6" font-weight="bold">${esc(head)}</text>`);
    y += 9;
    g.bars.forEach((b, i) => {
      room(rowH);
      const out = pages[pages.length - 1];
      out.push(`<text x="${M}" y="${n2(y + 4.6)}" font-size="2.8">${esc(`Bar ${i + 1}: ${b.stock} mm${b.source === 'stock' ? ' (stock)' : ''}`)}</text>`);
      out.push(`<rect x="${x0}" y="${n2(y)}" width="${n2(b.stock * k)}" height="6" fill="#e6e6e6" stroke="#000" stroke-width="0.25"/>`);
      let x = x0 + p.settings.endTrim * k;
      for (const c of b.cuts) {
        const w = c.length * k;
        out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="6" fill="#ffffff" stroke="#000" stroke-width="0.3"/>`);
        if (w > 9) out.push(`<text x="${n2(x + w / 2)}" y="${n2(y + 4.2)}" font-size="2.4" text-anchor="middle">${esc(`${c.mark} ${Math.round(c.length)}`)}</text>`);
        x += w + p.settings.kerf * k;
      }
      out.push(`<text x="${n2(x0 + b.stock * k + 2)}" y="${n2(y + 4.4)}" font-size="2.6">${esc(`waste ${Math.round(b.waste)}`)}</text>`);
      y += rowH;
    });
    if (g.unplaced.length) {
      room(rowH);
      pages[pages.length - 1].push(`<text x="${M}" y="${n2(y + 4.5)}" font-size="2.8" fill="#b00000">${esc(`Too long for the stock lengths: ${g.unplaced.map((u) => `${u.mark} ${Math.round(u.length)}`).join(', ')}`)}</text>`);
      y += rowH;
    }
    y += 4;
  }
  const sub = `Project: ${projectLine(p)} · stock ${p.settings.stockLengths.join(' / ')} mm · kerf ${p.settings.kerf} mm · end trim ${p.settings.endTrim} mm · ${today()}`;
  return pages.map((body, i) => ({ ...PAGE, svg: `${SVG_HEAD(PAGE.w, PAGE.h)}${pageFrame('Bar cutting plan', sub, i + 1, pages.length, `${p.info.name} · FacadeSteel`)}${body.join('')}</svg>` }));
}

/** One nested plate sheet per page, to scale: placed plates with their outline, holes and mark. A3 landscape. */
export function nestingPages(p: Project, dm: DerivedModel): SvgPage[] {
  const groups = nestPlates(p, dm);
  const sheets = groups.flatMap((g) => g.sheets.map((sh, i) => ({ g, sh, i })));
  const pages: SvgPage[] = [];
  const top = M + 22;
  const availW = PAGE.w - 2 * M;
  const availH = PAGE.h - top - M - 10;
  sheets.forEach(({ g, sh, i }, k) => {
    const s = Math.min(availW / sh.sheet.w, availH / sh.sheet.h);
    const ox = M;
    const oy = top;
    // Sheet coordinates (y up) to page (y down).
    const X = (x: number) => n2(ox + x * s);
    const Y = (y: number) => n2(oy + (sh.sheet.h - y) * s);
    const out: string[] = [`<rect x="${X(0)}" y="${Y(sh.sheet.h)}" width="${n2(sh.sheet.w * s)}" height="${n2(sh.sheet.h * s)}" fill="#f2f2f2" stroke="#000" stroke-width="0.35"/>`];
    for (const pl of sh.placements) {
      const part = dm.partByRef.get(pl.ref);
      if (!part) continue;
      const fp = flatPlate(part);
      // Rigid 90° counter-clockwise turn for rotated placements, as in the nested DXF.
      const tf = (u: number, v: number) => (pl.rotated ? { x: pl.x + (fp.h - v), y: pl.y + u } : { x: pl.x + u, y: pl.y + v });
      const pts = fp.outline.map((q) => tf(q.x, q.y));
      out.push(`<polygon points="${pts.map((q) => `${X(q.x)},${Y(q.y)}`).join(' ')}" fill="#ffffff" stroke="#000" stroke-width="0.3"/>`);
      for (const h of fp.holes) {
        const c = tf(h.x, h.y);
        out.push(`<circle cx="${X(c.x)}" cy="${Y(c.y)}" r="${n2(Math.max(0.2, (h.d / 2) * s))}" fill="none" stroke="#000" stroke-width="0.2"/>`);
      }
      const cx = pl.x + pl.w / 2;
      const cy = pl.y + pl.h / 2;
      out.push(`<text x="${X(cx)}" y="${Y(cy)}" font-size="${n2(Math.max(1.6, Math.min(4, (Math.min(pl.w, pl.h) * s) / 3)))}" text-anchor="middle">${esc(pl.mark)}</text>`);
    }
    const sub = `PL${g.thickness} ${g.material} · sheet ${i + 1} of ${g.sheets.length}: ${sh.sheet.w} x ${sh.sheet.h} mm · ${sh.placements.length} parts · ${(sh.utilisation * 100).toFixed(0)} % used · scale 1:${Math.round(1 / s)}`;
    pages.push({ ...PAGE, svg: `${SVG_HEAD(PAGE.w, PAGE.h)}${pageFrame(`Sheet nesting — NEST-${String(k + 1).padStart(3, '0')}`, `${projectLine(p)} · ${sub}`, k + 1, sheets.length, `${p.info.name} · FacadeSteel`)}${out.join('')}</svg>` });
  });
  return pages;
}

/** Global sheet numbers of the nested sheets (NEST-001 …) with their sizes, in the order of exportNestedSheets. */
export function nestSheetIds(p: Project, dm: DerivedModel): { nest: string; size: string; thickness: number; material: string; index: number }[] {
  let k = 0;
  return nestPlates(p, dm).flatMap((g) => g.sheets.map((sh, i) => ({ nest: String(++k).padStart(3, '0'), size: `${sh.sheet.w}x${sh.sheet.h}`, thickness: g.thickness, material: g.material, index: i })));
}

// ---------------------------------------------------------------------------
// Inputs

/** The project's design input (info, settings, grids, levels, wireframe, connections, survey, references) as JSON. */
export function inputJson(p: Project): string {
  return JSON.stringify(
    {
      schema: 'facadesteel.input',
      version: 1,
      generated: new Date().toISOString(),
      units: { length: 'mm', angle: 'deg', axes: 'X east, Y north, Z up' },
      project: p.info,
      settings: p.settings,
      grids: p.grids,
      levels: p.levels,
      wireframe: { fingerprint: wireframeFingerprint(p), nodes: Object.values(p.nodes), members: Object.values(p.members) },
      connections: Object.values(p.connections),
      plates: Object.values(p.plates),
      phases: p.phases,
      batches: p.batches,
      survey: p.survey,
      references: [...p.references, ...p.underlays].map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    },
    null,
    1,
  );
}

/** Profiles used by the model: section data per profile, the custom definitions, plate thicknesses. */
export function profilesUsedJson(p: Project, dm: DerivedModel): string {
  const custom = new Map((p.library.profiles as unknown as ProfileDef[]).map((d) => [d.name, d]));
  const byProfile = new Map<string, { count: number; length: number; materials: Set<string> }>();
  const plates = new Map<string, { count: number; materials: Set<string> }>();
  for (const part of dm.parts) {
    if (part.kind === 'plate') {
      const k = `PL${part.thickness}`;
      const e = plates.get(k) ?? { count: 0, materials: new Set() };
      e.count++;
      e.materials.add(part.material);
      plates.set(k, e);
      continue;
    }
    const e = byProfile.get(part.profile) ?? { count: 0, length: 0, materials: new Set() };
    e.count++;
    e.length += part.length;
    e.materials.add(part.material);
    byProfile.set(part.profile, e);
  }
  const profiles = [...byProfile.entries()].map(([name, e]) => {
    const pr = getProfile(name);
    return {
      name,
      standard: pr?.standard,
      family: pr?.family,
      spec: pr?.spec,
      massPerMetre: pr ? r2(pr.mass) : undefined,
      h: pr?.h,
      b: pr?.b,
      shape: pr?.shape,
      custom: custom.get(name) ?? undefined,
      pieces: e.count,
      totalLength: Math.round(e.length),
      materials: [...e.materials],
    };
  });
  return JSON.stringify({ schema: 'facadesteel.profilesUsed', version: 1, project: p.info.number || p.info.name, profiles, plates: [...plates.entries()].map(([name, e]) => ({ name, pieces: e.count, materials: [...e.materials] })) }, null, 1);
}

// ---------------------------------------------------------------------------
// Erection notes

export function erectionNotes(p: Project, dm: DerivedModel, drawings: Drawing[]): string {
  const er = drawings.filter((d) => d.kind === 'setout' || d.kind === 'anchors' || d.kind === 'sequence');
  const phases = [...p.phases].sort((a, b) => a.sequence - b.sequence);
  const mv = p.settings.movement;
  const L = [
    'ERECTION NOTES',
    '',
    `Project:  ${projectLine(p)}`,
    `Printed:  ${today()}`,
    '',
    'Sheets in this folder',
    ...er.map((d) => `  ${d.number}  ${drawingType(d.kind)}: ${d.title} (rev ${d.rev})`),
    '',
    'Erection sequence',
    ...(phases.length
      ? phases.map((ph) => {
          const asm = dm.assemblies.filter((a) => a.phase === ph.id);
          return `  ${ph.sequence}. ${ph.name}: ${asm.length} assemblies, ${r1(asm.reduce((s, a) => s + a.mass, 0))} kg`;
        })
      : ['  No phases defined: the erection sequence sheets use the default sequence by floor, bottom-up.']),
    '',
    'Fixings',
    `  ${dm.bolts.filter((b) => b.kind === 'anchor').reduce((s, b) => s + b.positions.length, 0)} anchors and ${dm.bolts.filter((b) => b.kind === 'bolt').reduce((s, b) => s + b.positions.length, 0)} site bolts — see "Fixing schedule.csv".`,
    '  Install anchors to the manufacturer\'s instructions (edge distance, embedment, torque). Anchor capacities are verified by the engineer of record.',
    '',
    'Tolerances (Project settings → movement and tolerances)',
    ...(mv?.tolerances?.length ? mv.tolerances.map((t) => `  ${t.name}: ±${t.value} mm (${t.direction})${t.source ? ` — ${t.source}` : ''}`) : ['  None entered.']),
    '',
    'Check the as-built slab edges against the setting-out plans before drilling; report deviations beyond the tolerances.',
    '',
  ];
  return L.join('\r\n');
}

// ---------------------------------------------------------------------------
// Several sheets in one DXF

function shift(e: DEnt, dx: number): DEnt {
  const m = (q: { x: number; y: number }) => ({ x: q.x + dx, y: q.y });
  switch (e.t) {
    case 'line':
      return { ...e, a: m(e.a), b: m(e.b) };
    case 'circle':
      return { ...e, c: m(e.c) };
    case 'poly':
      return { ...e, pts: e.pts.map(m) };
    case 'text':
    case 'image':
      return { ...e, p: m(e.p) };
  }
}

/** One drawing with the given sheets side by side (20 mm apart), for a single DXF of several sheets. */
export function sheetsSideBySide(ds: Drawing[], title: string): Drawing {
  const entities: DEnt[] = [];
  let x = 0;
  for (const d of ds) {
    for (const e of d.entities) entities.push(shift(e, x));
    x += d.sheet.w + 20;
  }
  const first = ds[0];
  return { ...first, id: `combined-${first.id}`, number: first.number, title, sheet: { w: Math.max(0, x - 20), h: Math.max(...ds.map((d) => d.sheet.h)) }, entities, viewports: [] };
}
