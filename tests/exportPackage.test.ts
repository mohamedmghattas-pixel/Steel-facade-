import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { jsPDF } from 'jspdf';
import { sampleProject } from '../src/core/sample';
import { deriveModel } from '../src/core/derive/model';
import { allDrawings, issueDrawings } from '../src/core/drawings';
import type { Project } from '../src/core/model/types';
import { OUTPUTS } from '../src/core/export/catalog';
import {
  DEFAULT_EXPORT_TEMPLATE,
  DEFAULT_TEMPLATE_SPEC,
  addFolder,
  addItem,
  copyTemplate,
  expandPattern,
  findFolder,
  moveFolderTo,
  moveItemTo,
  parseTemplateJson,
  removeItem,
  revisionFromDrawings,
  sanitizePath,
  sanitizeSegment,
  templateFromSpec,
  templateIssues,
  templateItems,
  templateToJson,
  walkFolders,
} from '../src/core/export/template';
import { buildPackage, MANIFEST_NAME, packageContext, packageTree, packageZipChunks, planPackage, planPaths, qafDecisions, relativePath, type PackagePlan } from '../src/core/export/package';
import { pdfOutlineTitles, pdfPageCount, type SvgPainter } from '../src/core/export/pdfBook';
import { QAF_ITEMS, defaultQafMapping, qafCells, qafWorkbook, vcfRows, vcfWorkbook } from '../src/core/export/forms';
import { partMeshes } from '../src/core/export/meshes';
import { meshesToObj } from '../src/core/export/obj';
import { checkStep, meshesToStep, meshesToStepAsync } from '../src/core/export/step';
import type { ExportTemplate } from '../src/core/export/types';
import { deflateRaw, entryText, readZip, rewriteZip } from '../src/core/io/zipRead';
import { fillXlsxTemplate, patchSheetXml, readXlsxCells } from '../src/core/io/xlsxTemplate';
import { migrateProject } from '../src/state/storage';
import { createProject } from '../src/core/model/ops';
import { unzipNames } from './unzip';
import { useStore } from '../src/state/store';
import { setPackagePainter } from '../src/ui/exportPackageActions';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { exportPackageModule } from '../src/assistant/modules/exportPackage';

/** svg2pdf needs a DOM; the stand-in writes the SVG length as text so every page has content. */
const stubPainter: SvgPainter = async (doc: jsPDF, svg: string) => {
  doc.text(`svg ${svg.length}`, 10, 10);
};

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const DATE = new Date(2026, 10, 1, 9, 30);
const CLIENT_FOLDERS = ['00-References', '01-Setting Out', '02-Single', '03-Assembly', '04-Erection', '05-Reports', '06-Exports', '07-Model', '08-Material List', '09-Optimization', '10-Quality Check List'];

/** The sample facade with everything that makes the optional items applicable. */
function fullProject(): Project {
  const p = sampleProject();
  const dm0 = deriveModel(p);
  p.batches = [
    { id: 'b1', name: 'Truck 1', date: '2026-11-10' },
    { id: 'b2', name: 'Truck 2' },
  ];
  Object.values(p.members).forEach((m, i) => {
    m.batch = i % 2 ? 'b2' : 'b1';
    if (m.role === 'transom') m.finish = 'hdg+paint';
  });
  const at = dm0.bolts.find((b) => b.kind === 'anchor')!.positions[0];
  p.survey.points.push({ id: 's1', name: 'SP1', p: { x: at.x + 3, y: at.y - 2, z: at.z + 1 } });
  const part = dm0.parts.find((x) => x.memberId)!;
  p.clashes.issues.push({ id: 'c1', guid: '0f8fad5b-d9cb-469f-a165-70867728950e', title: 'Mullion hits slab', kind: 'hard', status: 'open', a: part.ref, b: 'ref:slab', pos: { x: 0, y: 0, z: 0 }, distance: 12, created: '2026-10-30' });
  p.wireframe.approvals.push({ date: '2026-10-31T10:00:00.000Z', by: 'Client QA', note: 'As issued', fingerprint: 'abc123', summary: { lines: 10, nodes: 8, mullions: 5, transoms: 5, brackets: 0, other: 0, isolated: 0, junctions: 4, connected: 4 }, changes: 0 });
  p.settings.stock = [{ profile: 'SHS 100x100x5', length: 6000, qty: 2 }];
  p.references.push({ id: 'ref1', name: 'Slab model.ifc', kind: 'ifc', visible: true, opacity: 0.4, offset: { x: 0, y: 0, z: 0 } });
  const dm = deriveModel(p);
  issueDrawings(p, allDrawings(p, dm), { description: 'For construction', status: 'Released', date: '2026-10-31', drawn: 'MG', checked: 'QA', approved: 'PM' });
  return p;
}

function planFor(p: Project, template: ExportTemplate = DEFAULT_EXPORT_TEMPLATE, settings = {}, skip: string[] = []): PackagePlan {
  const dm = deriveModel(p);
  return planPackage(packageContext(p, dm, { settings, date: DATE }), template, new Set(skip));
}

const blobs = async (id: string) => (id === 'ref1' ? new TextEncoder().encode('ISO-10303-21; reference') : null);

