import { beforeEach, describe, expect, it } from 'vitest';
import { runTool, TOOLS } from '../src/assistant/tools';
import { drawingsModule } from '../src/assistant/modules/drawings';
import { useStore } from '../src/state/store';
import { sampleFacade } from './helpers';

const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runTool(name, input));
const st = () => useStore.getState();

describe('assistant drawing tools', () => {
  beforeEach(() => st().replaceProject(sampleFacade()));

  it('registers small, well-described tools', () => {
    for (const t of drawingsModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length, t.name).toBeLessThanOrEqual(4096);
      expect(t.description!.length, t.name).toBeLessThanOrEqual(1024);
      expect(drawingsModule.run[t.name], t.name).toBeTypeOf('function');
    }
  });

  it('adds notes and clouds, moves views, and every edit is undoable', async () => {
    const items = await run('drawing_markup', { drawing: 'part-m1', action: 'list_items' });
    expect(items.items.some((i: { key: string }) => i.key === 'view:elevation')).toBe(true);
    await run('drawing_markup', { drawing: 'part-m1', action: 'add_note', text: 'Check length on site', x: 60, y: 260, leaderX: 120, leaderY: 200 });
    await run('drawing_markup', { drawing: 'part-m1', action: 'add_cloud', rect: [100, 100, 150, 140], rev: 'B' });
    await run('drawing_markup', { drawing: 'part-m1', action: 'move', item: 'view:plan', dx: 5, dy: -3 });
    const e = st().project.drawings.edits['part-m1'];
    expect(e.notes).toHaveLength(1);
    expect(e.clouds[0].rev).toBe('B');
    expect(e.views['view:plan']).toEqual({ x: 5, y: -3 });
    const list = await run('drawings', { action: 'list' });
    expect(list.find((d: { number: string }) => d.number.endsWith('-P-m1'))).toBeDefined();
    st().undo();
    st().undo();
    st().undo();
    expect(st().project.drawings.edits['part-m1']).toBeUndefined();
    await expect(runTool('drawing_markup', { drawing: 'nope', action: 'list_items' })).rejects.toThrow(/No drawing/);
  });

  it('adds section cuts and details, lists erection drawings and anchor rows', async () => {
    const sec = await run('ga_cuts', { action: 'add', kind: 'section', a: [-100, 0, 1800], b: [4600, 0, 1800], depth: 500 });
    expect(sec.name).toBe('A');
    expect(sec.sheet).toMatch(/-SD-01$/);
    const det = await run('ga_cuts', { action: 'add', kind: 'detail', a: [1500, 0, 3400], radius: 250, scale: 5 });
    expect(det.depth).toBe(250);
    expect((await run('ga_cuts', { action: 'list' })).length).toBe(2);
    await run('ga_cuts', { action: 'update', id: sec.id, flip: true });
    expect(st().project.drawings.cuts[0].flip).toBe(true);
    const er = await run('erection_drawings', { action: 'list' });
    expect(er.sheets.some((d: { kind: string }) => d.kind === 'setout')).toBe(true);
    expect(er.sheets.some((d: { kind: string }) => d.kind === 'anchors')).toBe(true);
    const rows = await run('erection_drawings', { action: 'anchor_schedule', limit: 5 });
    expect(rows.rows).toHaveLength(5);
    expect(rows.total).toBeGreaterThan(5);
  });

  it('creates, edits and activates a sheet template', async () => {
    const t = await run('sheet_templates', { action: 'create', name: 'ACME', activate: true });
    expect(st().project.drawings.activeTemplate).toBe(t.id);
    await run('sheet_templates', { action: 'update', id: t.id, fields: [{ label: 'Company', source: 'text:ACME Ltd', col: 0, row: 0, w: 180, h: 40 }], notes: ['QP-7 applies.'] });
    const ga = (await run('drawings', { action: 'list' })) as { id: string }[];
    expect(ga.length).toBeGreaterThan(3);
    const list = await run('sheet_templates', { action: 'list' });
    expect(list.active).toBe(t.id);
    expect(list.templates.find((x: { id: string }) => x.id === t.id).fields).toHaveLength(1);
    await expect(runTool('sheet_templates', { action: 'update', id: 'iso7200', name: 'x' })).rejects.toThrow(/cannot be changed/);
    await run('sheet_templates', { action: 'set_active', id: 'iso7200' });
    expect(st().project.drawings.activeTemplate).toBeUndefined();
  });
});
