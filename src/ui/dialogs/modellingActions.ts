/**
 * Modelling commands shared by the tool rail, properties and the 3D tools:
 * mitre / fit-to / end preparations, polygon plates, 3-point arcs and work planes.
 */
import { create } from 'zustand';
import { useStore, type Tool } from '../../state/store';
import type { Id, Vec3 } from '../../core/model/types';
import {
  addArcMembers,
  addPolygonPlate,
  addWorkPlane,
  fitEnd,
  mitreMembers,
  setEndPrep,
  splitLineAtCrossings,
} from '../../core/model/ops';
import { customWorkPlane, planeAxes } from '../../core/model/geometry';
import { arcFrom3Points, arcPoints } from '../../core/geometry/arc';
import { askText } from '../askState';

/** Session settings of the modelling tools (not saved with the project). */
export interface ModellingSettings {
  plateT: number;
  arcMode: 'deviation' | 'segments';
  arcMaxDev: number;
  arcSegments: number;
  mitreGap: number;
  fitGap: number;
  fitCope: boolean;
}

export const useModelling = create<ModellingSettings>(() => ({
  plateT: 10,
  arcMode: 'deviation',
  arcMaxDev: 5,
  arcSegments: 8,
  mitreGap: 0,
  fitGap: 10,
  fitCope: true,
}));

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);

/** Mitre the two selected members at their shared node. */
export function mitreSelection() {
  const ids = st().selection.members;
  if (ids.length !== 2) return notify('Mitre: select the two members that meet at a corner (Shift+click the second).', 'error');
  const gap = useModelling.getState().mitreGap;
  try {
    let angle = 0;
    st().apply('Mitre', (p) => {
      angle = mitreMembers(p, ids[0], ids[1], gap).angle;
    });
    notify(`Mitred at ${angle.toFixed(1)}° from square${gap ? `, ${gap} mm gap` : ''}.`);
  } catch (e) {
    notify((e as Error).message, 'error');
  }
}

/** Fit the first selected member's nearer end to the second selected member. */
export function fitSelection() {
  const ids = st().selection.members;
  if (ids.length !== 2) return notify('Fit to: select the member to cut, then Shift+click the member to fit it to.', 'error');
  const { fitGap, fitCope } = useModelling.getState();
  try {
    let msg = '';
    st().apply('Fit to member', (p) => {
      const r = fitEnd(p, ids[0], 'auto', ids[1], fitGap, fitCope);
      msg = `Fitted the ${r.end} end with a ${fitGap} mm gap${r.cope ? ` and a ${r.cope.side} cope ${r.cope.depth} × ${r.cope.length}` : ''}.`;
    });
    notify(msg);
  } catch (e) {
    notify((e as Error).message, 'error');
  }
}

export function squareEnds(ids: Id[]) {
  st().apply('Square ends', (p) => {
    for (const id of ids) {
      setEndPrep(p, id, 'start', undefined);
      setEndPrep(p, id, 'end', undefined);
    }
  });
}

/** Points collected by the modelling tools in the 3D view. */
export async function handleModellingPoints(tool: Tool, pts: Vec3[]) {
  const s = st();
  if (tool === 'plate') {
    const t = useModelling.getState().plateT;
    let id = '';
    try {
      s.apply('Add plate', (p) => {
        id = addPolygonPlate(p, pts, { t, normal: planeAxes(s.workPlane).n });
      });
      s.select({ plates: [id] });
      notify(`Plate PL${t} with ${pts.length} corners added — edit it in Properties.`);
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  } else if (tool === 'arc') {
    const [a, b, c] = pts;
    const arc = arcFrom3Points(a, b, c);
    if (!arc) return notify('The three points lie on a line — pick a point off the chord.', 'error');
    const o = useModelling.getState();
    const list = arcPoints(arc, o.arcMode === 'segments' ? { segments: o.arcSegments } : { maxDeviation: o.arcMaxDev });
    const props = s.drawWithProfile ? { profile: s.activeProfile, role: s.activeRole } : {};
    let ids: string[] = [];
    s.apply('Arc members', (p) => {
      ids = addArcMembers(p, list, props);
      for (const id of [...ids]) splitLineAtCrossings(p, id);
    });
    s.select({ members: ids.filter((id) => useStore.getState().project.members[id]) });
    notify(`Arc R ${Math.round(arc.radius)} mm as ${list.length - 1} straight segment${list.length === 2 ? '' : 's'}.`);
  } else if (tool === 'plane3') {
    const name = await askText('Name of the new work plane:', `Plane ${s.project.workPlanes.length + 1}`, { title: 'Work plane from 3 points', ok: 'Create' });
    if (name === null) return;
    try {
      let id = '';
      s.apply('Add work plane', (p) => {
        id = addWorkPlane(p, name.trim(), pts[0], pts[1], pts[2]);
      });
      const np = useStore.getState().project.workPlanes.find((w) => w.id === id)!;
      useStore.getState().set({ workPlane: customWorkPlane(np), tool: 'select' });
      notify(`Work plane “${np.name}” is active. Lines, plates and grids now snap to it.`);
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
}
