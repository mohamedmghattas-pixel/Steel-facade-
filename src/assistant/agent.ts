/**
 * The in-app assistant: Claude with tool use, called directly from the browser
 * with the user's own API key. The conversation is append-only (assistant turns
 * are sent back unchanged), so prompt caching and thinking blocks stay valid.
 */
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, runTool } from './tools';
import { validate } from './validate';
import { SYSTEM_PROMPT } from './prompt';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'low' | 'medium' | 'high';

const SYSTEM = SYSTEM_PROMPT;

const TOOL_DEFS: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ ...t, eager_input_streaming: true }));
const SCHEMAS = new Map(TOOLS.map((t) => [t.name, t.input_schema]));

export interface TurnCallbacks {
  onText: (delta: string) => void;
  onTool: (name: string, input: unknown) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onNotice: (text: string) => void;
  onUsage: (u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
}

export class AssistantSession {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  constructor(
    apiKey: string,
    private model = DEFAULT_MODEL,
    private effort: Effort = 'medium',
  ) {
    // Bring-your-own-key: the key stays in this browser and requests go straight to the API.
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  get length() {
    return this.messages.length;
  }

  async send(text: string, cb: TurnCallbacks, signal?: AbortSignal) {
    this.messages.push({ role: 'user', content: text });
    let jsonRetries = 0;
    for (let step = 0; step < 30; step++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 64000,
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          tools: TOOL_DEFS,
          messages: this.messages,
          thinking: { type: 'adaptive' },
          output_config: { effort: this.effort },
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal },
      );
      stream.on('text', (d) => cb.onText(d));
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors go to the caller.
        if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw err;
        cb.onNotice('A tool call arrived malformed — retrying.');
        continue;
      }
      cb.onUsage({
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
      });
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason === 'refusal') {
        // A declined turn can end mid tool call; keep it only if it has no unanswered tool use.
        if (!uses.length) this.messages.push({ role: 'assistant', content: msg.content });
        cb.onNotice('The model declined this request.');
        return;
      }
      this.messages.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'pause_turn') continue;
      if (!uses.length) return;
      const truncated = msg.stop_reason === 'max_tokens';
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        cb.onTool(u.name, u.input);
        let content: string;
        let isError = false;
        const schema = SCHEMAS.get(u.name);
        const invalid = truncated ? 'Tool input was cut off (max_tokens); send a smaller input.' : schema ? validate(schema as never, u.input) : `Unknown tool ${u.name}`;
        if (invalid) {
          content = JSON.stringify({ error: invalid });
          isError = true;
        } else {
          try {
            content = await runTool(u.name, u.input as Record<string, unknown>);
          } catch (e) {
            content = JSON.stringify({ error: (e as Error).message });
            isError = true;
          }
        }
        cb.onToolResult(u.name, content, isError);
        results.push({ type: 'tool_result', tool_use_id: u.id, content, is_error: isError || undefined });
      }
      this.messages.push({ role: 'user', content: results });
    }
    cb.onNotice('Stopped after 30 steps — ask me to continue if needed.');
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in the assistant settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key has no access to the selected model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the API — wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API (network or CORS).';
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}
