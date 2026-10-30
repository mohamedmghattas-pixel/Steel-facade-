import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { AssistantSession } from '../src/assistant/agent';
import { useStore } from '../src/state/store';
import { createProject } from '../src/core/model/ops';
import { getProfile } from '../src/core/library/profiles';

const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runTool(name, input));

describe('assistant tools', () => {
  beforeEach(() => useStore.getState().replaceProject(createProject('Chat test')));

  it('every tool has a valid object schema', () => {
    for (const t of TOOLS) {
      expect(t.input_schema.type).toBe('object');
      expect(t.description!.length).toBeGreaterThan(20);
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it('builds and details a facade from tool calls', async () => {
    const grid = await run('create_facade_grid', {
      plane: 'XZ',
      bays: [1500, 1500],
      rows: [1100, 2400, 1100, 2400],
      floorLines: [0, 2, 4],
      mullionProfile: 'SHS 100x100x5',
      transomProfile: 'RHS 100x50x4',
    });
    expect(grid.created).toBeGreaterThan(0);
    const sum = await run('get_model_summary', {});
    expect(sum.byRole.mullion.count).toBe(6);
    const conn = await run('auto_connect', {});
    expect(conn.created).toBeGreaterThan(0);
    const changed = await run('set_member_properties', { filter: { role: 'transom' }, profile: 'RHS 120x60x4', finish: 'paint' });
    expect(changed.updated).toBeGreaterThan(0);
    const params = await run('set_connection_params', { type: 'slabBracket', params: { finT: 12 } });
    expect(params.updated).toBeGreaterThan(0);
    expect(params.unknownKeys).toEqual([]);
    const reports = await run('get_reports', {});
    expect(reports.totals.weight).toBeGreaterThan(100);
    const checks = await run('run_checks', {});
    expect(checks.totals).toBeDefined();
    const dwgs = await run('drawings', { action: 'list' });
    expect(dwgs.length).toBeGreaterThan(3);
    // Every change is undoable.
    await run('history', { action: 'undo', steps: 1 });
    expect(Object.values(useStore.getState().project.connections).every((c) => c.params.finT !== 12)).toBe(true);
  });

  it('creates a custom template and applies it to selected members', async () => {
    await run('add_lines', { lines: [{ a: [0, 0, 0], b: [0, 0, 3000] }], profile: 'SHS 100x100x5', role: 'post' });
    await run('add_lines', { lines: [{ a: [0, 0, 1500], b: [1000, 0, 1500] }], profile: 'RHS 80x40x3', role: 'rail' });
    const tpl = await run('save_custom_template', {
      name: 'Simple end plate',
      needsMain: true,
      params: [{ key: 'tp', default: 10 }],
      cut: 'tp',
      plates: [
        {
          key: 'ep',
          name: 'End plate',
          plane: 'end',
          t: 'tp',
          width: 'b_sec + 80',
          height: 'h_sec + 40',
          u: '0',
          v: '0',
          w: '0',
          weldTo: 'secondary',
          bolts: { size: 'M12', rows: '1', cols: '2', pitch: '0', gauge: 'b_sec + 40', through: 'main' },
        },
      ],
    });
    await run('select', { filter: { role: 'rail' } });
    const applied = await run('apply_connection', { type: 'custom', filter: { selected: true }, params: { template: tpl.id } });
    expect(applied.created).toBe(1);
    expect(applied.warnings).toEqual([]);
  });

  it('adds custom profiles that members can use, and undo removes them', async () => {
    const r = await run('add_custom_profiles', { profiles: [{ name: 'Rail 120x60x4 custom', shape: { type: 'RHS', h: 120, b: 60, t: 4, ro: 8 } }] });
    expect(r.added[0].kgPerM).toBeGreaterThan(9);
    const lines = await run('add_lines', { lines: [{ a: [0, 0, 0], b: [2000, 0, 0] }], profile: 'Rail 120x60x4 custom', role: 'rail' });
    expect(lines.created).toBe(1);
    await run('history', { action: 'undo', steps: 2 });
    expect(getProfile('Rail 120x60x4 custom')).toBeUndefined();
  });

  it('rejects unknown profiles with a helpful error', async () => {
    await expect(runTool('add_lines', { lines: [{ a: [0, 0, 0], b: [1, 0, 0] }], profile: 'NOPE 1' })).rejects.toThrow(/search_profiles|Unknown profile/);
  });

  it('validates tool inputs against the schema', () => {
    const t = TOOLS.find((x) => x.name === 'add_lines')!;
    expect(validate(t.input_schema as never, { lines: [{ a: [0, 0, 0], b: [1, 2, 3] }] })).toBeNull();
    expect(validate(t.input_schema as never, { lines: [{ a: [0, 0], b: [1, 2, 3] }] })).toMatch(/at least 3/);
    expect(validate(t.input_schema as never, {})).toMatch(/lines is required/);
    expect(validate(t.input_schema as never, { lines: [], role: 'king' })).toMatch(/one of/);
  });
});

describe('assistant loop', () => {
  beforeEach(() => useStore.getState().replaceProject(createProject('Loop test')));

  it('runs tool calls, returns results and keeps the transcript append-only', async () => {
    const session = new AssistantSession('sk-test');
    const requests: unknown[] = [];
    const replies = [
      {
        content: [{ type: 'tool_use', id: 'tu1', name: 'add_lines', input: { lines: [{ a: [0, 0, 0], b: [0, 0, 3000] }], profile: 'SHS 100x100x5', role: 'mullion' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Added one mullion.' }], stop_reason: 'end_turn' },
    ];
    const fake = {
      stream: (body: { messages: unknown[] }) => {
        requests.push(structuredClone(body.messages));
        const reply = replies.shift()!;
        return {
          on: (_ev: string, fn: (d: string) => void) => reply.content.forEach((b) => b.type === 'text' && fn((b as { text: string }).text)),
          finalMessage: async () => ({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }),
        };
      },
    };
    (session as unknown as { client: { beta: { messages: unknown } } }).client = { beta: { messages: fake } };
    let text = '';
    const tools: string[] = [];
    await session.send('Add a mullion', {
      onText: (d) => (text += d),
      onTool: (n) => tools.push(n),
      onToolResult: () => {},
      onNotice: () => {},
      onUsage: () => {},
    });
    expect(tools).toEqual(['add_lines']);
    expect(text).toBe('Added one mullion.');
    expect(Object.keys(useStore.getState().project.members)).toHaveLength(1);
    // Second request = first request + assistant turn + tool results (append-only).
    const [first, second] = requests as unknown[][];
    expect(second.slice(0, first.length)).toEqual(first);
    expect((second[2] as { content: { type: string }[] }).content[0].type).toBe('tool_result');
  });
});
