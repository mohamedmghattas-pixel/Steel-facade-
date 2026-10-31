import { describe, expect, it } from 'vitest';
import { IfcAPI, IFCANNOTATION, IFCBUILDINGELEMENTPROXY, IFCSIUNIT, IFCVIRTUALELEMENT, IFCCONVERSIONBASEDUNIT } from 'web-ifc';
import { sampleProject } from '../src/core/sample';
import { deriveModel, type DerivedModel } from '../src/core/derive/model';
import { addLine, createProject, defaultMovement } from '../src/core/model/ops';
import { autoConnect, resolveParams } from '../src/core/connections/registry';
import type { Connection, Project, Vec3 } from '../src/core/model/types';
import { madd } from '../src/core/model/geometry';
import { runCodeChecks, ruleById } from '../src/core/codes';
import {
  combine,
  deriveSlot,
  movementReport,
  movementSettings,
  resolveMovement,
  slabBracketMovement,
  thermalMovement,
  toleranceStack,
} from '../src/core/movement';
import {
  applySurvey,
  clearSurveyAdjustments,
  parseSurveyCsv,
  parseSurveyDxf,
  parseSurveyIfc,
  settingOutCsv,
  settingOutRows,
  settingOutXlsx,
  surveyBrackets,
} from '../src/core/survey';

const brackets = (p: Project) => Object.values(p.connections).filter((c) => c.type === 'slabBracket');
const ctxOf = (p: Project, dm: DerivedModel, c: Connection) => ({ p, c, v: resolveParams(c, p), geom: (id: string) => dm.geoms.get(id) });
const fin = (dm: DerivedModel, c: Connection) => dm.connectionOut.get(c.id)!.plates.find((pl) => pl.key === 'fin')!;
const back = (dm: DerivedModel, c: Connection) => dm.connectionOut.get(c.id)!.plates.find((pl) => pl.key === 'back')!;
/** The edge-mounted, fixed bracket at a stack joint (sample: z = 3500). */
const stackBracket = (p: Project) => brackets(p).find((c) => c.secondary.length === 2)!;

describe('thermal movement', () => {
  it('ΔL = α·ΔT·L for a 3 m steel transom over the default range', () => {
    const ms = defaultMovement(); // install 15 °C, −20 … +60 °C
    const t = thermalMovement(3000, 'S355', ms);
    expect(t.alpha).toBe(12e-6);
    expect(t.dTexp).toBe(45);
    expect(t.dTcon).toBe(35);
    expect(t.expansion).toBeCloseTo(1.62, 6);
    expect(t.contraction).toBeCloseTo(1.26, 6);
    expect(t.max).toBeCloseTo(1.62, 6);
  });

  it('uses the material coefficient: stainless and aluminium move more', () => {
    const ms = defaultMovement();
    expect(thermalMovement(3000, '1.4401', ms).expansion).toBeCloseTo(16e-6 * 45 * 3000, 6);
    expect(thermalMovement(3000, '6063 T6', ms).expansion).toBeCloseTo(23e-6 * 45 * 3000, 6);
    expect(thermalMovement(3000, 'S355', { tempInstall: 70, tempMin: -20, tempMax: 60 }).expansion).toBe(0);
  });
});

describe('tolerance stacks', () => {
  it('combines linearly or by root-sum-square', () => {
    expect(combine([3, 4], 'rss')).toBeCloseTo(5);
    expect(combine([3, -4], 'linear')).toBe(7);
    const ms = resolveMovement(defaultMovement());
    const rss = toleranceStack(ms, 'out');
    expect(rss.items.map((i) => i.value)).toEqual([25, 5]);
    expect(rss.value).toBeCloseTo(Math.sqrt(25 * 25 + 5 * 5), 6);
    const lin = toleranceStack({ ...ms, combine: 'linear' }, 'out');
    expect(lin.value).toBe(30);
    expect(lin.value).toBeGreaterThan(rss.value);
  });

  it('drops structure tolerances at steel joints and replaces them by the survey accuracy where surveyed', () => {
    const ms = resolveMovement(defaultMovement());
    expect(toleranceStack(ms, 'out', { scope: 'steel' }).items.map((i) => i.name)).toEqual(['Steel erection']);
    const surveyed = toleranceStack(ms, 'out', { surveyed: true });
    expect(surveyed.items.map((i) => i.name)).toEqual(['Steel erection', 'Survey accuracy']);
    expect(surveyed.value).toBeCloseTo(Math.sqrt(25 + 9), 6);
  });

  it('derives slot length = d0 + 2·(T + M), rounded up to 5 mm, with caps', () => {
    const ms = resolveMovement(defaultMovement());
    const s = deriveSlot(13, 20, ms);
    expect(s.required).toBe(40);
    expect(s.requiredLength).toBe(55);
    expect(s.extra).toBe(42);
    const capped = deriveSlot(13, 20, ms, [{ value: 17, reason: 'long slot' }]);
    expect(capped.extra).toBe(17);
    expect(capped.capped?.reason).toBe('long slot');
    expect(deriveSlot(13, 0, ms).extra).toBe(0);
  });
});