describe('export template tokens and names', () => {
  const vals = { project: '25122', code: 'FWR', seq: '001', rev: 'R00', name: 'Block A', phase: '', mark: 'M1', drawingNo: 'FS-001-A-M1', drawingRev: 'A', ext: 'pdf' };

  it('expands the package folder pattern', () => {
    expect(expandPattern('{project}-{code}-{seq}-{rev}', vals).text).toBe('25122-FWR-001-R00');
    expect(expandPattern('{code}-{seq} Combined.{ext}', vals).text).toBe('FWR-001 Combined.pdf');
    expect(expandPattern('NEST-{nest}-S{sheetSize}.{ext}', { nest: '001', sheetSize: '1500x4000', ext: 'dxf' }).text).toBe('NEST-001-S1500x4000.dxf');
  });

  it('drops a separator next to an empty token', () => {
    expect(expandPattern('{phase}-{mark}', vals).text).toBe('M1');
    expect(expandPattern('{mark}-{phase}.{ext}', vals).text).toBe('M1.pdf');
    expect(expandPattern('Packing list {batch}.{ext}', vals).text).toBe('Packing list.pdf');
    expect(expandPattern('{mark} - {phase} - x', vals).text).toBe('M1 - x');
    expect(expandPattern('a-{phase}{mark}', vals).text).toBe('a-M1');
  });

  it('keeps unknown tokens as written and reports them', () => {
    const x = expandPattern('{project}_{nope}', vals);
    expect(x.text).toBe('25122_{nope}');
    expect(x.unknown).toEqual(['nope']);
  });

  it('keeps sub-folders of {item} but not of other tokens', () => {
    expect(expandPattern('{item}.{ext}', { item: 'PL10-S355/pl3', ext: 'dxf' }).text).toBe('PL10-S355/pl3.dxf');
    expect(expandPattern('{name}.{ext}', { name: 'East/West: A?', ext: 'pdf' }).text).toBe('East_West_ A_.pdf');
  });

  it('makes Windows-safe names', () => {
    expect(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeSegment('Drawings. . ')).toBe('Drawings');
    expect(sanitizeSegment('  lead')).toBe('lead');
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('nul.txt')).toBe('_nul.txt');
    expect(sanitizeSegment('com1')).toBe('_com1');
    expect(sanitizeSegment('Console')).toBe('Console');
    expect(sanitizeSegment('...')).toBe('_');
    expect(sanitizeSegment('tab\there')).toBe('tab_here');
    const long = sanitizeSegment(`${'x'.repeat(300)}.pdf`);
    expect(long.length).toBe(255);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(sanitizePath('01 Drawings\\PDF/ a. /../b?.pdf')).toBe('01 Drawings/PDF/a/b_.pdf');
  });

  it('derives the package revision from the drawing revisions', () => {
    expect(revisionFromDrawings([{ revisions: [] }])).toBe('R00');
    expect(revisionFromDrawings([{ revisions: [1] }, { revisions: [] }])).toBe('R00');
    expect(revisionFromDrawings([{ revisions: [1, 2, 3] }])).toBe('R02');
  });

  it('finds relative paths between package files', () => {
    expect(relativePath('07-Model/FWR-001 Model.obj', '07-Model/FWR-001 Model.mtl')).toBe('FWR-001 Model.mtl');
    expect(relativePath('a/b/x.obj', 'a/c/x.mtl')).toBe('../c/x.mtl');
  });
});

