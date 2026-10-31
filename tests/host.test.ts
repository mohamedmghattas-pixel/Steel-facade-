import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HostAssistantSession, describeHostError } from '../src/assistant/hostAgent';
import type { HostSample, HostSampleOptions } from '../src/platform/claudeHost';
import { useStore } from '../src/state/store';
import { createProject } from '../src/core/model/ops';
import { download } from '../src/state/storage';

const cb = (log: string[]) => ({
  onText: (d: string) => log.push(`text:${d}`),
  onTool: (n: string) => log.push(`tool:${n}`),
  onToolResult: (n: string, _r: string, err: boolean) => log.push(`result:${n}:${err ? 'error' : 'ok'}`),
  onNotice: (t: string) => log.push(`notice:${t}`),
  onUsage: () => {},
});

describe('claude.ai host assistant', () => {
  beforeEach(() => useStore.getState().replaceProject(createProject('Host test')));

  it('runs page tools through the host sample loop and keeps a short transcript', async () => {
    const calls: { input: unknown; opts: HostSampleOptions }[] = [];
    const fake = (async (input: unknown, opts: HostSampleOptions = {}) => {
      calls.push({ input: structuredClone(input), opts });
      const tool = opts.tools!.find((t) => t.name === 'add_lines')!;
      opts.onText?.({ text: 'Adding.', delta: 'Adding.' });
      await tool.execute({ lines: [{ a: [0, 0, 0], b: [0, 0, 3000] }], profile: 'SHS 100x100x5', role: 'mullion' }, { signal: new AbortController().signal });
      // Text after a tool round arrives after a blank line; the session starts a new bubble without it.
      opts.onText?.({ text: 'Adding.\n\nDone.', delta: '\n\nDone.' });
      return { text: 'Adding.\n\nDone.', truncated: false };
    }) as HostSample;
    fake.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 64 } });

    const log: string[] = [];
    const s = new HostAssistantSession(fake, 'low');
    await s.send('Add a mullion', cb(log));
    expect(log).toEqual(['text:Adding.', 'tool:add_lines', 'result:add_lines:ok', 'text:Done.']);
    expect(Object.keys(useStore.getState().project.members)).toHaveLength(1);
    expect(calls[0].opts.modelTier).toBe('quick');
    // Instructions turn + the user's message; the second call carries the first reply.
    await s.send('Thanks', cb([]));
    const turns = calls[1].input as { role: string; content: string }[];
    expect(turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant', 'user']);
    expect(turns[2].content).toContain('add_lines');
  });

  it('reports invalid tool input back to Claude as an error', async () => {
    const fake = (async (_i: unknown, opts: HostSampleOptions = {}) => {
      const tool = opts.tools!.find((t) => t.name === 'add_lines')!;
      await expect(tool.execute({ lines: [{ a: [0, 0], b: [1, 2, 3] }] }, { signal: new AbortController().signal })).rejects.toThrow(/at least 3/);
      return { text: 'Fixed.', truncated: false };
    }) as HostSample;
    fake.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 64 } });
    const log: string[] = [];
    await new HostAssistantSession(fake).send('x', cb(log));
    expect(log).toContain('result:add_lines:error');
  });

  it('explains host errors in plain words', () => {
    expect(describeHostError({ code: 'not_granted', message: '' })).toMatch(/allow/);
    expect(describeHostError({ code: 'cancelled', message: '' })).toBe('Stopped.');
  });
});

describe('claude.ai host downloads', () => {
  const saved: { filename: string; data: unknown }[] = [];
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
      claude: { use: async (n: string) => (n === 'downloads' ? { save: async (r: { filename: string; data: unknown }) => (saved.push(r), { status: 'saved' }) } : null) },
    };
  });
  afterAll(() => delete (globalThis as { window?: unknown }).window);

  it('saves allowed formats as-is and wraps others in a zip', async () => {
    download('model.facadesteel.json', '{}', 'application/json');
    download('model.ifc', 'ISO-10303-21;', 'application/x-step');
    for (let i = 0; i < 20 && saved.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(saved.map((s) => s.filename)).toEqual(['model.facadesteel.json', 'model.ifc.zip']);
    const zip = saved[1].data as Uint8Array;
    expect([zip[0], zip[1]]).toEqual([0x50, 0x4b]); // "PK"
  });
});
