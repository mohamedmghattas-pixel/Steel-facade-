/**
 * Assistant session for FacadeSteel running as a claude.ai artifact. The page
 * cannot reach the Anthropic API there, so it asks Claude through the host's
 * `sample` capability, on the viewer's own Claude account (no API key). The
 * same tools as the API-key session operate the app; the host runs the tool
 * loop and calls back into the page for each tool.
 */
import { TOOLS, runTool } from './tools';
import { validate } from './validate';
import { SYSTEM_PROMPT } from './prompt';
import type { Effort, TurnCallbacks } from './agent';
import { isHostError, type HostSample, type HostSampleTool } from '../platform/claudeHost';

const TIER = { low: 'quick', medium: 'default', high: 'complex' } as const;
/** Tool results the host accepts are capped at 32 KB. */
const MAX_RESULT = 30_000;
/** Older turns are dropped first; the instructions turn is always kept. */
const MAX_TURNS = 24;

type Turn = { role: 'user' | 'assistant'; content: string };

export class HostAssistantSession {
  private turns: Turn[] = [];
  constructor(
    private sample: HostSample,
    private effort: Effort = 'medium',
  ) {}

  async send(text: string, cb: TurnCallbacks, signal?: AbortSignal) {
    const limits = await this.sample.limits().catch(() => null);
    if (!limits?.tools) {
      throw new Error('This claude.ai view cannot let the assistant operate the app. Open FacadeSteel in a normal browser tab and use an API key instead.');
    }
    this.turns.push({ role: 'user', content: text });

    let afterTool = true;
    const used: string[] = [];
    // The host may run several tool calls of one round at once; the store and
    // the chat transcript expect them one after another.
    let queue: Promise<unknown> = Promise.resolve();
    const tools: HostSampleTool[] = TOOLS.slice(0, limits.tools.maxCount).map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.input_schema as Record<string, unknown>,
      execute: (input) => {
        const run = queue.then(async () => {
          if (signal?.aborted) throw new Error('Stopped by the user.');
          afterTool = true;
          used.push(t.name);
          cb.onTool(t.name, input);
          const invalid = validate(t.input_schema as never, input);
          if (invalid) {
            cb.onToolResult(t.name, JSON.stringify({ error: invalid }), true);
            throw new Error(invalid);
          }
          try {
            const out = await runTool(t.name, input);
            cb.onToolResult(t.name, out, false);
            return out.length > MAX_RESULT ? `${out.slice(0, MAX_RESULT)}\n…[truncated: ask for a narrower filter]` : out;
          } catch (e) {
            const msg = (e as Error).message;
            cb.onToolResult(t.name, JSON.stringify({ error: msg }), true);
            throw new Error(msg);
          }
        });
        queue = run.catch(() => undefined);
        return run;
      },
    }));

    const input: Turn[] = [
      { role: 'user', content: `${SYSTEM_PROMPT}\n\nThe conversation with the user follows. Operate FacadeSteel with the tools provided.` },
      ...this.turns.slice(-MAX_TURNS),
    ];
    // A history slice must start on a user turn after the instructions turn.
    while (input.length > 1 && input[1].role === 'assistant') input.splice(1, 1);

    const res = await this.sample(input, {
      tools,
      signal,
      modelTier: TIER[this.effort],
      onText: ({ delta }) => {
        let d = delta;
        if (afterTool) {
          d = d.replace(/^\s+/, '');
          if (!d) return;
          afterTool = false;
        }
        cb.onText(d);
      },
    });
    const note = used.length ? `\n\n(Tools run in this turn: ${[...new Set(used)].join(', ')}.)` : '';
    this.turns.push({ role: 'assistant', content: res.text + note });
    if (res.truncated) cb.onNotice('The answer was cut short — ask me to continue.');
  }
}

export function describeHostError(err: unknown): string {
  if (!isHostError(err)) return (err as Error)?.message ?? String(err);
  switch (err.code) {
    case 'cancelled':
      return 'Stopped.';
    case 'not_granted':
      return 'This page is not allowed to use Claude. Reload the page and allow it when asked.';
    case 'sampling_disabled':
    case 'capability_disabled':
    case 'capability_removed':
    case 'not_declared':
      return 'Claude is not available to this page in this view.';
    case 'tools_unavailable':
      return 'This claude.ai view cannot let the assistant operate the app.';
    case 'rate_limited':
      return 'Too many requests or usage limit reached — wait a moment and try again.';
    case 'session_expired':
      return 'Your claude.ai session expired — sign in again.';
    case 'refused':
      return 'Claude declined this request.';
    case 'prompt_too_large':
      return 'The conversation is too long — start a new conversation (+).';
    case 'empty_completion':
      return 'Claude returned no answer — try rephrasing the request.';
    default:
      return `The request failed (${err.code}). Try again.`;
  }
}
