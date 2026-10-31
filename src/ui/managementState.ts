import { create } from 'zustand';
import type { DwgInfo } from '../core/io/dwg';
import type { ClashRun } from '../core/clash/detect';

/** UI state of the model-management dialogs (kept out of the main store). */
interface ManagementState {
  /** DWG file waiting for the conversion help dialog. */
  pendingDwg: { name: string; info: DwgInfo } | null;
  /** IFC file chosen for "IFC steel → members". */
  ifcSteel: { name: string; bytes: Uint8Array } | null;
  /** Clash detection progress / last run statistics. */
  clashBusy: string | null;
  clashStats: ClashRun['stats'] | null;
  /** Issue zoomed to in the 3D view. */
  activeIssue: string | null;
}

export const useManagement = create<ManagementState>(() => ({
  pendingDwg: null,
  ifcSteel: null,
  clashBusy: null,
  clashStats: null,
  activeIssue: null,
}));
