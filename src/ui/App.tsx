import { useEffect } from 'react';
import { isModifyTool, useStore } from '../state/store';
import { loadIdbAutosave, migrateProject, saveAutosave, type AutosaveResult } from '../state/storage';
import type { Project } from '../core/model/types';
import { TopBar } from './TopBar';
import { ToolRail } from './ToolRail';
import { ViewportPanel } from './ViewportPanel';
import { StatusBar } from './StatusBar';
import { SidePanel } from './SidePanel';
import { OutputsPanel } from './OutputsPanel';
import { Dialogs } from './dialogs/Dialogs';
import { AskDialog } from './ask';
import { ProfileSketcherHost } from './ProfileSketcher';
import { ProfileImportHost } from './ProfileImportDialog';
import { ProfileAssemblyHost } from './ProfileAssemblyDialog';
import { deleteSelection, setTool } from './actions';
import { escapeTool, toolEnter } from './modifyTools';
import { ModifyContextMenu, closeModifyMenu, useModifyMenu } from './ModifyPanels';
import { mirrorSectionSelection, rotateSectionSelection, stepSizeSelection } from './modifyActions';
import { PartContextMenu } from './AssemblyPanels';
import { toggleIsolate, toggleSelectionMode } from './navigationActions';

export function App() {
  const outputsOpen = useStore((s) => s.outputs.open);
  const toast = useStore((s) => s.toast);
  const project = useStore((s) => s.project);

  // Autosave (debounced).
  useEffect(() => {
    const t = setTimeout(() => void autosave(project), 600);
    return () => clearTimeout(t);
  }, [project]);
  useEffect(() => void restoreIdbAutosave(), []);

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
      <ProfileImportHost />
      <ProfileAssemblyHost />
      <ProfileSketcherHost />
      <ModifyContextMenu />
      <PartContextMenu />
      <AskDialog />
      {toast && <Toast key={toast.n} text={toast.text} kind={toast.kind} />}
    </div>
  );
}

/** Where autosaves went last; a change (or a failure) is reported once, not on every edit. */
let autosaveWhere: AutosaveResult['where'] | null = null;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function autosave(p: Project) {
  const r = await saveAutosave(p);
  if (r.where === autosaveWhere) return;
  const first = autosaveWhere === null;
  autosaveWhere = r.where;
  const notify = useStore.getState().notify;
  if (r.where === 'indexeddb') notify(`The project (${mb(r.bytes)}) is too large for the browser's local storage, so it is autosaved to IndexedDB instead. Save it as a file to keep a copy.`);
  else if (r.where === 'none') notify(`Autosave failed (${r.error ?? 'browser storage is full or blocked'}). Save the project as a file (File → Save project) to keep your work.`, 'error');
  else if (!first) notify('Autosave works again (local storage).');
}

/** A large project autosaved to IndexedDB is restored once the app has started (localStorage loads synchronously). */
let restoring = false;
async function restoreIdbAutosave() {
  if (restoring) return;
  restoring = true;
  const s = useStore.getState();
  if (s.revision || Object.keys(s.project.members).length) return;
  const p = migrateProject(await loadIdbAutosave());
  // Only when nothing has happened in the meantime.
  if (!p || useStore.getState().revision !== s.revision) return;
  useStore.getState().replaceProject(p);
  useStore.getState().notify(`Restored the autosaved project "${p.info.name}" (${Object.keys(p.members).length} members) from IndexedDB.`);
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

/** Keys that start typed input for the modify tools. */
const TYPED_KEYS = /^[0-9@=\-/<>.]$/;

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
      // Modify tools and section quick operations (shift combinations first).
      if (useModifyMenu.getState().menu && e.key === 'Escape') {
        closeModifyMenu();
        return;
      }
      if (e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        const shiftTool = ({ m: 'mirror', o: 'offset', p: 'match', r: 'section' } as const)[k as 'm' | 'o' | 'p' | 'r'];
        if (shiftTool) {
          e.preventDefault();
          setTool(shiftTool);
          return;
        }
        if (k === 'f') {
          e.preventDefault();
          rotateSectionSelection(180);
          return;
        }
        if (k === 'x') {
          e.preventDefault();
          mirrorSectionSelection();
          return;
        }
      }
      // A number (or = @ / < > -) typed while a modify tool is active goes to the typed-input box.
      if (isModifyTool(s.tool) && TYPED_KEYS.test(e.key)) {
        const box = document.querySelector<HTMLInputElement>('.coord-input');
        if (box) {
          box.focus();
          return;
        }
      }
      if (e.key === 'Enter' && isModifyTool(s.tool)) {
        e.preventDefault();
        toolEnter();
        return;
      }
      switch (e.key) {
        case 'j':
        case 'J':
          setTool('join');
          return;
        case 'k':
        case 'K':
          setTool('split');
          return;
        case 'e':
        case 'E':
          setTool('extend');
          return;
        case 't':
        case 'T':
          setTool('trim');
          return;
        case 'b':
        case 'B':
          setTool('break');
          return;
        case 'g':
        case 'G':
          setTool('stretch');
          return;
        case 'r':
        case 'R':
          setTool('rotate');
          return;
        case 'v':
        case 'V':
          setTool('reverse');
          return;
        case ']':
          rotateSectionSelection(90);
          return;
        case '[':
          rotateSectionSelection(-90);
          return;
        case '+':
        case '=':
          stepSizeSelection(1);
          return;
        case '-':
          stepSizeSelection(-1);
          return;
      }
      switch (e.key) {
        case '/':
          e.preventDefault();
          s.set({ sidePanel: 'assistant', assistantFocus: Date.now() });
          break;
        case 'Escape':
          if (isModifyTool(s.tool) && escapeTool()) break;
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
        case 'a':
        case 'A':
          // Part / Assembly selection mode.
          toggleSelectionMode();
          break;
        case 'i':
        case 'I':
          toggleIsolate();
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
