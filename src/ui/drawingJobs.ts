/**
 * Drawings on demand in the browser (docs/DRAWING_STANDARDS.md, "Drawings on demand"):
 * - the drawing index of the current project state, built in slices that yield
 *   to the page (`useDrawingIndex`); while a new one is measured after an edit,
 *   the previous one stays on screen;
 * - a background pass that makes sheets in idle time, one at a time, so "changed
 *   since issue" and the layout badges become known (issued sheets first; on
 *   large models the sheets that depend on the whole model only on request);
 * - PDF / DXF exports of many sheets, made one by one with progress and Cancel,
 *   each sheet painted once.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { derived, useStore } from '../state/store';
import { drawingSet, drawingToDxf, sheetFileStem, yieldMacrotask, type DrawingSet, type IndexProgress, type SheetEntry, type SheetIndex } from '../core/drawings';
import type { Project } from '../core/model/types';
import { assemblePdf, PdfPageCache } from '../core/export/pdfPages';
import { PdfCancelled } from '../core/export/pdfBook';
import { drawingToSvg } from '../core/drawings/render';
import { zip } from '../core/io/zip';
import { download, safeName } from '../state/storage';
import { svgPainter } from './pdf';

const st = () => useStore.getState();

/** The drawing set of a project state (made on demand, cached per state). */
export const drawingSetOf = (p: Project) => drawingSet(p, derived(p));
/** The drawing set of the current project state. */
export const currentDrawingSet = () => drawingSetOf(st().project);

// ---------------------------------------------------------------------------
// Index of the current state, built in slices

interface IndexState {
  /** Set of the last index built (may be an earlier state while the current one is measured). */
  set: DrawingSet | null;
  index: SheetIndex | null;
  building: DrawingSet | null;
  progress: IndexProgress | null;
  /** Facts pass over the current set. */
  facts: { done: number; total: number; running: boolean; heavyLeft: number } | null;
  version: number;
}

let state: IndexState = { set: null, index: null, building: null, progress: null, facts: null, version: 0 };
const subs = new Set<() => void>();
let emitTimer: ReturnType<typeof setTimeout> | null = null;
function emit(now = true) {
  if (!now) {
    // Coalesce frequent updates (background pass) to a few per second.
    emitTimer ??= setTimeout(() => {
      emitTimer = null;
      emit();
    }, 200);
    return;
  }
  state = { ...state, version: state.version + 1 };
  for (const f of subs) f();
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
let controller: AbortController | null = null;
let building: Promise<SheetIndex> | null = null;

/** Builds the index of a set in slices (one build at a time: the latest state wins; an abandoned one resumes where it stopped). */
export function requestIndex(set: DrawingSet): Promise<SheetIndex> {
  if (set.ready) {
    if (state.set !== set) {
      state.set = set;
      state.index = set.ready;
      emit();
      startFactsPass(set);
    }
    return Promise.resolve(set.ready);
  }
  if (state.building === set && building) return building;
  controller?.abort();
  const ac = new AbortController();
  controller = ac;
  state.building = set;
  state.progress = null;
  emit();
  const run = set.indexAsync({ signal: ac.signal, onProgress: (p) => controller === ac && ((state.progress = p), emit(false)) }).then((index) => {
    if (controller === ac) {
      controller = null;
      building = null;
      state.building = null;
      state.progress = null;
    }
    if (st().project === set.p) {
      state.set = set;
      state.index = index;
      emit();
      startFactsPass(set);
    }
    return index;
  });
  building = run;
  return run;
}

/** The index of the current project state (sliced; waits for it). */
export const currentIndex = () => requestIndex(currentDrawingSet());

/**
 * The drawing index of a project state for a component: the set, its index when
 * ready, else the last index built (stale) with the progress of the new one.
 */
export function useDrawingIndex(project: Project) {
  const set = useMemo(() => drawingSetOf(project), [project]);
  const snap = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    requestIndex(set).catch(() => {});
  }, [set]);
  const ready = set.ready;
  return {
    set,
    index: ready ?? snap.index,
    /** The index belongs to this state (else it is the previous one, shown while measuring). */
    ready: !!ready,
    progress: ready ? null : snap.progress,
    facts: snap.set === set ? snap.facts : null,
    version: snap.version,
  };
}

