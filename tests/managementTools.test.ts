import { beforeEach, describe, expect, it } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { managementModule } from '../src/assistant/modules/management';
import { derived, useStore } from '../src/state/store';
import { provideIfcApi } from '../src/state/runtime';
import { createProject } from '../src/core/model/ops';
import { exportIfc } from '../src/core/io/ifcExport';
import { sampleFacade } from './helpers';

const run = async (name: string, input: Record<string, unknown>) => {
  const tool = TOOLS.find((t) => t.name === name)!;
  expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
  return JSON.parse(await runTool(name, input));
};

describe('model management assistant tools', () => {
  beforeEach(() => useStore.getState().replaceProject(sampleFacade()));

  it('registers tools within the size limits', () => {
    for (const t of managementModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(4096);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
      expect(managementModule.run[t.name]).toBeTypeOf('function');
    }
  });

  it('creates phases / batches and assigns them by filter', async () => {
    await run('manage_phases_batches', { action: 'add_phase', name: 'Ground floor' });
    await run('manage_phases_batches', { action: 'add_phase', name: 'First floor', color: '#ff8800' });
    const b = await run('manage_phases_batches', { action: 'add_batch', name: 'Truck 1', date: '2026-11-03', phase: 'Ground floor' });
    expect(b.phases.map((x: { name: string }) => x.name)).toEqual(['Ground floor', 'First floor']);
    expect(b.batches[0]).toMatchObject({ name: 'Truck 1', date: '2026-11-03' });
    const r = await run('assign_phase_zone_batch', { members: { role: 'mullion' }, phase: 'First floor', batch: 'Truck 1', zone: 'East', colorBy: 'phase', selectionFilter: { phase: 'First floor' } });
    expect(r.changed).toBe(r.matched);
    expect(r.phases[1].members).toBe(r.matched);
    expect(useStore.getState().display.colorBy).toBe('phase');
    expect(useStore.getState().selectFilter?.phase).toBe(r.phases[1].id);
    const dm = derived(useStore.getState().project);
    expect(dm.assemblies.filter((a) => a.phase === r.phases[1].id).length).toBeGreaterThan(0);
    await run('manage_phases_batches', { action: 'move_phase', id: 'First floor', delta: -1 });
    const l = await run('manage_phases_batches', { action: 'list' });
    expect(l.phases[0].name).toBe('First floor');
    // Clearing with "".
    const c = await run('assign_phase_zone_batch', { members: { all: true }, zone: '', clearSelectionFilter: true });
    expect(c.zones).toEqual([]);
    expect(useStore.getState().selectFilter).toBeNull();
    await expect(runTool('assign_phase_zone_batch', { members: { all: true }, phase: 'Nope' })).rejects.toThrow(/No phase/);
  });

  it('locks marks and sets manual marks', async () => {
    const s0 = await run('assembly_marks', { action: 'status' });
    expect(s0.locked).toBe(false);
    const s1 = await run('assembly_marks', { action: 'lock' });
    expect(s1.locked).toBe(true);
    expect(s1.counts.locked).toBeGreaterThan(0);
    const id = Object.values(useStore.getState().project.members).find((m) => m.role === 'mullion')!.id;
    const s2 = await run('assembly_marks', { action: 'override', members: { ids: [id] }, mark: 'M-SPECIAL' });
    expect(s2.members[0]).toMatchObject({ id, mark: 'M-SPECIAL', manual: 'M-SPECIAL' });
    expect(s2.counts.manual).toBe(1);
    const s3 = await run('assembly_marks', { action: 'unlock' });
    expect(s3.locked).toBe(false);
  });

  it('runs clash detection and updates issues', async () => {
    const r = await run('clash_detection', { action: 'run', clearance: 15 });
    expect(r.clearance).toBe(15);
    expect(r.summary.total).toBe(0); // the sample has no steel clashes and no reference model
    // Add a crossing member to create a steel clash.
    useStore.getState().apply('test', (d) => {
      const n1 = 'tn1';
      const n2 = 'tn2';
      d.nodes[n1] = { id: n1, p: { x: 700, y: 0, z: -300 } };
      d.nodes[n2] = { id: n2, p: { x: 700, y: 0, z: 6000 } };
      d.members.tm = { ...Object.values(d.members)[0], id: 'tm', start: n1, end: n2, phase: undefined };
    });
    const r2 = await run('clash_detection', { action: 'run' });
    expect(r2.summary.open).toBeGreaterThan(0);
    const first = r2.issues[0];
    const r3 = await run('clash_detection', { action: 'set_status', ids: [first.id], status: 'ignored', comment: 'by design' });
    expect(r3.issues.find((x: { id: string }) => x.id === first.id)).toMatchObject({ status: 'ignored', comment: 'by design' });
    const r4 = await run('clash_detection', { action: 'run' });
    expect(r4.issues.find((x: { id: string }) => x.id === first.id).status).toBe('ignored');
  });

  it('generates a sub-frame from DXF panel text', async () => {
    useStore.getState().replaceProject(createProject('Panels'));
    const rect = (x0: number, y0: number, x1: number, y1: number) => ['0', 'LWPOLYLINE', '8', 'P', '90', '4', '70', '1', '10', x0, '20', y0, '10', x1, '20', y0, '10', x1, '20', y1, '10', x0, '20', y1].join('\n');
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', rect(0, 0, 1490, 1690), rect(1510, 0, 2990, 1690), rect(0, 1710, 1490, 3400), rect(1510, 1710, 2990, 3400), '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const pv = await run('import_panel_layout', { dxf, plane: 'XZ', offset: 0, preview: true });
    expect(pv.preview).toMatchObject({ panels: 4, vertical: 3, horizontal: 3 });
    const r = await run('import_panel_layout', { dxf, plane: 'XZ', offset: 0, cavity: 100 });
    expect(r.byRole.mullion).toBe(3);
    expect(r.byRole.transom).toBe(6);
    expect(Object.keys(useStore.getState().project.members)).toHaveLength(9);
  });

  it('summarises and imports IFC steel', async () => {
    const api = new IfcAPI();
    await api.Init();
    provideIfcApi(async () => api);
    const src = sampleFacade();
    const ifcText = exportIfc(src, derived(src));
    useStore.getState().replaceProject(createProject('IFC'));
    const s = await run('ifc_steel_import', { ifcText, skipConnectionParts: true });
    expect(s.members).toBe(Object.values(src.members).filter((m) => m.profile).length);
    expect(s.imported).toBeUndefined();
    const a = await run('ifc_steel_import', { ifcText, skipConnectionParts: true, apply: true });
    expect(a.imported.members).toBe(s.members);
    expect(Object.keys(useStore.getState().project.members)).toHaveLength(s.members);
    await expect(runTool('ifc_steel_import', {})).rejects.toThrow(/No IFC reference/);
  });
});