describe('auto slots on the slab bracket', () => {
  it('derives fin slot, anchor slot and stack gap from tolerances and movement', () => {
    const p = sampleProject();
    const c = stackBracket(p);
    let dm = deriveModel(p);
    // Default: ±20 slab level → 55 mm slot wanted, capped at the M12 long slot (30 mm overall).
    expect(fin(dm, c).holes[0].slot).toBe(17);
    // Anchor slot along the edge: RSS(10, 2) = 10.2 → 15 + 20.4 → 40 mm → 25 extra.
    expect(back(dm, c).holes[0].slot).toBe(25);
    const m = slabBracketMovement(ctxOf(p, dm, c))!;
    expect(m.role).toBe('fixed');
    // Gap: ΔL of the 3.5 m mullion above (1.89) + 20 slab deflection → 21.9 → 25.
    expect(m.gap!.required).toBeCloseTo(12e-6 * 45 * 3500 + 20, 6);
    expect(m.gapValue).toBe(25);
    const upper = dm.parts.find((pt) => pt.memberId === c.secondary[1])!;
    expect(upper.length).toBeCloseTo(3500 - 25, 6);

    // Special slots (no code cap): the slot follows the tolerance (42 wanted), up to the fin's
    // edge distance: holes 40 mm from the fin ends → 2·(40 − 1.5·13) = 41.
    c.params.slotCap = 'none (special slot)';
    dm = deriveModel(p);
    expect(fin(dm, c).holes[0].slot).toBe(41);
    expect(slabBracketMovement(ctxOf(p, dm, c))!.fin.cap?.reason).toMatch(/fin plate/);
    p.settings.movement.tolerances.find((t) => t.id === 'tol-slab-level')!.value = 10;
    p.settings.movement.tolerances.find((t) => t.id === 'tol-anchor')!.value = 5;
    dm = deriveModel(p);
    expect(fin(dm, c).holes[0].slot).toBe(22); // 13 + 20 = 33 → 35
    expect(back(dm, c).holes[0].slot).toBe(15); // 15 + 2·RSS(5, 2) = 25.8 → 30

    // Manual values when auto slots are off.
    c.params.autoSlots = false;
    dm = deriveModel(p);
    expect(fin(dm, c).holes[0].slot).toBe(17);
    expect(back(dm, c).holes[0].slot).toBe(20);
    expect(dm.parts.find((pt) => pt.memberId === c.secondary[1])!.length).toBeCloseTo(3480, 6);
  });

  it('RSS and linear stacks give different auto anchor slots (top mount, out of plane)', () => {
    const p = sampleProject();
    const top = brackets(p).find((c) => c.params.mount === 'top')!;
    expect(back(deriveModel(p), top).holes[0].slot).toBe(55); // 15 + 2·25.5 = 66 → 70
    p.settings.movement.combine = 'linear';
    expect(back(deriveModel(p), top).holes[0].slot).toBe(60); // 15 + 2·30 = 75
  });

  it('sliding brackets take thermal movement and slab deflection; transoms get one slotted end', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    const rep = movementReport(p, dm);
    const sliding = rep.rows.filter((r) => r.provision.key === 'finSlot' && r.joint.includes('sliding'));
    expect(sliding.length).toBe(5); // the bottom bracket of each lower mullion
    expect(sliding[0].provision.move).toBeCloseTo(12e-6 * 45 * 3500 + 20, 6);
    const transomSlots = rep.rows.filter((r) => r.provision.key === 'slot');
    expect(transomSlots.length).toBeGreaterThan(0);
    // 1.5 m bay: 2·(2 fabrication + 0.81 ΔL) = 5.6 → 13 + 5.6 → 20 mm → 7 extra.
    expect(transomSlots[0].provision.provided).toBe(7);
    expect(transomSlots[0].provision.ok).toBe(true);
    const transom = dm.parts.find((pt) => pt.role === 'transom')!;
    expect(transom.holes.filter((h) => (h.slot ?? 0) > 0)).toHaveLength(1);
    expect(rep.members.length).toBe(Object.values(p.members).filter((m) => m.profile).length);
  });

  it('code checks flag insufficient movement capacity (warnings, no errors on the sample)', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    const rs = runCodeChecks(p, dm);
    for (const r of rs.filter((x) => x.rule.startsWith('move.'))) expect(ruleById(r.rule), r.rule).toBeTruthy();
    expect(rs.filter((r) => r.severity === 'error')).toEqual([]);
    expect(rs.some((r) => r.rule === 'move.slot' && r.severity === 'warning' && /long-slot maximum/.test(r.message))).toBe(true);
    expect(rs.some((r) => r.rule === 'move.thermal' && r.severity === 'info')).toBe(true);
    // A manual stack gap that closes is flagged.
    const c = stackBracket(p);
    c.params.autoSlots = false;
    c.params.gap = 10;
    const rs2 = runCodeChecks(p, deriveModel(p));
    expect(rs2.some((r) => r.rule === 'move.gap' && r.connectionId === c.id)).toBe(true);
  });

  it('flags a transom fixed at both ends', () => {
    const p = createProject('Fixed transom');
    addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3500 }, { profile: 'SHS 100x100x5', role: 'mullion' });
    addLine(p, { x: 3000, y: 0, z: 0 }, { x: 3000, y: 0, z: 3500 }, { profile: 'SHS 100x100x5', role: 'mullion' });
    addLine(p, { x: 0, y: 0, z: 1500 }, { x: 3000, y: 0, z: 1500 }, { profile: 'RHS 100x50x4', role: 'transom', rotation: 90 });
    autoConnect(p, { joint: 'endPlate', mullionBrackets: false, postBases: false, slabSide: 1, standoff: 150 });
    const rows = movementReport(p, deriveModel(p)).rows.filter((r) => r.provision.key === 'thermalEnd');
    expect(rows).toHaveLength(1);
    expect(rows[0].provision.required).toBeCloseTo(12e-6 * 45 * 3000, 6);
  });
});

