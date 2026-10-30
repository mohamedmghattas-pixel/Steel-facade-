import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { AssistantSession, Effort } from '../assistant/agent';
import { Icon } from './icons';
import { Segmented } from './widgets';

const KEY_STORE = 'facadesteel.anthropic.key';
const EFFORT_STORE = 'facadesteel.anthropic.effort';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string; error: boolean; done: boolean }
  | { kind: 'notice'; text: string; error?: boolean };

const SUGGESTIONS = [
  'Create a 4-bay, 2-storey facade on the XZ plane: bays 1500, floors 3500, SHS 100x100x5 mullions and RHS 100x50x4 transoms, then add slab brackets and cleats.',
  'Check the model against the detailing code and fix edge distances that are too small.',
  'Change all transoms to the lightest RHS that is at least 100 deep, and galvanize everything.',
  'Make a custom bracket: L back plate anchored to concrete with 2 M12 anchors and a slotted fin bolted to the member — then apply it to the selected members.',
  'Issue all drawings for approval and export the material list to Excel.',
];

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const write = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // storage blocked — key lives for this session only
  }
};

let session: AssistantSession | null = null;
let sessionKey = '';
let history: Item[] = [];

const TOOL_LABEL: Record<string, string> = {
  get_model_summary: 'Read the model',
  list_members: 'Listed members',
  select: 'Selected',
  create_facade_grid: 'Created facade grid',
  add_lines: 'Added lines',
  set_member_properties: 'Changed members',
  auto_assign_profiles: 'Auto-assigned profiles',
  edit_geometry: 'Edited geometry',
  search_profiles: 'Searched profiles',
  describe_connection_types: 'Read connection library',
  apply_connection: 'Applied connections',
  auto_connect: 'Auto-connected',
  set_connection_params: 'Changed connection parameters',
  delete_connections: 'Deleted connections',
  save_custom_template: 'Saved custom connection',
  set_project: 'Updated project settings',
  run_checks: 'Ran checks',
  get_reports: 'Read reports',
  drawings: 'Drawings',
  export: 'Exported',
  view: 'Changed view',
  history: 'History',
};

function summarize(result: string): string {
  try {
    const r = JSON.parse(result) as Record<string, unknown>;
    if (r.error) return String(r.error);
    const keys = ['created', 'updated', 'selected', 'deleted', 'assigned', 'issued', 'downloaded', 'total', 'members', 'loaded'];
    const parts = keys.filter((k) => r[k] !== undefined && typeof r[k] !== 'object').map((k) => `${k} ${r[k]}`);
    if (Array.isArray(r)) return `${r.length} results`;
    return parts.join(' · ');
  } catch {
    return '';
  }
}

