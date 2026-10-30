import type { Project } from './model/types';
import { createProject, facadeGrid, newId } from './model/ops';
import { autoConnect } from './connections/registry';

/**
 * Worked example: a two-storey curtain-wall support frame on the XZ plane —
 * SHS mullions split at the slabs with slab brackets, RHS transoms on cleats.
 */
export function sampleProject(): Project {
  const p = createProject('Sample facade – Block A east elevation');
  p.info.number = 'FS-001';
  p.info.client = 'Sample client';
  p.info.designer = 'FacadeSteel';
  facadeGrid(p, {
    plane: { kind: 'XZ', offset: 0 },
    u0: 0,
    v0: 0,
    bays: [1500, 1500, 1500, 1500],
    // Sill transom 250 above the slab, head transom 300 below the roof slab,
    // so transom cleats stay clear of the slab brackets.
    rows: [250, 850, 2400, 1100, 2100, 300],
    floorLines: [0, 3, 6],
    mullionProfile: 'SHS 100x100x5',
    transomProfile: 'RHS 100x50x4',
    transomDepthNormal: true,
    addLevels: true,
    floorTransoms: false,
  });
  p.grids = [0, 1, 2, 3, 4].map((i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 1500 }));
  autoConnect(p);
  return p;
}
