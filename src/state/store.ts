import { create } from 'zustand';
import type { Id, MemberRole, PlaneKind, Project, WorkPlane } from '../core/model/types';
import { createProject } from '../core/model/ops';
import { deriveModel, type DerivedModel } from '../core/derive/model';
import { loadAutosave, migrateProject } from './storage';
import { registerProfiles, unregisterProfiles, type ProfileDef } from '../core/library/profiles';
import type { ColorBy, GroupFilter } from '../core/management/grouping';

/** Keep the global profile catalogue in step with the project's custom profiles. */
let registered = new Set<string>();
export function syncCustomProfiles(p: Project) {
  const defs = (p.library?.profiles ?? []) as unknown as ProfileDef[];
  const names = new Set(defs.map((d) => d.name));
  const stale = [...registered].filter((n) => !names.has(n));
  if (stale.length) unregisterProfiles(stale);
  if (defs.length) registerProfiles(defs);
  registered = names;
}

const initialProject = migrateProject(loadAutosave()) ?? createProject();
syncCustomProfiles(initialProject);

export type Tool = 'select' | 'line' | 'polyline' | 'move' | 'copy' | 'calibrate' | 'measure' | 'plate' | 'arc' | 'plane3';
export type ViewName = '3d' | 'front' | 'plan' | 'side';
export type SidePanel = 'assistant' | 'properties' | 'library' | 'model';
export type OutputTab = 'bom' | 'nesting' | 'drawings' | 'checks' | 'fabrication' | 'survey' | 'clashes';
/** Dialogs of the model-management area (ui/dialogs/ManagementDialogs.tsx). */
export type ManagementDialogName = 'phases' | 'dwgInfo' | 'ifcSteel' | 'panelLayout';
export type DialogName =
  | null
  | 'facadeGrid'
  | 'autoConnect'
  | 'array'
  | 'dxfImport'
  | 'about'
  | 'issueDrawings'
  | 'drawingSettings'
  | 'applyConnection'
  | 'customConnection'
  | 'survey'
  | 'stiffeners'
  | 'bentPlate'
  | 'arcMembers'
  | 'curvedFacade'
  | ManagementDialogName;

export interface Selection {
  members: Id[];
  nodes: Id[];
  connections: Id[];
  /** Free plates (Project.plates). */
  plates?: Id[];
}

export interface SnapSettings {
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  grid: boolean;
  reference: boolean;
  ortho: boolean;
}

export const emptySelection = (): Selection => ({ members: [], nodes: [], connections: [] });

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  /** Bumped on every model change, so subscribers can cheaply detect edits. */
  revision: number;
  selection: Selection;
  tool: Tool;
  workPlane: WorkPlane;
  snap: SnapSettings;
  activeProfile: string | null;
  activeRole: MemberRole;
  display: { solids: boolean; wire: boolean; connections: boolean; references: boolean; underlays: boolean; labels: boolean; colorBy: ColorBy };
  /** Only members (and their connections) in this phase / zone / batch can be picked or box-selected. */
  selectFilter: GroupFilter | null;
  viewRequest: { name: ViewName; n: number };
  zoomRequest: number;
  sidePanel: SidePanel;
  outputs: { open: boolean; tab: OutputTab };
  dialog: DialogName;
  prompt: string;
  cursor: { x: number; y: number; z: number } | null;
  toast: { text: string; kind: 'info' | 'error'; n: number } | null;
  /** Typed coordinate input forwarded to the active tool. */
  typedInput: { text: string; n: number } | null;
  /** New lines get the active profile (otherwise they are plain wireframe). */
  drawWithProfile: boolean;
  /** Parsed DXF waiting for the import dialog. */
  pendingDxf: { name: string; text: string } | null;
  /** Underlay being calibrated by the calibrate tool. */
  calibrateTarget: Id | null;
  /** Reference-model runtime status (loading / errors) by id. */
  refStatus: Record<Id, string>;
  /** Bumped to focus the assistant input. */
  assistantFocus: number;

  apply: (label: string, fn: (draft: Project) => void) => void;
  replaceProject: (p: Project) => void;
  undo: () => void;
  redo: () => void;
  select: (sel: Partial<Selection>, additive?: boolean) => void;
  clearSelection: () => void;
  setTool: (t: Tool) => void;
  setWorkPlane: (kind: PlaneKind, offset?: number) => void;
  set: (patch: Partial<State>) => void;
  notify: (text: string, kind?: 'info' | 'error') => void;
}

