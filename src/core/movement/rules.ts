/**
 * Code-rule entries for movement, tolerances and survey checks (merged into
 * core/codes RULES). Most of these are typical facade practice rather than
 * code clauses; the verification field says so. See docs/MOVEMENT.md.
 */
import type { CodeRule } from '../codes/types';

const EC3_1_1 = 'EN 1993-1-1:2005+A1:2014';

export const MOVEMENT_RULES: CodeRule[] = [
  {
    id: 'move.thermal',
    title: 'Thermal movement ΔL = α·ΔT·L',
    code: 'both',
    clause: 'EN 1993-1-1 3.2.6 (α steel); EN 1993-1-4 (stainless); EN 1999-1-1 (aluminium)',
    edition: EC3_1_1,
    description:
      'Members lengthen and shorten with temperature. ΔT is taken from the installation temperature to the design maximum (expansion) and minimum (contraction) steel temperature in Project → Movement & tolerances.',
    values: 'α = 12×10⁻⁶ /K carbon steel (T ≤ 100 °C), 16×10⁻⁶ /K austenitic stainless, 13×10⁻⁶ /K duplex, 23×10⁻⁶ /K aluminium.',
    verification: 'cross-checked',
    sources: [],
  },
  {
    id: 'move.slot',
    title: 'Slot travel for tolerance + movement',
    code: 'both',
    clause: 'Typical practice (tolerance stack); hole sizes EN 1090-2 Table 11 / AISC 360 Table J3.3',
    edition: '—',
    description:
      'A slot must let the bolt travel ± (T + M) from its installed position: T = combined tolerance stack in the slot direction (linear or RSS), M = movement (thermal, slab deflection). Required overall length L = d0 + 2·(T + M) (+ margin), rounded up; auto slots are limited to the long-slot maximum (2.5 d) unless "special slot" is chosen, and to the plate edge distances.',
    values: 'L = d0 + 2·(T + M) + c, rounded up to 5 mm (setting).',
    verification: 'guidance',
    sources: [],
  },
  {
    id: 'move.packing',
    title: 'Packing range behind the back plate',
    code: 'both',
    clause: 'Typical practice; EN 1993-1-8 3.6.1(12) (bolts through packing)',
    edition: '—',
    description:
      'An edge-mounted bracket absorbs out-of-plane slab deviations with packs behind the back plate, detailed with a nominal pack of half the range. Packs thicker than d/3 reduce the bolt shear resistance by βp = 9d/(8d + 3tp); anchors through packs act in shear with a lever arm (anchor design, EN 1992-4 / ETA).',
    values: 'Required range 2·(T_out + S_out) ≤ maximum packing (bracket parameter, 20 mm typical).',
    verification: 'guidance',
    sources: [],
  },
  {
    id: 'move.gap',
    title: 'Stack joint gap',
    code: 'both',
    clause: 'Typical practice',
    edition: '—',
    description:
      'The gap between mullions at a stack joint must not close: thermal expansion of the mullion above (below its fixed bracket) and of the mullion below (above its fixed bracket), plus differential slab-edge deflection between the floors the two mullions hang from, plus the steel tolerances in the vertical direction.',
    values: 'gap ≥ ΔL_above + ΔL_below + δ_slab + T_v (+ margin); auto gap ≥ 10 mm (typical minimum for gaskets / sealant).',
    verification: 'guidance',
    sources: [],
  },
  {
    id: 'move.drift',
    title: 'Storey drift at the fin bolt group',
    code: 'both',
    clause: 'Typical practice',
    edition: '—',
    description: 'In-plane storey drift Δ tilts a mullion by Δ/h. The fin bolts (in vertical slots) move sideways by θ × lever and must stay within the hole clearance; a single bolt pivots.',
    values: '(Δ/h) × (n − 1)·p/2 ≤ (d0 − d)/2.',
    verification: 'guidance',
    sources: [],
  },
  {
    id: 'move.restraint',
    title: 'One fixed bracket per member',
    code: 'both',
    clause: 'Typical practice',
    edition: '—',
    description: 'A member with two dead-load (fixed) brackets cannot expand or follow the slab deflection between them; one bracket carries the dead load and the others slide.',
    values: '—',
    verification: 'guidance',
    sources: [],
  },
  {
    id: 'move.thermalEnd',
    title: 'Movement end of transoms and rails',
    code: 'both',
    clause: 'Typical practice',
    edition: '—',
    description: 'A member jointed at both ends needs one slotted end for its thermal movement; up to about 1 mm is taken by hole clearance and joint flexibility.',
    values: 'ΔL > 1 mm → one end slotted for ± (ΔL + T).',
    verification: 'guidance',
    sources: [],
  },
  {
    id: 'move.survey',
    title: 'Surveyed slab edge within the bracket adjustability',
    code: 'both',
    clause: 'Typical practice (site survey, setting-out)',
    edition: '—',
    description:
      'Where a bracket is matched to a survey point, the measured deviation not taken by a made-to-measure adjustment must fit in what the bracket adjustability leaves after the residual tolerances (fabrication, erection, survey accuracy) and movement. Otherwise the bracket cannot be installed as detailed.',
    values: '|deviation − adjustment| ≤ capacity/2 − (T_residual + M) in each surveyed direction.',
    verification: 'guidance',
    sources: [],
  },
];