export function AssistantPanel() {
  const [apiKey, setApiKey] = useState(() => read(KEY_STORE));
  const [effort, setEffort] = useState<Effort>(() => (read(EFFORT_STORE) as Effort) || 'medium');
  const [items, setItems] = useState<Item[]>(history);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(!read(KEY_STORE));
  const [usage, setUsage] = useState({ input: 0, output: 0, cacheRead: 0 });
  const abort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusReq = useStore((s) => s.assistantFocus);

  useEffect(() => {
    history = items;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);
  useEffect(() => {
    if (focusReq) inputRef.current?.focus();
  }, [focusReq]);

  const push = (it: Item) => setItems((prev) => [...prev, it]);
  const patchLast = (fn: (it: Item) => Item | null) =>
    setItems((prev) => {
      const next = [...prev];
      const last = fn(next[next.length - 1]);
      if (last) next[next.length - 1] = last;
      return next;
    });

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    if (!apiKey) {
      setShowKey(true);
      return;
    }
    setInput('');
    push({ kind: 'user', text: t });
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const { AssistantSession } = await import('../assistant/agent');
      const fp = `${apiKey}|${effort}`;
      if (!session || sessionKey !== fp) {
        session = new AssistantSession(apiKey, undefined, effort);
        sessionKey = fp;
      }
      let streaming = false;
      await session.send(
        t,
        {
          onText: (d) => {
            if (!streaming) {
              streaming = true;
              push({ kind: 'assistant', text: d });
            } else patchLast((it) => (it.kind === 'assistant' ? { ...it, text: it.text + d } : null));
          },
          onTool: (name) => {
            streaming = false;
            push({ kind: 'tool', name, summary: '', error: false, done: false });
          },
          onToolResult: (_name, result, isError) => {
            patchLast((it) => (it.kind === 'tool' ? { ...it, summary: summarize(result), error: isError, done: true } : null));
          },
          onNotice: (text) => {
            streaming = false;
            push({ kind: 'notice', text });
          },
          onUsage: (u) => setUsage((prev) => ({ input: prev.input + u.input + u.cacheWrite, output: prev.output + u.output, cacheRead: prev.cacheRead + u.cacheRead })),
        },
        ctrl.signal,
      );
    } catch (e) {
      const { describeError } = await import('../assistant/agent');
      push({ kind: 'notice', text: describeError(e), error: true });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const clear = () => {
    session = null;
    sessionKey = '';
    setItems([]);
    setUsage({ input: 0, output: 0, cacheRead: 0 });
  };

  return (
    <section className="assistant">
      <div className="assistant-bar">
        <Segmented
          value={effort}
          options={[
            { value: 'low', label: 'Quick', title: 'Low effort — fastest, cheapest' },
            { value: 'medium', label: 'Balanced', title: 'Medium effort' },
            { value: 'high', label: 'Thorough', title: 'High effort — for complex multi-step edits' },
          ]}
          onChange={(v) => {
            setEffort(v);
            write(EFFORT_STORE, v);
          }}
        />
        <div className="grow" />
        <button className="icon-btn" title="API key" onClick={() => setShowKey(!showKey)}>
          <Icon name="bolt" size={16} />
        </button>
        <button className="icon-btn" title="New conversation" onClick={clear} disabled={busy}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      {showKey && (
        <div className="key-card">
          <p>
            The assistant runs on Claude (<code>claude-opus-5-5</code>) with your own Anthropic API key. The key is stored only in this browser and requests go
            directly from your browser to the Anthropic API.
          </p>
          <input
            type="password"
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value.trim())}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Anthropic API key"
          />
          <div className="btn-row">
            <button
              className="primary-btn"
              disabled={!apiKey}
              onClick={() => {
                write(KEY_STORE, apiKey);
                setShowKey(false);
                session = null;
              }}
            >
              Save key
            </button>
            {read(KEY_STORE) && (
              <button
                className="secondary-btn"
                onClick={() => {
                  write(KEY_STORE, '');
                  setApiKey('');
                  session = null;
                }}
              >
                Forget key
              </button>
            )}
            <a className="link-btn" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              Get a key
            </a>
          </div>
        </div>
      )}
      <div className="chat-list" ref={listRef} aria-live="polite">
        {!items.length && (
          <div className="chat-empty">
            <p>
              Tell FacadeSteel what to do — it edits the model, connections, settings and drawings for you. Every change can be undone with Ctrl+Z.
            </p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        {items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="msg user">
              {it.text}
            </div>
          ) : it.kind === 'assistant' ? (
            <div key={i} className="msg bot">
              {it.text}
            </div>
          ) : it.kind === 'tool' ? (
            <div key={i} className={`tool-chip ${it.error ? 'error' : ''} ${it.done ? '' : 'running'}`}>
              <Icon name={it.error ? 'warn' : it.done ? 'check' : 'auto'} size={13} />
              <span>{TOOL_LABEL[it.name] ?? it.name}</span>
              {it.summary && <span className="muted">{it.summary}</span>}
            </div>
          ) : (
            <div key={i} className={`notice ${it.error ? 'error' : ''}`}>
              {it.text}
            </div>
          ),
        )}
        {busy && <div className="typing">Working…</div>}
      </div>
      <div className="chat-input">
        <textarea
          ref={inputRef}
          value={input}
          rows={3}
          placeholder={apiKey ? 'Ask or instruct… (Enter to send, Shift+Enter for a new line)' : 'Add your Anthropic API key to start'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          aria-label="Message the assistant"
        />
        {busy ? (
          <button className="secondary-btn" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary-btn" disabled={!input.trim()} onClick={() => void send(input)}>
            Send
          </button>
        )}
      </div>
      {(usage.input > 0 || usage.cacheRead > 0) && (
        <div className="usage muted">
          Tokens this chat: {(usage.input + usage.cacheRead).toLocaleString()} in ({usage.cacheRead.toLocaleString()} cached) · {usage.output.toLocaleString()} out
        </div>
      )}
    </section>
  );
}