describe('export template model', () => {
  it('has the client folder tree as default: 11 top-level folders', () => {
    expect(templateFromSpec(DEFAULT_TEMPLATE_SPEC)).toEqual(DEFAULT_EXPORT_TEMPLATE);
    expect(DEFAULT_EXPORT_TEMPLATE.root.name).toBe('{project}-{code}-{seq}-{rev}');
    expect(DEFAULT_EXPORT_TEMPLATE.root.folders.map((f) => f.name)).toEqual(CLIENT_FOLDERS);
    const paths = walkFolders(DEFAULT_EXPORT_TEMPLATE)
      .filter((e) => e.depth > 1)
      .map((e) => e.path.join('/'));
    expect(paths).toEqual([
      '00-References/1-Material Submital',
      '00-References/2-Shop drawings',
      '00-References/3-Structural Calculation',
      '00-References/4-Emails',
      '00-References/5-Survey',
      '02-Single/CAD',
      '02-Single/PDF',
      '03-Assembly/CAD',
      '03-Assembly/PDF',
      '04-Erection/CAD',
      '04-Erection/PDF',
      '05-Reports/EXCEL',
      '05-Reports/PDF',
      '06-Exports/CAD',
      '06-Exports/CNC',
      '06-Exports/CNC/Plates',
      '06-Exports/CNC/Plates/DSTV',
      '06-Exports/CNC/Plates/DXF',
      '06-Exports/CNC/Profiles',
      '06-Exports/CNC/Profiles/DSTV',
      '06-Exports/CNC/Profiles/DXF',
      '06-Exports/IFC',
      '06-Exports/STP',
      '06-Exports/MIS',
    ]);
    const ids = templateItems(DEFAULT_EXPORT_TEMPLATE).map((x) => x.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(templateIssues(DEFAULT_EXPORT_TEMPLATE)).toEqual([]);
  });

  it('round-trips a template through JSON', () => {
    const t = addItem(DEFAULT_EXPORT_TEMPLATE, 'f-09-optimization', 'nc1-all').template;
    const back = parseTemplateJson(templateToJson(t), true);
    expect(back.warnings).toEqual([]);
    expect(back.template).toEqual(t);
    expect(parseTemplateJson(templateToJson(t)).template.id).not.toBe(t.id);
  });

  it('drops unknown outputs and reports broken files', () => {
    const raw = { schema: 'facadesteel.exportTemplate', version: 1, template: { name: 'Client', root: { name: '{project}', folders: [{ name: 'A', items: [{ output: 'drawing-pdf', pattern: '{drawingNo}.pdf', drawings: ['ga', 'bogus'] }, { output: 'teleport' }] }] } } };
    const { template, warnings } = parseTemplateJson(JSON.stringify(raw));
    expect(warnings[0]).toMatch(/teleport/);
    expect(template.root.folders[0].items).toEqual([{ id: 'drawing-pdf', output: 'drawing-pdf', pattern: '{drawingNo}.pdf', drawings: ['ga'] }]);
    expect(() => parseTemplateJson('{')).toThrow(/JSON/);
    expect(() => parseTemplateJson('{"name":"x"}')).toThrow(/folder tree/);
  });

  it('migrates project templates and package settings', () => {
    const p = createProject('Old');
    const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    delete raw.exportTemplates;
    expect(migrateProject(raw as unknown as Project)!.exportTemplates).toEqual([]);
    const mine = copyTemplate(DEFAULT_EXPORT_TEMPLATE, 'Client tree');
    const q = { ...JSON.parse(JSON.stringify(p)), exportTemplates: [mine, { broken: true }], activeExportTemplate: 'gone', exportPackage: { seq: 4 } } as Project;
    const m = migrateProject(q)!;
    expect(m.exportTemplates.map((t) => t.name)).toEqual(['Client tree']);
    expect(m.activeExportTemplate).toBeUndefined();
    expect(m.exportPackage).toEqual({ code: 'FWR', seq: 4 });
  });

  it('edits the tree: folders, moves, items', () => {
    let t = DEFAULT_EXPORT_TEMPLATE;
    const r = addFolder(t, 'f-03-assembly', 'Extra');
    t = r.template;
    expect(findFolder(t, 'f-03-assembly')!.folders.map((f) => f.name)).toEqual(['CAD', 'PDF', 'Extra']);
    expect(moveFolderTo(t, 'f-03-assembly', r.id)).toBe(t);
    t = moveFolderTo(t, r.id, 'root');
    expect(t.root.folders.at(-1)!.name).toBe('Extra');
    t = moveItemTo(t, 'ifc', r.id);
    expect(findFolder(t, r.id)!.items.map((i) => i.id)).toEqual(['ifc']);
    t = removeItem(t, 'ifc');
    expect(templateItems(t).some((x) => x.item.id === 'ifc')).toBe(false);
    expect(templateItems(DEFAULT_EXPORT_TEMPLATE).some((x) => x.item.id === 'ifc')).toBe(true);
  });

  it('warns about multi-file items without a per-file token', () => {
    const t = addItem(DEFAULT_EXPORT_TEMPLATE, 'root', 'nc1-all', 'All NC.{ext}').template;
    expect(templateIssues(t).some((i) => i.id === 'nc1-all' && /share this name/.test(i.text))).toBe(true);
  });
});

describe('export package of the sample facade (client tree)', () => {
  const p = fullProject();
  const dm = deriveModel(p);
  const drawings = allDrawings(p, dm);
  const plan = planFor(p);
  const paths = plan.files.map((f) => f.path);
  const pkg = 'FS-001-FWR-001-R00';
  const kinds = (k: string[]) => drawings.filter((d) => k.includes(d.kind));

  it('writes every applicable item at the client paths', () => {
    expect(plan.root).toBe(pkg);
    // Only the section / detail sheets (the sample has no GA cuts) and the aluminium extrusions (no composite members) are missing.
    expect(plan.items.filter((i) => i.skip).map((i) => `${i.item.id}: ${i.skip}`)).toEqual([
      'drawing-dxf-combined-4: no sheets of the chosen drawing types',
      'drawings-pdf-combined-6: no sheets of the chosen drawing types',
      'extrusions: no member carries aluminium or other non-steel components',
    ]);
    const used = new Set(templateItems(DEFAULT_EXPORT_TEMPLATE).map((x) => x.item.output));
    expect(OUTPUTS.filter((o) => !used.has(o.id)).map((o) => o.id).sort()).toEqual(['anchors-csv', 'bom-csv', 'nc1-all', 'nesting-csv', 'plates-csv', 'qc-checklist-pdf', 'qc-checklist-xlsx', 'register-csv', 'revision-log-csv']);
    const expected = [
      'FWR-001 Combined.pdf',
      '00-References/facadesteel-input.json',
      '00-References/profile-used.json',
      '00-References/Slab model.ifc',
      '00-References/5-Survey/Survey points.csv',
      '01-Setting Out/FWR-001 Master elevation.pdf',
      '01-Setting Out/MASTER ELEVATION.dxf',
      '01-Setting Out/MASTER ELEVATION BK.dxf',
      '01-Setting Out/FWR-001 Setting-out.xlsx',
      '01-Setting Out/FWR-001 Setting-out.csv',
      '02-Single/FWR-001 Part schedule.pdf',
      '02-Single/FWR-001 Single Parts (all).pdf',
      '02-Single/CAD/m1.dxf',
      '02-Single/PDF/pl1.pdf',
      '03-Assembly/FWR-001 Assemblies (all).pdf',
      '03-Assembly/CAD/M1.dxf',
      '03-Assembly/CAD/GENERAL PLAN.dxf',
      '03-Assembly/PDF/BK1.pdf',
      '03-Assembly/PDF/GENERAL PLAN.pdf',
      '04-Erection/Fixing schedule.csv',
      '04-Erection/README.txt',
      '04-Erection/CAD/FS-001-E-01.dxf',
      '04-Erection/PDF/FWR-001 Erection (all).pdf',
      '04-Erection/PDF/FS-001-ES-01.pdf',
      '04-Erection/PDF/FS-001-AS-01.pdf',
      '05-Reports/Run report.txt',
      '05-Reports/EXCEL/FWR-001 Cutting List.xlsx',
      '05-Reports/EXCEL/FWR-001 Drawing register.xlsx',
      '05-Reports/EXCEL/FWR-001 Revision log.xlsx',
      '05-Reports/EXCEL/FWR-001 Packing lists.xlsx',
      '05-Reports/EXCEL/FWR-001 Galvanizing list.xlsx',
      '05-Reports/EXCEL/FWR-001 Paint areas.xlsx',
      '05-Reports/PDF/FWR-001 Drawing register.pdf',
      '05-Reports/PDF/FWR-001 Packing list Truck 1.pdf',
      '05-Reports/PDF/FWR-001 Packing list Truck 2.pdf',
      '05-Reports/PDF/FWR-001 Part labels.pdf',
      '06-Exports/CAD/FWR-001 Flat patterns.dxf',
      '06-Exports/CNC/Plates/DSTV/FS-001-pl1.nc1',
      '06-Exports/CNC/Plates/DXF/pl1.dxf',
      '06-Exports/CNC/Profiles/DSTV/FS-001-m1.nc1',
      '06-Exports/IFC/FWR-001 Model.ifc',
      '06-Exports/STP/FWR-001 Model.stp',
      '06-Exports/MIS/FWR-001 MIS.json',
      '06-Exports/MIS/operations.csv',
      '07-Model/FWR-001 Model.json',
      '07-Model/FWR-001 Model.obj',
      '07-Model/FWR-001 Model.mtl',
      '07-Model/FWR-001 Model.stp',
      '08-Material List/FWR-001 Material list.csv',
      '08-Material List/FWR-001 Material list.xlsx',
      '09-Optimization/FWR-001 Bar cutting plan.csv',
      '09-Optimization/FWR-001 Bar cutting plan.pdf',
      '09-Optimization/FWR-001 Sheet nesting.pdf',
      '09-Optimization/FWR-001 Stock on hand.csv',
      '10-Quality Check List/QAF-FWR-001-R00.xlsx',
      '10-Quality Check List/VCF-FWR-001-R00.xlsx',
      '10-Quality Check List/FWR-001 Detailing checks.pdf',
      '10-Quality Check List/FWR-001 Wireframe confirmation.pdf',
      '10-Quality Check List/FWR-001 Clash report.pdf',
      '10-Quality Check List/FWR-001 Clashes.bcfzip',
    ];
    for (const e of expected) expect(paths).toContain(e);
    expect(paths.some((x) => /^06-Exports\/CNC\/Plates\/DXF\/NEST-001-S\d+x\d+\.dxf$/.test(x))).toBe(true);
    // Per-sheet files: parts and assemblies by mark, erection sheets by number.
    expect(paths.filter((x) => x.startsWith('02-Single/PDF/'))).toHaveLength(kinds(['part']).length);
    expect(paths.filter((x) => x.startsWith('03-Assembly/CAD/') && !/GENERAL|DETAILS/.test(x))).toHaveLength(kinds(['assembly']).length);
    expect(paths.filter((x) => x.startsWith('04-Erection/CAD/'))).toHaveLength(kinds(['setout', 'anchors', 'sequence']).length);
    // NC1 names "<project>-<mark>.nc1" for every unique part.
    expect(paths.filter((x) => x.endsWith('.nc1')).length).toBe(new Set(dm.parts.map((x) => x.mark)).size);
    expect(new Set(paths.map((x) => x.toLowerCase())).size).toBe(paths.length);
    for (const x of paths) for (const seg of x.split('/')) expect(sanitizeSegment(seg)).toBe(seg);
    expect(plan.warnings).toEqual([]);
    expect(plan.folders).toContain('06-Exports/CNC/Profiles/DXF');
  });

  it('uses the package fields and the drawing groups of an item', () => {
    const t = addItem(DEFAULT_EXPORT_TEMPLATE, 'root', 'drawing-pdf', 'Assemblies/{assembly}/{drawingNo}.{ext}');
    const t2 = { ...t.template, root: { ...t.template.root, items: t.template.root.items.map((i) => (i.id === t.id ? { ...i, drawings: ['assembly' as const] } : i)) } };
    const q = planFor(p, t2, { code: 'MTO', seq: 7, rev: 'R03' });
    expect(q.root).toBe('FS-001-MTO-007-R03');
    expect(q.files.some((f) => f.path === '10-Quality Check List/QAF-MTO-007-R03.xlsx')).toBe(true);
    const asm = q.items.find((i) => i.item.id === t.id)!;
    expect(asm.files.length).toBe(kinds(['assembly']).length);
    expect(asm.files[0].path).toMatch(/^Assemblies\/[A-Z]+\d+\/FS-001-A-[A-Z]+\d+\.pdf$/);
  });

  it('notes skipped items and warns about long paths', () => {
    const bare = sampleProject();
    const q = planFor(bare, addItem(DEFAULT_EXPORT_TEMPLATE, 'f-10-quality-check-list', 'drawing-pdf', `${'x'.repeat(230)}{drawingNo}.{ext}`).template);
    const skip = Object.fromEntries(q.items.filter((i) => i.skip).map((i) => [i.item.id, i.skip]));
    expect(Object.keys(skip).sort()).toEqual(
      ['bcf', 'clashes-csv', 'clashes-pdf', 'drawing-dxf-combined-4', 'drawings-pdf-combined-6', 'extrusions', 'paint-xlsx', 'references', 'revision-log-xlsx', 'setting-out-csv', 'setting-out-xlsx', 'stock-csv', 'survey-csv', 'wireframe-pdf', 'wireframe-txt'].sort(),
    );
    expect(skip['setting-out-csv']).toMatch(/survey/);
    expect(q.warnings.some((w) => /longer than 240/.test(w))).toBe(true);
  });

  it('builds the package: combined PDFs = their sheets, manifest of every file, ZIP tree', async () => {
    const res = await buildPackage(plan, { painter: stubPainter, blob: blobs });
    expect(res.errors).toEqual([]);
    expect(res.cancelled).toBe(false);
    const byPath = new Map(res.files.map((f) => [f.path, f.data!]));
    const at = (x: string) => byPath.get(`${pkg}/${x}`)!;
    // Root combined: every sheet in register order, bookmarked.
    const all = at('FWR-001 Combined.pdf');
    expect(pdfPageCount(all)).toBe(drawings.length);
    const titles = pdfOutlineTitles(all);
    for (const d of drawings) expect(titles).toContain(`${d.number}  ${d.title}`.replace(/[–—]/g, '-'));
    expect(titles).toContain('Assembly drawings');
    expect(dec(all)).toContain('/PageMode /UseOutlines');
    // Folder combined PDFs = the sum of their per-sheet PDFs.
    for (const [combined, folder] of [
      ['02-Single/FWR-001 Single Parts (all).pdf', '02-Single/PDF/'],
      ['03-Assembly/FWR-001 Assemblies (all).pdf', '03-Assembly/PDF/'],
      ['04-Erection/PDF/FWR-001 Erection (all).pdf', '04-Erection/PDF/'],
    ]) {
      const sheets = plan.files.filter((f) => f.path.startsWith(folder) && f.item.output === 'drawing-pdf').map((f) => at(f.path));
      expect(sheets.length).toBeGreaterThan(0);
      expect(pdfPageCount(at(combined))).toBe(sheets.reduce((s, b) => s + pdfPageCount(b), 0));
    }
    expect(pdfPageCount(at('01-Setting Out/FWR-001 Master elevation.pdf'))).toBe(kinds(['setout']).length + drawings.filter((d) => d.kind === 'ga' && !/plan/.test(d.id)).length);
    // README.txt lists every file; the empty client folders are written.
    const manifest = dec(at(MANIFEST_NAME));
    for (const f of plan.files) expect(manifest).toContain(f.path);
    expect(manifest).toMatch(/Package: {3}code FWR, sequence 001, revision R00/);
    expect(manifest).toContain('- 00-References/1-Material Submital');
    expect(manifest).toContain('- 06-Exports/CNC/Profiles/DXF');
    // The run report comes after the other files and reports on them.
    const run = dec(at('05-Reports/Run report.txt'));
    expect(run).toMatch(/Wireframe: {4}[0-9a-f]{24}/);
    expect(run).toContain('QAF DECISIONS');
    expect(run).toMatch(/Row 36 NO/);
    // References from the browser storage, OBJ referencing its MTL, valid STEP, NC1.
    expect(dec(at('00-References/Slab model.ifc'))).toContain('reference');
    expect(dec(at('07-Model/FWR-001 Model.obj'))).toContain('mtllib FWR-001 Model.mtl');
    expect(checkStep(dec(at('06-Exports/STP/FWR-001 Model.stp')))).toEqual([]);
    expect(dec(at('06-Exports/CNC/Profiles/DSTV/FS-001-m1.nc1'))).toMatch(/^ST/);
    expect(dec(at('06-Exports/CAD/FWR-001 Flat patterns.dxf'))).toMatch(/pl1 {2}PL10 S355 {2}x\d+/);
    // ZIP: same tree, empty folders as folder entries.
    const bytes = Uint8Array.from(packageZipChunks(res).flatMap((c) => [...c]));
    const entries = unzipNames(bytes);
    expect(entries.map((e) => e.name).sort()).toEqual(res.files.map((f) => f.path).sort());
    expect(entries.every((e) => e.name.startsWith(`${pkg}/`))).toBe(true);
    expect(entries.some((e) => e.name === `${pkg}/00-References/4-Emails/`)).toBe(true);
    const tree = packageTree(plan.root, planPaths(plan), plan.folders);
    for (const f of CLIENT_FOLDERS) expect(tree).toMatch(new RegExp(`[├└]───${f}$`, 'm'));
  }, 120000);

  it('lists skipped and left-out items in README.txt; the folder writer gets every folder', async () => {
    const bare = sampleProject();
    const q = planFor(bare, DEFAULT_EXPORT_TEMPLATE, {}, ['ifc', 'step', 'step-2', 'obj']);
    expect(q.items.find((i) => i.item.id === 'ifc')!.off).toBe(true);
    const dirs: string[] = [];
    const res = await buildPackage(q, { painter: stubPainter, write: async () => {}, mkdir: async (d) => void dirs.push(d) });
    expect(res.files.every((f) => !f.data)).toBe(true);
    for (const d of ['00-References/1-Material Submital', '00-References/5-Survey', '06-Exports/IFC', '06-Exports/STP', '06-Exports/CNC/Profiles/DXF']) expect(dirs).toContain(`${q.root}/${d}`);
    const r2 = await buildPackage(q, { painter: stubPainter });
    const manifest = dec(r2.files.find((f) => f.path === `${q.root}/${MANIFEST_NAME}`)!.data!);
    expect(manifest).toContain('SKIPPED');
    expect(manifest).toMatch(/Setting-out table \(CSV\): no survey points are imported/);
    expect(manifest).toMatch(/IFC model \(IFC4\): left out in the export dialog/);
    expect(manifest).not.toContain('.ifc');
  }, 120000);

  it('keeps going when one file fails, and stops on cancel', async () => {
    const small = planFor(sampleProject(), templateFromSpec({ id: 't', name: 'Small', root: '{project}', folders: { PDF: [['drawing-pdf', '{drawingNo}.{ext}', ['assembly']]], Lists: [['bom-xlsx', 'Material.{ext}']] } }));
    let n = 0;
    const flaky: SvgPainter = async (doc) => {
      if (n++ === 1) throw new Error('renderer broke');
      doc.text('x', 10, 10);
    };
    const res = await buildPackage(small, { painter: flaky });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toBe('renderer broke');
    expect(res.entries).toHaveLength(small.files.length - 1);
    const manifest = dec(res.files.at(-1)!.data!);
    expect(manifest).toContain('ERRORS');
    expect(manifest).toContain(res.errors[0].path);
    const ac = new AbortController();
    const cut = await buildPackage(small, { painter: stubPainter, signal: ac.signal, onProgress: (pr) => pr.done === 2 && ac.abort() });
    expect(cut.cancelled).toBe(true);
    expect(cut.entries).toHaveLength(2);
    expect(dec(cut.files.at(-1)!.data!)).toContain('CANCELLED');
  }, 60000);
});

describe('OBJ and STEP models', () => {
  const p = sampleProject();
  const dm = deriveModel(p);
  const meshes = partMeshes(p, dm);

  it('makes one closed mesh per part', () => {
    expect(meshes.length).toBe(dm.parts.length);
    for (const m of meshes.slice(0, 24)) {
      // Closed (watertight) shell: every edge is used once in each direction.
      const edges = new Map<string, number>();
      for (let i = 0; i < m.indices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const key = `${m.indices[i + k]},${m.indices[i + ((k + 1) % 3)]}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      const open = [...edges.keys()].filter((k) => {
        const [a, b] = k.split(',');
        return edges.get(`${b},${a}`) !== edges.get(k);
      });
      expect(open, `${m.mark} has open edges`).toEqual([]);
    }
  });

  it('writes OBJ + MTL grouped by assembly with materials by role', () => {
    const { obj, mtl } = meshesToObj(meshes, { mtlFile: 'Model.mtl' });
    expect(obj).toContain('mtllib Model.mtl');
    const v = obj.match(/^v /gm)!.length;
    expect(v).toBe(meshes.reduce((s, m) => s + m.positions.length / 3, 0));
    expect(obj.match(/^f /gm)!.length).toBe(meshes.reduce((s, m) => s + m.indices.length / 3, 0));
    expect(obj.match(/^o /gm)!.length).toBe(meshes.length);
    expect(obj.match(/^g /gm)!.length).toBeGreaterThanOrEqual(new Set(dm.assemblies.map((a) => a.id)).size);
    for (const m of obj.matchAll(/^usemtl (\S+)$/gm)) expect(mtl).toContain(`newmtl ${m[1]}`);
    const maxIndex = Math.max(...[...obj.matchAll(/^f (\d+) (\d+) (\d+)$/gm)].flatMap((x) => [Number(x[1]), Number(x[2]), Number(x[3])]));
    expect(maxIndex).toBe(v);
  });

  it('writes STEP AP214 with one faceted solid per part in millimetres', () => {
    const six = meshes.slice(0, 6);
    const stp = meshesToStep(six, { name: 'FWR-001 Model', time: '2026-11-01T00:00:00' });
    expect(checkStep(stp)).toEqual([]);
    expect(stp).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
    expect(stp).toContain('SI_UNIT(.MILLI.,.METRE.)');
    expect(stp.match(/=FACETED_BREP\(/g)).toHaveLength(6);
    expect(stp.match(/=PRODUCT\(/g)).toHaveLength(6);
    expect(stp.match(/=CLOSED_SHELL\(/g)).toHaveLength(6);
    expect(stp).toContain(`'${six[0].mark} (${six[0].assembly})'`);
    expect(stp.match(/=FACE_SURFACE\(/g)!.length).toBe(six.reduce((s, m) => s + m.indices.length / 3, 0));
    expect(checkStep(stp.replace('#1=', '#99999='))).not.toEqual([]);
  });

  it('writes the same STEP in slices that yield to the page, and stops when told to', async () => {
    const six = meshes.slice(0, 6);
    const o = { name: 'FWR-001 Model', time: '2026-11-01T00:00:00' };
    let pauses = 0;
    const text = await meshesToStepAsync(six, o, async () => void pauses++, -1);
    expect(text).toBe(meshesToStep(six, o));
    expect(pauses).toBeGreaterThanOrEqual(5);
    await expect(meshesToStepAsync(six, o, async () => false, -1)).rejects.toThrow(/cancelled/);
  });

  it('makes the STEP model once for the two folders that carry it', async () => {
    const p = sampleProject();
    const plan = planFor(p);
    const steps = plan.files.filter((f) => f.path.endsWith('.stp'));
    expect(steps.map((f) => f.path.split('/')[0])).toEqual(['06-Exports', '07-Model']);
    expect(steps[0].source).toBe(steps[1].source);
    const only = { ...plan, files: steps };
    const res = await buildPackage(only, { painter: stubPainter });
    const files = res.files.filter((f) => f.path.endsWith('.stp'));
    expect(files).toHaveLength(2);
    expect(dec(files[0].data!)).toBe(dec(files[1].data!));
    expect(checkStep(dec(files[0].data!))).toEqual([]);
  }, 120000);
});

describe('QA forms', () => {
  const p = sampleProject();
  const plan = planFor(p);

  it('evaluates the QAF on the sample project', () => {
    const d = Object.fromEntries(qafDecisions(plan).map((x) => [x.item.key, x.answer]));
    expect(d).toMatchObject({
      drafting: null,
      font: null,
      projectIds: 'yes',
      quantities: 'yes',
      shopRef: 'no',
      dates: 'no',
      dimsMatch: 'yes',
      fabDrawings: 'yes',
      optimization: 'yes',
      fastFactory: 'na',
      fastSite: 'yes',
      finishType: 'yes',
      panelDxf: 'na',
      ncFiles: 'yes',
      glassEdge: 'na',
      folding: 'na',
      powder: 'na',
      anodize: 'na',
      extraLength: 'no',
      blade: 'no',
    });
    const q = { ...p, settings: { ...p.settings, kerf: 5, endTrim: 50 } };
    const d2 = Object.fromEntries(qafDecisions(planFor(q)).map((x) => [x.item.key, x.answer]));
    expect([d2.blade, d2.extraLength]).toEqual(['yes', 'yes']);
    const d3 = Object.fromEntries(qafDecisions(planFor(p, DEFAULT_EXPORT_TEMPLATE, {}, ['nc1-plates', 'nc1-members'])).map((x) => [x.item.key, x.answer]));
    expect(d3.ncFiles).toBe('no');
  });

  it('builds the QAF with the form layout and a sheet of decisions', async () => {
    const bytes = qafWorkbook(qafDecisions(plan), { name: 'QA', date: DATE });
    const z = readZip(bytes);
    const sheet = await entryText(z.find((e) => e.name === 'xl/worksheets/sheet1.xml')!);
    for (const m of ['B2:F2', 'D4:F4', 'B5:C5', 'B10:C10', 'B19:C19', 'B38:F38', 'C41:F41']) expect(sheet).toContain(`<mergeCell ref="${m}"/>`);
    expect(sheet).toContain('<col min="3" max="3" width="85.6" customWidth="1"/>');
    expect(sheet).toContain('<col min="16" max="16" width="0" customWidth="1" hidden="1"/>');
    const { cells, sheets } = await readXlsxCells(bytes, ['B2', 'B4', 'C4', 'D4', 'D5', 'E5', 'F5', 'B5', 'B10', 'B19', 'C8', 'P13', 'P14', 'P15', 'D11', 'E36', 'B38', 'C40'], 'FWR-GCL-MTO');
    expect(sheets).toEqual(['FWR-GCL-MTO', 'FacadeSteel checks']);
    expect(cells).toMatchObject({
      B2: 'Basic Check List For Material & Fabrication Submittals',
      B4: 'Type',
      C4: 'Item to check',
      D4: 'Compliance',
      B5: '*General notes',
      D5: 'Yes',
      E5: 'No',
      F5: 'N/A',
      B10: '*To Attach on the Cover',
      B19: '*Content',
      C8: 'Size of text must be readable – 2.5 mm',
      P13: 'Complied',
      P14: 'Not Complied',
      P15: 'N/A',
      D11: '✓',
      E36: '✓',
      B38: 'Checked By:',
      C40: '01-Nov-2026',
    });
    expect(QAF_ITEMS).toHaveLength(29);
    const checks = await readXlsxCells(bytes, ['A1', 'E2'], 'FacadeSteel checks');
    expect(checks.cells.A1).toBe('Row');
    expect(checks.cells.E2).toMatch(/Manual/);
  });

  it('builds the VCF with lists, widths and one row per revision', async () => {
    const rows = vcfRows([{ rev: 'R00', date: '2026-10-01T00:00:00Z', summary: 'Initial issue', issuedBy: 'ACME' }], { rev: 'R01', date: '2026-11-01T00:00:00Z', summary: 'Changes since R00', issuedBy: 'ACME' });
    expect(rows.map((r) => [r.revision, r.version, r.status])).toEqual([
      ['R00', 'V1', 'Superseded'],
      ['R01', 'V2', 'Last Update'],
    ]);
    // Re-exporting a revision replaces its row.
    expect(vcfRows([{ rev: 'R00', date: 'x', summary: 'old' }], { rev: 'R00', date: 'y', summary: 'new' }).map((r) => r.modifications)).toEqual(['new']);
    const bytes = vcfWorkbook(rows, { projectName: 'Block A', submittalType: 'Fabrication Work Release (FWR)', ref: 'FWR-001', date: DATE });
    const sheet = await entryText(readZip(bytes).find((e) => e.name === 'xl/worksheets/sheet1.xml')!);
    for (const m of ['C2:I3', 'C5:D5', 'E5:J5', 'E6:J6', 'E7:J7', 'E8:J8', 'I10:J10', 'I11:J11']) expect(sheet).toContain(`<mergeCell ref="${m}"/>`);
    expect(sheet).toContain('<formula1>$V$3:$W$3</formula1>');
    expect(sheet).toContain('sqref="G11:G13"><formula1>$V$1:$Y$1</formula1>');
    expect(sheet).toContain('sqref="E11:E13"><formula1>$V$2:$W$2</formula1>');
    expect(sheet).toContain('<col min="7" max="7" width="31.7" customWidth="1"/>');
    const { cells } = await readXlsxCells(bytes, ['C2', 'C5', 'E5', 'E6', 'E7', 'E8', 'C10', 'I10', 'C11', 'E11', 'G11', 'H11', 'C12', 'E12', 'V1', 'Y1', 'V2', 'W2', 'V3', 'W3']);
    expect(cells).toMatchObject({
      C2: 'Versions Control Form For Technical Submittals\n(Changes Summery)',
      C5: 'Project Name',
      E5: 'Block A',
      E6: 'Fabrication Work Release (FWR)',
      E7: 'FWR-001',
      E8: '01-Nov-2026',
      C10: 'Revision',
      I10: 'Modifications',
      C11: 'R00',
      E11: 'Superseded',
      G11: 'Fabrication',
      H11: 'FacadeSteel 0.1.0',
      C12: 'R01',
      E12: 'Last Update',
      V1: 'Technical Comment',
      Y1: 'Complete Missing Items / Additional',
      V2: 'Last Update',
      W2: 'Superseded',
      V3: 'Fabrication',
      W3: 'Material Takeoff',
    });
  });

  it('fills a user workbook: only the sheet changes, every other part stays byte-identical', async () => {
    // Synthetic template: our QAF with its XML parts deflated and a binary "logo" added.
    const base = readZip(qafWorkbook([], { name: '', date: DATE }));
    const logo = new Uint8Array(256).map((_, i) => (i * 37) & 255);
    const replace = new Map<string, { data: Uint8Array; deflated: Uint8Array | null }>();
    for (const e of base) if (e.name.endsWith('.xml')) replace.set(e.name, { data: e.raw, deflated: await deflateRaw(e.raw) });
    replace.set('xl/media/image1.png', { data: logo, deflated: null });
    const tpl = rewriteZip([...base, { ...base[0], name: 'xl/media/image1.png' }], replace);
    const filled = await fillXlsxTemplate(tpl, qafCells(qafDecisions(plan), defaultQafMapping(), { name: 'QA Eng', date: DATE }), 'FWR-GCL-MTO');
    const a = readZip(tpl);
    const b = readZip(filled);
    expect(a.some((e) => e.method === 8)).toBe(true);
    expect(b.map((e) => e.name)).toEqual(a.map((e) => e.name));
    for (const [i, e] of b.entries()) {
      if (e.name === 'xl/worksheets/sheet1.xml') continue;
      expect([e.method, e.crc, e.size, e.compSize], e.name).toEqual([a[i].method, a[i].crc, a[i].size, a[i].compSize]);
      expect(Buffer.from(e.raw).equals(Buffer.from(a[i].raw)), e.name).toBe(true);
    }
    const { cells } = await readXlsxCells(filled, ['C39', 'C40', 'D11', 'E11', 'F23', 'D6', 'C11'], 'FWR-GCL-MTO');
    expect(cells).toMatchObject({ C39: 'QA Eng', C40: '01-Nov-2026', D11: '✓', F23: '✓', C11: 'Project Name & Number & Document Number' });
    expect(cells.E11 ?? '').toBe('');
    expect(cells.D6 ?? '').toBe('');
  });

  it('patches sheet XML: keeps styles, inserts cells and rows in order', () => {
    const xml = '<worksheet><sheetData><row r="2"><c r="B2" s="7" t="s"><v>3</v></c><c r="D2" s="9"/></row><row r="5"/></sheetData></worksheet>';
    const out = patchSheetXml(xml, { D2: 'x', C2: 'y', E2: 4, A5: 'z', B3: 'new row', B2: null });
    expect(out).toBe(
      '<worksheet><sheetData><row r="2"><c r="B2" s="7"/><c r="C2" t="inlineStr"><is><t xml:space="preserve">y</t></is></c><c r="D2" s="9" t="inlineStr"><is><t xml:space="preserve">x</t></is></c><c r="E2"><v>4</v></c></row><row r="3"><c r="B3" t="inlineStr"><is><t xml:space="preserve">new row</t></is></c></row><row r="5"><c r="A5" t="inlineStr"><is><t xml:space="preserve">z</t></is></c></row></sheetData></worksheet>',
    );
  });
});

describe('export package assistant tools', () => {
  const saved: { filename: string; data: unknown }[] = [];
  beforeAll(() => {
    setPackagePainter(stubPainter);
    (globalThis as { window?: unknown }).window = {
      claude: { use: async (n: string) => (n === 'downloads' ? { save: async (r: { filename: string; data: unknown }) => (saved.push(r), { status: 'saved' }) } : null) },
    };
  });
  afterAll(() => {
    setPackagePainter(null);
    delete (globalThis as { window?: unknown }).window;
  });
  beforeEach(() => useStore.getState().replaceProject(sampleProject()));

  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
    return JSON.parse(await runTool(name, input));
  };
  const nextZip = async (n: number) => {
    for (let k = 0; k < 200 && saved.length < n; k++) await new Promise((r) => setTimeout(r, 5));
    return new Uint8Array(await (saved[n - 1].data as Blob).arrayBuffer());
  };

  it('registers tools within the size limits', () => {
    for (const t of exportPackageModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(4096);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
    }
  });

  it('lists, sets fields, exports the ZIP and appends VCF revision rows', async () => {
    const i = await run('export_package_info', { tree: true, limit: 400 });
    expect(i.package).toBe('FS-001-FWR-001-R00');
    expect(i.tree.split('\n')[0]).toBe('FS-001-FWR-001-R00');
    expect(i.folders.find((f: { folder: string }) => f.folder === '00-References/5-Survey').items[0].skipped).toMatch(/survey/);
    const s = await run('set_export_package', { code: 'FWR', seq: 1, rev: 'R00', exclude: ['drawing-dxf', 'nope'] });
    expect(s.notes[0]).toMatch(/nope/);
    const out = await run('export_package', {});
    expect(out.downloaded).toBe('FS-001-FWR-001-R00.zip');
    expect(out.errors).toEqual([]);
    expect(out.leftOut).toEqual(['drawing-dxf', 'drawing-dxf-2', 'drawing-dxf-3']);
    const names = unzipNames(await nextZip(1)).map((e) => e.name);
    expect(names).toContain('FS-001-FWR-001-R00/README.txt');
    expect(names).toContain('FS-001-FWR-001-R00/02-Single/CAD/');
    expect(useStore.getState().project.exportPackage!.history!.map((h) => h.rev)).toEqual(['R00']);
    // Next revision: the VCF gets a second row.
    await run('set_export_package', { rev: 'R01' });
    await run('export_package', {});
    expect(useStore.getState().project.exportPackage!.history!.map((h) => h.rev)).toEqual(['R00', 'R01']);
    const second = unzipNames(await nextZip(2));
    const vcf = second.find((e) => e.name.endsWith('VCF-FWR-001-R01.xlsx'))!;
    const { cells } = await readXlsxCells(vcf.data, ['C11', 'E11', 'C12', 'E12', 'D12']);
    expect(cells).toMatchObject({ C11: 'R00', E11: 'Superseded', C12: 'R01', E12: 'Last Update', D12: 'V2' });
    // A template imported as JSON becomes the active one.
    const tpl = templateFromSpec({ id: 'client', name: 'Client tree', root: '{project}-{code}-{seq}-{rev}', folders: { Drawings: [['drawings-pdf-combined', '{package}.{ext}']] } });
    const s2 = await run('set_export_package', { rev: '', templateJson: templateToJson(tpl) });
    expect(s2.template.name).toBe('Client tree');
    expect(s2.fields.rev).toBe('R00');
    expect(s2.totals.files).toBe(2);
  }, 120000);
});