/** Re-render on index / facts changes (e.g. after a sheet was made). */
export const useDrawingVersion = () => useSyncExternalStore(subscribe, () => state.version);
/** Tell subscribers that facts of sheets are known now. */
export const sheetsChanged = () => emit();

// ---------------------------------------------------------------------------
// Background pass: facts of every sheet, in idle time

/** Models above this many parts leave the sheets that depend on the whole model to "Check all". */
export const HEAVY_PARTS = 15000;
let pass: { set: DrawingSet; ids: string[]; i: number; heavy: boolean } | null = null;

const idle = (f: (deadline?: { timeRemaining(): number }) => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(f, { timeout: 1500 });
  else setTimeout(() => f(), 40);
};

/** Starts (or restarts with `heavy`) the background pass for a set: issued sheets first, the slow ones last. */
export function startFactsPass(set: DrawingSet, o: { heavy?: boolean } = {}) {
  const idx = set.ready;
  if (!idx) return;
  if (pass?.set === set && !(o.heavy && !pass.heavy)) return;
  const heavy = o.heavy ?? set.dm.parts.length <= HEAVY_PARTS;
  const ids = idx.entries.filter((e) => e.kind !== 'register').map((e) => e.id);
  const issued = (id: string) => (idx.byId.get(id)!.revisions.length ? 0 : 1);
  const slow = (id: string) => (set.heavy(id) ? 1 : 0);
  ids.sort((a, b) => slow(a) - slow(b) || issued(a) - issued(b));
  const todo = ids.filter((id) => heavy || !set.heavy(id));
  const run = { set, ids: todo, i: 0, heavy };
  pass = run;
  state.facts = { done: 0, total: todo.length, running: true, heavyLeft: heavy ? 0 : ids.length - todo.length };
  emit();
  idle((d) => tick(run, d));
}

/** Make the remaining sheets too (those that depend on the whole model). */
export const checkAllSheets = () => {
  const set = currentDrawingSet();
  if (set.ready) startFactsPass(set, { heavy: true });
};

function tick(p: NonNullable<typeof pass>, deadline?: { timeRemaining(): number }) {
  // A newer pass (another model state, or Check all) replaces this one.
  if (pass !== p || p.set.p !== st().project) return;
  const t0 = performance.now();
  // One drawing at least; more while the idle period lasts (cheap sheets).
  do {
    while (p.i < p.ids.length) {
      const m = p.set.meta(p.ids[p.i]);
      if (!m || m.layout < 0) break;
      p.i++;
    }
    if (p.i >= p.ids.length) break;
    try {
      p.set.drawing(p.ids[p.i]);
    } catch (e) {
      console.error(e);
    }
    p.i++;
  } while (performance.now() - t0 < 12 && (deadline ? deadline.timeRemaining() > 6 : false));
  const left = state.facts?.heavyLeft ?? 0;
  state.facts = { done: p.i, total: p.ids.length, running: p.i < p.ids.length, heavyLeft: left };
  emit(!state.facts.running);
  if (p.i < p.ids.length) idle((d) => tick(p, d));
}

// ---------------------------------------------------------------------------
// Prefetch of neighbouring sheets

/** Makes these sheets in idle time (skipping slow ones), so stepping through the list shows them at once. */
export function prefetchSheets(set: DrawingSet, ids: string[]) {
  const todo = ids.filter((id) => !set.heavy(id) && set.prepared(id) && !set.cached(id));
  const step = () => {
    const id = todo.shift();
    if (!id || set.p !== st().project) return;
    if (!set.cached(id)) set.drawing(id);
    emit(false);
    if (todo.length) idle(step);
  };
  if (todo.length) idle(step);
}

// ---------------------------------------------------------------------------
// Sheets of many drawings: facts and exports with progress

interface DrawingJob {
  label: string;
  done: number;
  total: number;
  controller: AbortController;
}
export const useDrawingJob = create<{ job: DrawingJob | null }>(() => ({ job: null }));

/** Runs a job over sheets one by one, yielding to the page; returns false when cancelled. */
async function runJob(label: string, total: number, each: (i: number, signal: AbortSignal) => Promise<void> | void): Promise<boolean> {
  if (useDrawingJob.getState().job) throw new Error('Drawings are being made already — wait for it or cancel it.');
  const controller = new AbortController();
  const job: DrawingJob = { label, done: 0, total, controller };
  useDrawingJob.setState({ job });
  let last = Date.now();
  try {
    for (let i = 0; i < total; i++) {
      if (controller.signal.aborted) return false;
      await each(i, controller.signal);
      if (Date.now() - last > 60) {
        useDrawingJob.setState({ job: { ...job, done: i + 1 } });
        await yieldMacrotask();
        last = Date.now();
      }
    }
    return !controller.signal.aborted;
  } catch (e) {
    if (e instanceof PdfCancelled) return false;
    throw e;
  } finally {
    useDrawingJob.setState({ job: null });
    emit();
  }
}