// ---------------------------------------------------------------------------

describe('survey import', () => {
  it('parses CSV with headers, separators and design columns', () => {
    const text = [
      'Point;X;Y;Z;Design X;Design Y;Design Z',
      '# comment',
      'S1;1000,5;150;3500;1000;150;3500',
      'S2,2500,152.5,3498.2',
      'S3\t4000\t149\t3502',
      '1500 0 7000',
      '7 6000 151 7001',
      'not,a,point',
    ].join('\n');
    const r = parseSurveyCsv(text);
    expect(r.points.map((p) => p.name)).toEqual(['S1', 'S2', 'S3', 'P4', '7']);
    expect(r.points[0].p).toEqual({ x: 1000.5, y: 150, z: 3500 });
    expect(r.points[0].design).toEqual({ x: 1000, y: 150, z: 3500 });
    expect(r.points[1].p).toEqual({ x: 2500, y: 152.5, z: 3498.2 });
    expect(r.points[3].p).toEqual({ x: 1500, y: 0, z: 7000 });
    expect(r.points[4].p.x).toBe(6000);
    expect(r.skipped.length).toBe(2); // header + "not,a,point"
    const m = parseSurveyCsv('A,1.0005,0.15,3.5', { scale: 1000, offset: { x: 0, y: 0, z: 100 } });
    expect(m.points[0].p.x).toBeCloseTo(1000.5, 6);
    expect(m.points[0].p.z).toBeCloseTo(3400, 6);
  });

  it('parses DXF POINT entities named by nearby text, and INSERT positions as fallback', () => {
    const ent = (...kv: (string | number)[]) => kv.map(String).join('\n');
    const dxf = (body: string) => ['0', 'SECTION', '2', 'ENTITIES', body, '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const points = dxf(
      [
        ent(0, 'POINT', 8, 'SURVEY', 10, 1000, 20, 150, 30, 3500),
        ent(0, 'TEXT', 8, 'SURVEY', 10, 1010, 20, 160, 30, 3500, 40, 10, 1, 'S1'),
        ent(0, 'POINT', 8, 'SURVEY', 10, 2500, 20, 151, 30, 3497),
      ].join('\n'),
    );
    const r = parseSurveyDxf(points);
    expect(r.points.map((p) => p.name)).toEqual(['S1', 'SURVEY-1']);
    expect(r.points[1].p).toEqual({ x: 2500, y: 151, z: 3497 });
    const inserts = dxf(ent(0, 'INSERT', 8, '0', 2, 'SP', 10, 10, 20, 20, 30, 30));
    const ri = parseSurveyDxf(inserts);
    expect(ri.points).toHaveLength(1);
    expect(ri.points[0].p).toEqual({ x: 10, y: 20, z: 30 });
  });

  it('parses IFC annotation / proxy placements with web-ifc (metres → mm)', async () => {
    const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('survey.ifc','2026-10-31T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Survey',$,$,$,$,$,#2);
#10=IFCCARTESIANPOINT((10.,0.,0.));
#11=IFCAXIS2PLACEMENT3D(#10,$,$);
#12=IFCLOCALPLACEMENT($,#11);
#20=IFCCARTESIANPOINT((1.5,0.15,3.5));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT(#12,#21);
#23=IFCANNOTATION('1YvctVUKr0kugbFTf53O9L',$,'SP-01',$,$,#22,$,$);
#30=IFCCARTESIANPOINT((0.,0.,7.));
#31=IFCAXIS2PLACEMENT3D(#30,$,$);
#32=IFCLOCALPLACEMENT($,#31);
#33=IFCBUILDINGELEMENTPROXY('2YvctVUKr0kugbFTf53O9L',$,'SP-02',$,$,#32,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
    const api = new IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(step));
    const r = parseSurveyIfc(api, model, { IFCANNOTATION, IFCBUILDINGELEMENTPROXY, IFCVIRTUALELEMENT, IFCSIUNIT, IFCCONVERSIONBASEDUNIT });
    api.CloseModel(model);
    expect(r.points.map((p) => p.name)).toEqual(['SP-01', 'SP-02']);
    expect(r.points[0].p.x).toBeCloseTo(11500, 6);
    expect(r.points[0].p.y).toBeCloseTo(150, 6);
    expect(r.points[0].p.z).toBeCloseTo(3500, 6);
    expect(r.points[1].p.z).toBeCloseTo(7000, 6);
  });
});

