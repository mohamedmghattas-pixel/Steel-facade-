import { create } from 'zustand';
import type { Id, MemberRole, PlaneKind, Project, WorkPlane } from '../core/model/types';
import { createProject, pruneAssemblyGroups } from '../core/model/ops';
import { deriveModel, type DerivedModel } from '../core/derive/model';
import { loadAutosave, migrateProject } from './storage';
import { registerProfiles, unregisterProfiles, type ProfileDef } from '../core/library/profiles';
import type { ColorBy, GroupFilter } from '../core/management/grouping';

/**
 * Keep the global profile catalogue in step with the project's custom profiles.
 * Only added, changed and removed definitions are (re)built: an outline profile
 * takes a few milliseconds (validation, section properties).
 */
let registered = new Map<string, string>();
export function syncCustomProfiles(p: Project) {
  const defs = (p.library?.profiles ?? []) as unknown as ProfileDef[];
  const next = new Map(defs.map((d) => [d.name, JSON.stringify(d)]));
  const changed = defs.filter((d) => registered.get(d.name) !== next.get(d.name));
  const stale = [...registered.keys()].filter((n) => !next.has(n) || changed.some((d) => d.name === n));
  if (stale.length) unregisterProfiles(stale);
  if (changed.length) registerProfiles(changed);
  registered = next;
}

const initialProject = migrateProject(loadAutosave()) ?? createProject();
syncCustomProfiles(initialProject);

/** Member / profile modify tools (ui/modifyTools.ts, core/model/modify.ts). */
export type ModifyTool = 'join' | 'split' | 'extend' | 'trim' | 'break' | 'stretch' | 'rotate' | 'mirror' | 'offset' | 'reverse' | 'match' | 'section';
export const MODIFY_TOOLS: readonly ModifyTool[] = ['join', 'split', 'extend', 'trim', 'break', 'stretch', 'rotate', 'mirror', 'offset', 'reverse', 'match', 'section'];
export const isModifyTool = (t: string): t is ModifyTool => (MODIFY_TOOLS as readonly string[]).includes(t);
export type Tool = 'select' | 'line' | 'polyline' | 'move' | 'copy' | 'calibrate' | 'measure' | 'plate' | 'arc' | 'plane3' | ModifyTool;
export type ViewName = '3d' | 'front' | 'plan' | 'side';
export type SidePanel = 'assistant' | 'properties' | 'library' | 'model';
export type OutputTab = 'bom' | 'nesting' | 'drawings' | 'checks' | 'fabrication' | 'survey' | 'clashes' | 'assemblies';
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
  | 'wireframeCheck'
  | 'orientSurface'
  | 'exportPackage'
  | 'rhinoImport'
  | 'rhinoExport'
  | ManagementDialogName;

export interface Selection {
  members: Id[];
  nodes: Id[];
  connections: Id[];
  /** Free plates (Project.plates). */
  plates?: Id[];
  /**
   * Whole assemblies (their main part refs): set when assemblies are selected
   * (Assembly mode, Alt+click, the Assemblies list); members / plates /
   * connections then hold their parts. The viewer highlights them distinctly.
   */
  assemblies?: string[];
}

/** Part: a click selects the part. Assembly: a click selects its whole assembly (Alt+click in Part mode). */
export type SelectionMode = 'part' | 'assembly';

