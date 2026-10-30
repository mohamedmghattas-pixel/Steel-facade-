import { autoConnect } from '../src/core/connections/registry';
import { createProject, facadeGrid } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';

/** A two-storey, three-bay facade on the XZ plane with brackets and cleats. */
export function sampleFacade(): Project {
  const p = createProject('Test facade');
  facadeGrid(p, {
    plane: { kind: 'XZ', offset: 0 },
    u0: 0,
    v0: 0,
    bays: [1500, 1500, 1500],
    rows: [1200, 2300, 1200, 2300],
    floorLines: [0, 2, 4],
    mullionProfile: 'SHS 100x100x5',
    transomProfile: 'RHS 80x40x3',
    transomDepthNormal: true,
    addLevels: true,
  });
  autoConnect(p);
  return p;
}