export const cancelDrawingJob = () => useDrawingJob.getState().job?.controller.abort();

/** Facts (fingerprint, revision state) of sheets, making those not known yet. Returns false when cancelled. */
export async function ensureSheetFacts(set: DrawingSet, ids: string[], label = 'Checking sheets'): Promise<boolean> {
  const todo = ids.filter((id) => {
    const m = set.meta(id);
    return !m || m.layout < 0;
  });
  if (!todo.length) return true;
  return runJob(label, todo.length, (i) => void set.ensureMeta(todo[i]));
}

/** Register sheets list every sheet's scale and status: make the sheets whose facts are not known first (with progress). */
async function registerReady(set: DrawingSet, entries: SheetEntry[]): Promise<boolean> {
  if (!entries.some((e) => e.kind === 'register')) return true;
  const ids = set.index().entries.filter((e) => e.kind !== 'register').map((e) => e.id);
  return ensureSheetFacts(set, ids, 'Checking every sheet for the register');
}

/** "FS-001-A-M1_revA" — identification number (with "_sh2" for sheet 2 of a multi-sheet drawing) plus revision index. */
export function sheetFileName(d: { number: string; sheetIndex?: number; sheetCount?: number; rev: string }): string {
  return safeName(`${sheetFileStem(d)}_rev${d.rev === '-' ? '0' : d.rev}`);
}

const fileBase = () => safeName(st().project.info.name || 'facade') || 'facade';

/** PDF of sheets: each made and painted once, then put together (bookmarks when there are several). */
export async function exportSheetsPdf(set: DrawingSet, entries: SheetEntry[]): Promise<void> {
  if (!entries.length) return;
  if (!(await registerReady(set, entries))) return st().notify('PDF export cancelled.', 'error');
  const cache = new PdfPageCache(svgPainter);
  const pages: Awaited<ReturnType<PdfPageCache['page']>>[] = [];
  const ok = await runJob(`PDF of ${entries.length} sheet${entries.length === 1 ? '' : 's'}`, entries.length, async (i) => {
    const e = entries[i];
    pages.push(
      await cache.page({
        key: e.id,
        sheet: () => {
          const d = set.sheet(e.id);
          if (!d) throw new Error(`Sheet ${e.number} could not be made`);
          return { svg: () => drawingToSvg(d), w: d.sheet.w, h: d.sheet.h };
        },
      }),
    );
  });
  if (!ok) return st().notify('PDF export cancelled.', 'error');
  const marks = entries.length > 1;
  const bytes = assemblePdf(pages, { title: entries.length === 1 ? `${entries[0].number} ${entries[0].title}` : `${st().project.info.name} · drawings`, bookmarks: marks ? entries.map((e) => ({ title: `${e.number}  ${e.title}` })) : undefined });
  const live = (id: string) => set.index().byId.get(id) ?? entries.find((x) => x.id === id)!;
  download(entries.length === 1 ? `${sheetFileName(live(entries[0].id))}.pdf` : `${fileBase()}-drawings.pdf`, new Blob([bytes as BlobPart], { type: 'application/pdf' }), 'application/pdf');
}

/** DXF files of sheets in one ZIP, made one by one (each sheet is released after it is written). */
export async function exportSheetsDxf(set: DrawingSet, entries: SheetEntry[]): Promise<void> {
  if (!entries.length) return;
  if (!(await registerReady(set, entries))) return st().notify('DXF export cancelled.', 'error');
  const files: { name: string; data: string }[] = [];
  const ok = await runJob(`DXF of ${entries.length} sheet${entries.length === 1 ? '' : 's'}`, entries.length, (i) => {
    const d = set.sheet(entries[i].id);
    if (d) files.push({ name: `${sheetFileName(d)}.dxf`, data: drawingToDxf(d) });
  });
  if (!ok) return st().notify('DXF export cancelled.', 'error');
  download(`${fileBase()}-drawings-dxf.zip`, zip(files), 'application/zip');
}