describe('survey-driven brackets', () => {
  /** Survey points at the design reference of two edge brackets, with deviations (mm, facade directions). */
  function surveyed(devA: { out: number; vertical: number }, devB: { out: number; vertical: number }) {
    const p = sampleProject();
    const dm = deriveModel(p);
    const rows = surveyBrackets(p, dm);
    expect(rows.every((r) => r.status === 'unmatched')).toBe(true);
    const edge = rows.filter((r) => r.ref.mount === 'edge' && r.ref.point.z > 3000 && r.ref.point.z < 4000);
    const [a, b] = edge;
    const at = (r: (typeof rows)[number], d: { out: number; vertical: number }): Vec3 => madd(madd(r.ref.point, r.ref.out, d.out), r.ref.vertical, d.vertical);
    p.survey.points = [
      { id: 's1', name: 'S1', p: at(a, devA), design: a.ref.point },
      { id: 's2', name: 'S2', p: at(b, devB) },
      { id: 'far', name: 'FAR', p: { x: -5000, y: 0, z: 0 } },
    ];
    return { p, a: a.connectionId, b: b.connectionId };
  }

  it('matches brackets, decomposes the deviation and flags what exceeds the adjustability', () => {
    const { p, a, b } = surveyed({ out: 2, vertical: -3 }, { out: 30, vertical: 1 });
    const dm = deriveModel(p);
    const rows = surveyBrackets(p, dm);
    const ra = rows.find((r) => r.connectionId === a)!;
    const rb = rows.find((r) => r.connectionId === b)!;
    expect(ra.point?.name).toBe('S1');
    expect(ra.deviation!.out).toBeCloseTo(2, 6);
    expect(ra.deviation!.vertical).toBeCloseTo(-3, 6);
    expect(ra.status).toBe('ok');
    expect(rb.point?.name).toBe('S2');
    expect(rb.deviation!.out).toBeCloseTo(30, 6);
    expect(rb.status).toBe('exceeds');
    expect(rows.filter((r) => r.point).length).toBe(2); // FAR is outside the match radius
    const errs = runCodeChecks(p, dm).filter((r) => r.rule === 'move.survey');
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe('error');
    expect(errs[0].connectionId).toBe(b);
  });

  it('applies made-to-measure adjustments to the geometry, and clears them', () => {
    const { p, b } = surveyed({ out: 2, vertical: -3 }, { out: 30, vertical: 1 });
    const dm0 = deriveModel(p);
    const before = back(dm0, p.connections[b]);
    const finBefore = fin(dm0, p.connections[b]);
    expect(applySurvey(p, dm0, 'exceeding')).toBe(1);
    expect(p.connections[b].params.surveyOut).toBe(30);
    expect(p.connections[b].params.surveyVert).toBeUndefined(); // 1 mm fits the slot
    const dm = deriveModel(p);
    const after = back(dm, p.connections[b]);
    const rb = surveyBrackets(p, dm).find((r) => r.connectionId === b)!;
    expect(rb.status).toBe('adjusted');
    const mv = (x: Vec3, y: Vec3) => Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z);
    expect(mv(after.frame.origin, before.frame.origin)).toBeCloseTo(30, 6);
    const finAfter = fin(dm, p.connections[b]);
    expect(finAfter.outline[2].y - finBefore.outline[2].y).toBeCloseTo(30, 6); // fin 30 mm longer
    expect(runCodeChecks(p, dm).filter((r) => r.rule === 'move.survey')).toEqual([]);
    // The made-to-measure bracket gets its own mark.
    const markA = dm.partByRef.get(`c:${b}:back`)!.assembly;
    expect(dm.assemblies.filter((x) => x.mark === markA)).toHaveLength(1);
    // 'all' adjusts every matched direction (rounded to 5 mm).
    applySurvey(p, dm, 'all');
    expect(Object.values(p.connections).filter((c) => c.params.surveyOut !== undefined || c.params.surveyVert !== undefined)).toHaveLength(2);
    expect(clearSurveyAdjustments(p)).toBe(2);
    expect(Object.values(p.connections).some((c) => 'surveyOut' in c.params)).toBe(false);
  });

  it('builds the setting-out table and exports CSV / XLSX', () => {
    const { p, a, b } = surveyed({ out: 2, vertical: -3 }, { out: 30, vertical: 1 });
    const dm = deriveModel(p);
    const rows = settingOutRows(p, dm);
    expect(rows).toHaveLength(brackets(p).length);
    const ra = rows.find((r) => r.connectionId === a)!;
    expect(ra.mark).toMatch(/^BK\d+$/);
    expect(ra.location).toMatch(/^Grid \d.* \/ L\d+/);
    expect(ra.pointName).toBe('S1');
    expect(ra.statusText).toMatch(/OK/);
    // Packing nominal 10 + 2 out; fin slot −3 mm vertical.
    expect(ra.site).toContain('pack 12 mm');
    expect(ra.site).toContain('fin slot −3 mm vert');
    expect(rows.find((r) => r.connectionId === b)!.statusText).toMatch(/^EXCEEDS/);
    expect(rows.filter((r) => r.status === 'unmatched').length).toBe(rows.length - 2);
    const csv = settingOutCsv(p, dm).split('\r\n');
    expect(csv[0]).toMatch(/^Mark,Grid \/ level,Design X/);
    expect(csv.filter(Boolean)).toHaveLength(rows.length + 1);
    const xlsx = settingOutXlsx(p, dm);
    expect(String.fromCharCode(xlsx[0], xlsx[1])).toBe('PK');
  });

  it('keeps movement settings resolvable for old projects', () => {
    const p = sampleProject();
    (p.settings as { movement?: unknown }).movement = undefined;
    expect(movementSettings(p).tolerances.length).toBeGreaterThan(0);
    expect(() => deriveModel(p)).not.toThrow();
  });
});
