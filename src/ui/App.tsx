import { useEffect } from 'react';
import { useStore } from '../state/store';
import { saveAutosave } from '../state/storage';
import { TopBar } from './TopBar';
import { ToolRail } from './ToolRail';
import { ViewportPanel } from './ViewportPanel';
import { StatusBar } from './StatusBar';
import { SidePanel } from './SidePanel';
import { OutputsPanel } from './OutputsPanel';
import { Dialogs } from './dialogs/Dialogs';
import { AskDialog } from './ask';
import { deleteSelection, setTool } from './actions';

export function App() {
  const outputsOpen = useStore((s) => s.outputs.open);
  const toast = useStore((s) => s.toast);
  const project = useStore((s) => s.project);

  // Autosave (debounced).
  useEffect(() => {
    const t = setTimeout(() => saveAutosave(project), 600);
    return () => clearTimeout(t);
  }, [project]);

  useKeyboard();

  return (
    <div className={`app ${outputsOpen ? 'outputs-open' : ''}`}>
      <TopBar />
      <ToolRail />
      <main className="center">
        <ViewportPanel />
        {outputsOpen && <OutputsPanel />}
      </main>
      <SidePanel />
      <StatusBar />
      <Dialogs />
      <AskDialog />
      {toast && <Toast key={toast.n} text={toast.text} kind={toast.kind} />}
    </div>
  );
}

function Toast({ text, kind }: { text: string; kind: 'info' | 'error' }) {
  const set = useStore((s) => s.set);
  useEffect(() => {
    const t = setTimeout(() => set({ toast: null }), kind === 'error' ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [kind, set]);
  return (
    <div className={`toast ${kind}`} role="status" onClick={() => set({ toast: null })}>
      {text}
    </div>
  );
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        s.select({ members: Object.keys(s.project.members) });
        return;
      }
      if (mod) return;
      switch (e.key) {
        case '/':
          e.preventDefault();
          s.set({ sidePanel: 'assistant', assistantFocus: Date.now() });
          break;
        case 'Escape':
          if (s.tool !== 'select') setTool('select');
          else s.clearSelection();
          break;
        case 'Delete':
        case 'Backspace':
          deleteSelection();
          break;
        case 'l':
        case 'L':
          setTool('line');
          break;
        case 'p':
        case 'P':
          setTool('polyline');
          break;
        case 's':
        case 'S':
          setTool('select');
          break;
        case 'm':
        case 'M':
          setTool('move');
          break;
        case 'c':
        case 'C':
          setTool('copy');
          break;
        case 'f':
        case 'F':
          s.set({ zoomRequest: Date.now() });
          break;
        case 'o':
        case 'O':
          s.set({ snap: { ...s.snap, ortho: !s.snap.ortho } });
          break;
        case '1':
          s.set({ viewRequest: { name: '3d', n: Date.now() } });
          break;
        case '2':
          s.set({ viewRequest: { name: 'front', n: Date.now() } });
          break;
        case '3':
          s.set({ viewRequest: { name: 'plan', n: Date.now() } });
          break;
        case '4':
          s.set({ viewRequest: { name: 'side', n: Date.now() } });
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
