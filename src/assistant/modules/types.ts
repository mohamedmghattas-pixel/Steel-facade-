import type Anthropic from '@anthropic-ai/sdk';

export type Json = Record<string, unknown>;

/**
 * A group of assistant tools for one feature area. Each module lists its tool
 * definitions and a handler per tool name; handlers return plain data (it is
 * JSON-encoded for the model) or throw an Error with a message the model can act on.
 * Edits must go through `useStore.getState().apply(label, fn)` so they are undoable.
 */
export interface ToolModule {
  tools: Anthropic.Beta.BetaTool[];
  run: Record<string, (input: Json) => unknown | Promise<unknown>>;
}
