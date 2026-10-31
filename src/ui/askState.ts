import { create } from 'zustand';

/**
 * In-app replacements for window.confirm / window.prompt. Native dialogs are
 * blocked in sandboxed frames (e.g. when FacadeSteel runs as a claude.ai
 * artifact), so every question the app asks goes through the AskDialog modal.
 */

export type Ask = { kind: 'confirm' | 'prompt'; title: string; text: string; value: string; ok: string; resolve: (v: string | null) => void };

export const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

function open(a: Ask) {
  useAsk.getState().ask?.resolve(null);
  useAsk.setState({ ask: a });
}

export function askConfirm(text: string, opts: { title?: string; ok?: string } = {}): Promise<boolean> {
  return new Promise((res) => open({ kind: 'confirm', title: opts.title ?? 'Please confirm', text, value: '', ok: opts.ok ?? 'OK', resolve: (v) => res(v !== null) }));
}

export function askText(text: string, value = '', opts: { title?: string; ok?: string } = {}): Promise<string | null> {
  return new Promise((res) => open({ kind: 'prompt', title: opts.title ?? 'Input', text, value, ok: opts.ok ?? 'OK', resolve: res }));
}
