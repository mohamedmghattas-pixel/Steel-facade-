/**
 * Bridge to the claude.ai artifact runtime. When FacadeSteel is opened as a
 * claude.ai artifact, the page runs in a sandboxed frame: plain downloads and
 * calls to other hosts are blocked, but the host offers capabilities instead
 * (`downloads` to save a file, `sample` to ask Claude on the viewer's own
 * account). Everywhere else `window.claude` is absent and every lookup
 * resolves null, so callers fall back to the normal browser behaviour.
 */

interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

declare global {
  interface Window {
    claude?: ClaudeRuntime;
  }
}

/** True when the page is served by a Claude viewer (it may still lack a capability). */
export function inClaudeHost(): boolean {
  return typeof window !== 'undefined' && typeof window.claude?.use === 'function';
}

const cache = new Map<string, Promise<unknown>>();

/** Resolve a host capability namespace, or null when this view cannot run it. */
export function hostCapability<T>(name: string): Promise<T | null> {
  if (!inClaudeHost()) return Promise.resolve(null);
  let p = cache.get(name);
  if (!p) {
    p = window.claude!.use(name).catch(() => null);
    cache.set(name, p);
  }
  return p as Promise<T | null>;
}

// ---------------------------------------------------------------------------
// downloads

export interface HostDownloads {
  save(req: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<{ status: 'saved' | 'delivered' }>;
}

/** Extensions the host accepts for a saved file. Others are delivered inside a .zip. */
export const HOST_SAVE_EXTENSIONS = new Set(['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'txt', 'json', 'md', 'docx', 'pptx', 'epub', 'csv', 'ttf', 'html', 'svg', 'pdf', 'xlsx', 'zip']);

export const extensionOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

// ---------------------------------------------------------------------------
// sample (ask Claude)

export interface HostSampleTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: { signal: AbortSignal }): unknown;
}

export interface HostSampleOptions {
  onText?: (u: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  tools?: HostSampleTool[];
  modelTier?: 'quick' | 'default' | 'complex';
  cache?: boolean;
}

export interface HostSampleError {
  code: string;
  message: string;
  text?: string;
}

export interface HostSample {
  (input: string | { role: 'user' | 'assistant'; content: string }[], options?: HostSampleOptions): Promise<{ text: string; truncated: boolean }>;
  limits(): Promise<{ maxPromptBytes: number; tools?: { maxCount: number } }>;
}

export const isHostError = (e: unknown): e is HostSampleError => !!e && typeof e === 'object' && typeof (e as HostSampleError).code === 'string';