/** A drawing to open in Outputs → Drawings, with what to highlight on it (see core/drawings/navigation.ts). */
export interface DrawingFocus {
  id: string;
  highlight?: { inst?: string; ref?: string; asm?: string; part?: string };
  n: number;
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

/** Which members the wireframe check looks at. */
export type WireScope = 'all' | 'selection' | 'import';

/** Coloured preview drawn over the model while the wireframe check is open. */
export interface WireOverlay {
  /** Flat x, y, z pairs (two points per segment) and one 0xRRGGBB colour per segment. */
  segments: number[];
  colors: number[];
  /** Marker points: flat x, y, z and one colour each. */
  points: number[];
  pointColors: number[];
}

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
  /** Members created by the last wireframe import (scope "last import" of the wireframe check). */
  lastImport: Id[];
  /** Scope the wireframe check opens with (set before opening the dialog). */
  wireScope: WireScope;
  /** Scope the "Orient profiles to surface" dialog opens with. */
  orientScope: 'all' | 'selection';
  /** Preview of the wireframe check in the 3D view (null = none). */
  wireOverlay: WireOverlay | null;
  /** Part or Assembly selection mode (key A, viewport toolbar). */
  selectionMode: SelectionMode;
  /** Isolate: only the assemblies of these parts are shown (null = everything). */
  isolate: string[] | null;
  /** Bumped to aim the 3D view at some parts (part refs). */
  focusRequest: { refs: string[]; n: number } | null;
  /** Bumped to open a drawing in Outputs → Drawings and highlight a mark on it. */
  drawingFocus: DrawingFocus | null;

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
/**
 * Memory budget of the undo history, in model elements (nodes, members,
 * connections, plates; about 400 bytes each as a snapshot). 80 steps fit up to
 * about 20,000 elements; larger models keep fewer steps (a 24,000-member facade
 * with its connections keeps about 16), at least 5.
 */
const HISTORY_ELEMENTS = 1_600_000;
const HISTORY_MIN = 5;
const sizeCache = new WeakMap<Project, number>();
/** Elements of a project state (cached per state object). */
export function projectElements(p: Project): number {
  let n = sizeCache.get(p);
  if (n === undefined) {
    n = Object.keys(p.nodes).length + Object.keys(p.members).length + Object.keys(p.connections).length + Object.keys(p.plates ?? {}).length;
    sizeCache.set(p, n);
  }
  return n;
}
/** The undo list with `project` pushed, trimmed to HISTORY steps and the element budget (oldest out first). */
export function pushHistory(past: Project[], project: Project, budget = HISTORY_ELEMENTS): Project[] {
  const out = [...past.slice(-HISTORY + 1), project];
  let total = 0;
  for (const x of out) total += projectElements(x);
  let drop = 0;
  while (out.length - drop > HISTORY_MIN && total > budget) total -= projectElements(out[drop++]);
  return drop ? out.slice(drop) : out;
}

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
  lastImport: [],
  wireScope: 'all',
  orientScope: 'all',
  wireOverlay: null,
  selectionMode: 'part',
  isolate: null,
  focusRequest: null,
  drawingFocus: null,

  apply: (_label, fn) => {
    const { project, past, revision } = get();
    const draft = structuredClone(project);
    fn(draft);
    // Members or plates deleted by any operation leave their manual assemblies.
    pruneAssemblyGroups(draft);
    if (draft.library?.profiles !== project.library?.profiles || JSON.stringify(draft.library?.profiles) !== JSON.stringify(project.library?.profiles)) syncCustomProfiles(draft);
    const sel = get().selection;
    set({
      project: draft,
      past: pushHistory(past, project),
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
        ...(cur.assemblies?.length || sel.assemblies?.length ? { assemblies: toggle(cur.assemblies ?? [], sel.assemblies) } : {}),
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
  const out: Selection = {
    members: sel.members.filter((id) => p.members[id]),
    nodes: sel.nodes.filter((id) => p.nodes[id]),
    connections: sel.connections.filter((id) => p.connections[id]),
    plates: (sel.plates ?? []).filter((id) => p.plates?.[id]),
  };
  const asm = (sel.assemblies ?? []).filter((r) => refOwnerExists(p, r));
  if (asm.length) out.assemblies = asm;
  return out;
}

/** Does the member, plate or connection behind a part ref still exist? */
export function refOwnerExists(p: Project, ref: string): boolean {
  if (ref.startsWith('m:')) return !!p.members[ref.slice(2)];
  if (ref.startsWith('p:')) return !!p.plates?.[ref.slice(2)];
  if (ref.startsWith('c:')) return !!p.connections[ref.slice(2, ref.indexOf(':', 2) < 0 ? undefined : ref.indexOf(':', 2))];
  return false;
}

// ---------------------------------------------------------------------------
// Derived model, cached per project object.

/**
 * Derived models of the latest project states (least recently used out). Not a
 * WeakMap on the project: the undo history keeps every past state alive, and a
 * derived model is large (about 250 MB at 88,000 parts). Up to DERIVED_MAX
 * states while their parts stay within DERIVED_PARTS; the current state is
 * always kept, so the last step undoes without deriving again on any model.
 */
const DERIVED_MAX = 6;
const DERIVED_PARTS = 200_000;
const cache = new Map<Project, DerivedModel>();
export function derived(p: Project): DerivedModel {
  let dm = cache.get(p);
  if (dm) {
    cache.delete(p);
    cache.set(p, dm);
    return dm;
  }
  dm = deriveModel(p);
  cache.set(p, dm);
  let parts = 0;
  for (const x of cache.values()) parts += x.parts.length;
  for (const [k, v] of cache) {
    if (cache.size <= 1 || (cache.size <= DERIVED_MAX && parts <= DERIVED_PARTS)) break;
    cache.delete(k);
    parts -= v.parts.length;
  }
  return dm;
}

/** Project states with a derived model in the cache (tests). */
export const derivedCacheSize = () => cache.size;

export function useDerived(): DerivedModel {
  const p = useStore((s) => s.project);
  return derived(p);
}