const HISTORY = 80;

export const useStore = create<State>((set, get) => ({
  project: initialProject,
  past: [],
  future: [],
  revision: 0,
  selection: emptySelection(),
  tool: 'select',
  workPlane: { kind: 'XZ', offset: 0 },
  snap: { endpoint: true, midpoint: true, intersection: true, grid: true, reference: true, ortho: false },
  activeProfile: 'SHS 100x100x5',
  activeRole: 'mullion',
  display: { solids: true, wire: true, connections: true, references: true, underlays: true, labels: false, colorBy: 'role' },
  selectFilter: null,
  viewRequest: { name: '3d', n: 0 },
  zoomRequest: 0,
  sidePanel: 'properties',
  outputs: { open: false, tab: 'bom' },
  dialog: null,
  prompt: '',
  cursor: null,
  toast: null,
  typedInput: null,
  drawWithProfile: false,
  pendingDxf: null,
  calibrateTarget: null,
  refStatus: {},
  assistantFocus: 0,

  apply: (_label, fn) => {
    const { project, past, revision } = get();
    const draft = structuredClone(project);
    fn(draft);
    if (draft.library?.profiles !== project.library?.profiles || JSON.stringify(draft.library?.profiles) !== JSON.stringify(project.library?.profiles)) syncCustomProfiles(draft);
    const sel = get().selection;
    set({
      project: draft,
      past: [...past.slice(-HISTORY + 1), project],
      future: [],
      revision: revision + 1,
      selection: pruneSelection(sel, draft),
    });
  },
  replaceProject: (p) => {
    syncCustomProfiles(p);
    set({ project: p, past: [], future: [], revision: get().revision + 1, selection: emptySelection() });
  },
  undo: () => {
    const { past, project, future, revision } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    syncCustomProfiles(prev);
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...future],
      revision: revision + 1,
      selection: pruneSelection(get().selection, prev),
    });
  },
  redo: () => {
    const { past, project, future, revision } = get();
    if (!future.length) return;
    const next = future[0];
    syncCustomProfiles(next);
    set({
      project: next,
      past: [...past, project],
      future: future.slice(1),
      revision: revision + 1,
      selection: pruneSelection(get().selection, next),
    });
  },
  select: (sel, additive = false) => {
    const cur = get().selection;
    // Keep the assistant open while it selects things for the user.
    const panel = get().sidePanel === 'assistant' ? 'assistant' : 'properties';
    if (!additive) {
      set({ selection: { ...emptySelection(), ...sel }, sidePanel: panel });
      return;
    }
    const toggle = (a: Id[], b: Id[] = []) => {
      const s = new Set(a);
      for (const id of b) {
        if (s.has(id)) s.delete(id);
        else s.add(id);
      }
      return [...s];
    };
    set({
      selection: {
        members: toggle(cur.members, sel.members),
        nodes: toggle(cur.nodes, sel.nodes),
        connections: toggle(cur.connections, sel.connections),
        plates: toggle(cur.plates ?? [], sel.plates),
      },
      sidePanel: panel,
    });
  },
  clearSelection: () => set({ selection: emptySelection() }),
  setTool: (t) => set({ tool: t, prompt: '' }),
  setWorkPlane: (kind, offset) => set({ workPlane: { kind, offset: offset ?? get().workPlane.offset } }),
  set: (patch) => set(patch as Partial<State>),
  notify: (text, kind = 'info') => set({ toast: { text, kind, n: Date.now() } }),
}));

function pruneSelection(sel: Selection, p: Project): Selection {
  return {
    members: sel.members.filter((id) => p.members[id]),
    nodes: sel.nodes.filter((id) => p.nodes[id]),
    connections: sel.connections.filter((id) => p.connections[id]),
    plates: (sel.plates ?? []).filter((id) => p.plates?.[id]),
  };
}

// ---------------------------------------------------------------------------
// Derived model, cached per project object.

const cache = new WeakMap<Project, DerivedModel>();
export function derived(p: Project): DerivedModel {
  let dm = cache.get(p);
  if (!dm) {
    dm = deriveModel(p);
    cache.set(p, dm);
  }
  return dm;
}

export function useDerived(): DerivedModel {
  const p = useStore((s) => s.project);
  return derived(p);
}
