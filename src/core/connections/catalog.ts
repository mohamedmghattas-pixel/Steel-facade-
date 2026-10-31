/**
 * Connection library catalogue: category, typical use, required members,
 * standards notes and the representative joint used for the live preview of
 * every registered connection type. Metadata only — the geometry lives in the
 * connection definitions (registry.ts).
 *
 * Standards notes cite clauses only where the rule is encoded in the code
 * checks (docs/CODE_RULES.md); everything else is "typical practice".
 * Detailing only — capacity by the engineer of record.
 */
import type { ConnectionType, ParamValue } from '../model/types';

export type CategoryId = 'concrete' | 'steel' | 'splice' | 'bracing' | 'hanger' | 'custom';

export const CATEGORIES: { id: CategoryId; label: string; description: string }[] = [
  { id: 'concrete', label: 'Steel to concrete', description: 'Brackets, embeds, channels and base plates fixed to slabs, walls and soffits.' },
  { id: 'steel', label: 'Steel to steel', description: 'Cleats, fins, end plates, clamps and saddles between members.' },
  { id: 'splice', label: 'Splices & movement joints', description: 'Joints between collinear members, with or without movement.' },
  { id: 'bracing', label: 'Bracing & gussets', description: 'Gusset plates and cross-bracing plates for flat, angle and tube braces.' },
  { id: 'hanger', label: 'Hangers & ties', description: 'Hanger rods and tie-back struts on lugs.' },
  { id: 'custom', label: 'Custom templates & presets', description: 'Your formula-driven templates and saved parameter presets.' },
];

/** Representative joints for previews (see preview.ts). */
export type JointKind =
  | 'mullionEdge'
  | 'mullionBase'
  | 'mullionStack'
  | 'postBase'
  | 'railWall'
  | 'mullionTransom'
  | 'beamPost'
  | 'columnBrace'
  | 'crossBrace'
  | 'spliceStack'
  | 'hanger'
  | 'freeEnd'
  | 'mullionStrut';

/** What the anchors of a type go into, for the translucent concrete shown in previews. */
export type ConcreteHint = 'slab' | 'wall' | 'floor' | 'soffit';

export interface CatalogEntry {
  type: ConnectionType;
  category: CategoryId;
  /** One-line summary for lists. */
  summary: string;
  /** Typical use on a facade. */
  use: string;
  /** Members the type needs: main / supported / support. */
  members: string;
  standards: string;
  /** Parameters worth showing first. */
  keyParams: string[];
  joint: JointKind | ((v: Record<string, ParamValue>) => JointKind);
  concrete?: ConcreteHint;
  /** Alternative supported-member profiles for the preview. */
  previewProfiles?: string[];
  /** Code-check rule ids this type may warn about with default parameters on its typical joint (see docs/CONNECTIONS.md). */
  expectedWarnings?: string[];
  tags?: string[];
}

const HOLES = 'Holes, slots, edge distances and spacing per EN 1090-2 Table 11 / EN 1993-1-8 Table 3.3 and AISC 360 Tables J3.3–J3.5 (checked).';
const ANCHORS = 'Anchor spacing / edge distances vs typical family minima — design with the anchor ETA (EAD 330232 / 330499) or ICC-ES ESR.';
/** A welded plate closes a galvanized hollow section — vent/drain holes needed (EN ISO 14713-2 guidance). */
const VENT = 'coat.vent';
/** Bolts straddling a 50 mm transom on a 5 mm mullion wall exceed EN 1993-1-8 p ≤ 14 t. */
const MAXSP = 'ec3.maxSpacing';
const mountJoint = (v: Record<string, ParamValue>): JointKind => (v.mount === 'slab top' ? 'mullionBase' : 'mullionEdge');

export const CATALOG: Record<ConnectionType, CatalogEntry> = {
  // --- Steel to concrete --------------------------------------------------
  slabBracket: {
    type: 'slabBracket',
    category: 'concrete',
    summary: 'Fin bolted to the mullion, welded to an anchored back plate.',
    use: 'Curtain-wall / unitised mullion to slab edge or slab top at stack joints; dead-load and restraint brackets.',
    members: 'Supported: mullion (one or two at a stack joint). Support: slab edge / top.',
    standards: `${HOLES} Long fin slots (2.5 d) for vertical tolerance. ${ANCHORS}`,
    keyParams: ['mount', 'standoff', 'finT', 'backT', 'bolt', 'anchor', 'anchorType', 'slot'],
    joint: (v) => (v.mount === 'top' ? 'mullionBase' : 'mullionStack'),
    concrete: 'slab',
    tags: ['curtain wall', 'stack joint', 'anchor'],
  },
  baseplate: {
    type: 'baseplate',
    category: 'concrete',
    summary: 'End plate welded to a post, four anchors.',
    use: 'Posts, balustrade and canopy columns on slabs or plinths.',
    members: 'Supported: post (vertical). Support: floor slab.',
    standards: `${HOLES} Oversize anchor holes for tolerance. ${ANCHORS}`,
    keyParams: ['t', 'width', 'length', 'edge', 'anchor', 'anchorType'],
    joint: 'postBase',
    concrete: 'floor',
    expectedWarnings: [VENT],
  },
  helpingHand: {
    type: 'helpingHand',
    category: 'concrete',
    summary: 'Rainscreen L bracket — fixed point (round holes) or sliding point (vertical slots).',
    use: 'Rainscreen / cladding subframes on concrete or masonry walls; one fixed point per rail, the rest sliding.',
    members: 'Supported: mullion / vertical rail. Support: wall or slab-edge face.',
    standards: `${HOLES} Sliding points: long slots ≤ 2.5 d, snug-tight bolts with sliding washers (typical practice). Thermal isolator pad under the wall leg (typical practice). ${ANCHORS}`,
    keyParams: ['variant', 'angle', 'standoff', 'bolt', 'slot', 'anchor', 'anchorType'],
    joint: 'mullionEdge',
    concrete: 'wall',
    tags: ['rainscreen', 'thermal', 'sliding'],
  },
  castInChannel: {
    type: 'castInChannel',
    category: 'concrete',
    summary: 'Bracket on a cast-in anchor channel with T-bolts — 3-way adjustment.',
    use: 'Curtain-wall brackets on slab edges or slab tops where channels are cast in by the frame contractor.',
    members: 'Supported: mullion. Support: slab edge (edge mount) or slab top (top mount) with anchor channel.',
    standards: `${HOLES} T-bolt sizes per channel (fasteners library, typical). Channel design per EN 1992-4 / EAD 330008 or ICC-ES AC232 — by the channel supplier.`,
    keyParams: ['mount', 'channel', 'tBolt', 'backSlot', 'finSlot', 'standoff'],
    joint: mountJoint,
    concrete: 'slab',
    tags: ['anchor channel', 'Halfen', 'adjustable'],
  },
  embedPlate: {
    type: 'embedPlate',
    category: 'concrete',
    summary: 'Cast-in plate with headed studs and a welded fin.',
    use: 'Heavy brackets where the frame contractor casts in plates; fin site-welded after the mullion is aligned.',
    members: 'Supported: mullion. Support: slab edge or slab top (embed flush).',
    standards: `${HOLES} Headed studs per EN ISO 13918 / AWS D1.1 Type B; embed design per EN 1992-4 / ACI 318 Ch. 17 by the engineer of record. Site welds: welding procedure and inspection per EN 1090-2 / AWS D1.1.`,
    keyParams: ['mount', 'finWeld', 'embedT', 'stud', 'studLen', 'finT', 'slot'],
    joint: mountJoint,
    concrete: 'slab',
    tags: ['embed', 'cast-in', 'site weld'],
  },
  soffitHanger: {
    type: 'soffitHanger',
    category: 'concrete',
    summary: 'Plate anchored to the soffit with fins either side of the member top; deflection slots.',
    use: 'Head restraints of mullions or posts under a slab: wind restraint with vertical freedom for slab deflection.',
    members: 'Supported: mullion / post (top end). Support: slab soffit.',
    standards: `${HOLES} Clear gap ≥ slab deflection + tolerance (project movement settings); vertical long slots (typical practice). ${ANCHORS}`,
    keyParams: ['variant', 'gap', 'plateT', 'finT', 'bolt', 'slot', 'anchor'],
    joint: 'mullionEdge',
    concrete: 'soffit',
    tags: ['head restraint', 'deflection', 'soffit'],
  },
  wallAngle: {
    type: 'wallAngle',
    category: 'concrete',
    summary: 'Angle anchored to a wall, bolted to the side of a rail end.',
    use: 'Rails, transoms and outriggers ending at concrete walls or columns.',
    members: 'Supported: rail / transom (end at the wall). Support: wall or column face.',
    standards: `${HOLES} Optional thermal slot in the member. ${ANCHORS}`,
    keyParams: ['angle', 'bolt', 'slotV', 'slotH', 'anchor', 'anchorType'],
    joint: 'railWall',
    concrete: 'wall',
  },
  adjustableBracket: {
    type: 'adjustableBracket',
    category: 'concrete',
    summary: 'Wall angle + slide bracket with slots in three directions; serrated plates.',
    use: 'Brackets that must absorb large slab-edge tolerances in all three directions (refurbishment, poor tolerance frames).',
    members: 'Supported: mullion. Support: slab edge or wall face.',
    standards: `${HOLES} Serrated plates lock slotted joints against slip (typical practice — serration pitch by the supplier). ${ANCHORS}`,
    keyParams: ['angle', 'standoff', 'slotX', 'slotZ', 'anchorSlot', 'serrated'],
    joint: 'mullionEdge',
    concrete: 'slab',
    tags: ['3D', 'tolerance', 'serrated'],
  },
  stiffenedBase: {
    type: 'stiffenedBase',
    category: 'concrete',
    summary: 'Base plate with welded gussets on two or four faces.',
    use: 'Cantilever posts, canopy and balustrade posts with base moments.',
    members: 'Supported: post. Support: floor slab / plinth.',
    standards: `${HOLES} Gusset snipes clear the post-to-plate weld (typical practice). ${ANCHORS}`,
    keyParams: ['t', 'gussets', 'gT', 'gH', 'anchors', 'anchor', 'anchorType', 'hef'],
    joint: 'postBase',
    concrete: 'floor',
    expectedWarnings: [VENT],
  },
  anchorPlate: {
    type: 'anchorPlate',
    category: 'concrete',
    summary: 'Post-installed anchor plate — chemical, expansion, undercut or screw anchors.',
    use: 'Member ends at walls, columns or slabs fixed with post-installed anchors; welded end plate or bolted fin.',
    members: 'Supported: rail / strut / post end. Support: concrete face.',
    standards: `${HOLES} Fixture clearance holes per EN 1992-4 Table 6.1. Anchor length from typical h_ef. ${ANCHORS}`,
    keyParams: ['fixing', 'pattern', 'anchor', 'anchorType', 'hef', 't'],
    joint: 'railWall',
    concrete: 'wall',
    expectedWarnings: [VENT],
  },

  // --- Steel to steel -----------------------------------------------------
  finPlate: {
    type: 'finPlate',
    category: 'steel',
    summary: 'Plate welded to the main member, bolted through the secondary.',
    use: 'Transoms and rails to mullions or posts; knife version in slotted members.',
    members: 'Main: mullion / post / beam. Secondary: transom / rail.',
    standards: HOLES,
    keyParams: ['t', 'length', 'position', 'bolt', 'bolts', 'slot'],
    joint: 'mullionTransom',
  },
  angleCleat: {
    type: 'angleCleat',
    category: 'steel',
    summary: 'Angle bolted to the main face and the secondary side.',
    use: 'Default transom-to-mullion joint; fully bolted, site adjustable.',
    members: 'Main: mullion / post. Secondary: transom / rail.',
    standards: HOLES,
    keyParams: ['profile', 'bolt', 'bolts', 'gauge'],
    joint: 'mullionTransom',
  },
  endPlate: {
    type: 'endPlate',
    category: 'steel',
    summary: 'Plate welded to the secondary end, through-bolted to the main.',
    use: 'Transoms, outriggers and beams to posts or mullions.',
    members: 'Main: mullion / post / beam. Secondary: transom / beam.',
    standards: HOLES,
    keyParams: ['t', 'bolt', 'rows', 'edge'],
    joint: 'mullionTransom',
    expectedWarnings: [VENT, MAXSP],
  },
  welded: {
    type: 'welded',
    category: 'steel',
    summary: 'Secondary cut to the main face and shop welded.',
    use: 'Ladder frames and shop-assembled units.',
    members: 'Main and secondary (one assembly).',
    standards: 'Fillet weld size vs part thickness checked (AISC 360 Table J2.4 / EN 1993-1-8 4.5.2).',
    keyParams: ['gap'],
    joint: 'mullionTransom',
    expectedWarnings: [VENT],
  },
  flangeClamp: {
    type: 'flangeClamp',
    category: 'steel',
    summary: 'Clamped to the flange of the main steel — no drilling.',
    use: 'Facade brackets and posts on existing or primary steel beams where drilling is not allowed.',
    members: 'Main: I or channel beam (bearing on its flange). Secondary: post / bracket.',
    standards: `${HOLES} Proprietary clamps: capacity from the manufacturer's data (e.g. Lindapter); fabricated clamp plates with packers equal to the flange thickness (typical practice).`,
    keyParams: ['clamp', 't', 'bolt', 'rows', 'clampT'],
    joint: 'beamPost',
    expectedWarnings: [VENT],
    tags: ['Lindapter', 'no drilling', 'clamp'],
  },
  doubleAngle: {
    type: 'doubleAngle',
    category: 'steel',
    summary: 'Angle cleats on both sides of the secondary.',
    use: 'Heavier transoms, outrigger arms and beams; symmetric load path.',
    members: 'Main: mullion / post / beam. Secondary: transom / beam.',
    standards: HOLES,
    keyParams: ['angle', 'bolt', 'bolts', 'slot'],
    joint: 'mullionTransom',
  },
  teeCleat: {
    type: 'teeCleat',
    category: 'steel',
    summary: 'Tee: flange bolted to the main, stem through the secondary.',
    use: 'Transoms on mullions with the stem hidden inside the hollow transom (knife) or on its side.',
    members: 'Main: mullion / post. Secondary: transom / rail.',
    standards: HOLES,
    keyParams: ['tee', 'position', 'bolt', 'bolts'],
    joint: 'mullionTransom',
    expectedWarnings: [MAXSP],
  },
  seatedAngle: {
    type: 'seatedAngle',
    category: 'steel',
    summary: 'Bearing seat angle under the secondary; optional top cleat.',
    use: 'Transoms or beams that bear on the main member — dead load on the seat, erection aid.',
    members: 'Main: mullion / post / column. Secondary: horizontal transom / beam.',
    standards: `${HOLES} Lateral slots in the seat for tolerance.`,
    keyParams: ['angle', 'bolt', 'bolts', 'seatBolts', 'slot', 'topCleat'],
    joint: 'mullionTransom',
  },
  stubBracket: {
    type: 'stubBracket',
    category: 'steel',
    summary: 'Short welded stub with an end plate; secondary bolted end plate to end plate.',
    use: 'Outriggers, fin supports and brackets that stand off the main steel.',
    members: 'Main: column / beam / mullion. Secondary: outrigger / transom.',
    standards: HOLES,
    keyParams: ['stub', 'stubLength', 't', 'bolt', 'rows'],
    joint: 'mullionTransom',
    expectedWarnings: [VENT],
  },
  saddleBracket: {
    type: 'saddleBracket',
    category: 'steel',
    summary: 'U-strap around the mullion with a fork for the secondary.',
    use: 'Transoms or outriggers on mullions without drilling the mullion (or through-bolted).',
    members: 'Main: mullion / post (hollow or open). Secondary: transom / rail.',
    standards: `${HOLES} Packs where the fork is wider than the secondary.`,
    keyParams: ['t', 'tb', 'height', 'bolt', 'mainBolt'],
    joint: 'mullionTransom',
    tags: ['no drilling', 'saddle'],
  },
  shearBlock: {
    type: 'shearBlock',
    category: 'steel',
    summary: 'Block or twin plates welded to the main face inside the hollow secondary.',
    use: 'Hidden transom joints (stick-system look); thermal slot in the transom for movement.',
    members: 'Main: mullion. Secondary: hollow transom (RHS / SHS).',
    standards: `${HOLES} Clearance inside the hollow section allows for galvanizing (typical practice: ≥ 2 mm a side).`,
    keyParams: ['variant', 'length', 'clearance', 'bolt', 'slot'],
    joint: 'mullionTransom',
    tags: ['spigot', 'hidden'],
  },
  endCap: {
    type: 'endCap',
    category: 'steel',
    summary: 'Seal-welded cap over a free hollow-section end.',
    use: 'Tops of mullions and posts, free ends of outriggers and rails.',
    members: 'Supported: hollow member with a free end.',
    standards: 'Galvanized closed sections need vent / drain holes (EN ISO 14713-2 guidance, ASTM A385) — add a vent hole or drill the section.',
    keyParams: ['t', 'overhang', 'shape', 'vent'],
    joint: 'freeEnd',
    expectedWarnings: [VENT],
  },

  // --- Splices --------------------------------------------------------------
  splicePlates: {
    type: 'splicePlates',
    category: 'splice',
    summary: 'Cover plates either side, through-bolted to both members.',
    use: 'Mullion stack joints and long rails; slotted for movement on one side.',
    members: 'Two collinear members.',
    standards: HOLES,
    keyParams: ['t', 'length', 'bolt', 'bolts', 'slot', 'gap'],
    joint: 'spliceStack',
  },
  endPlateSplice: {
    type: 'endPlateSplice',
    category: 'splice',
    summary: 'End plates welded to both members, bolted together.',
    use: 'Shop-fabricated post and mullion splices; rigid, with optional shim pack.',
    members: 'Two collinear members.',
    standards: HOLES,
    keyParams: ['t', 'layout', 'bolt', 'rows', 'pack'],
    joint: 'spliceStack',
    expectedWarnings: [VENT],
  },
  sleeveSplice: {
    type: 'sleeveSplice',
    category: 'splice',
    summary: 'Internal spigot across a movement gap — fixed or sliding (slotted sleeve).',
    use: 'Mullion stack joints with thermal / slab-deflection movement; hidden splice.',
    members: 'Two collinear hollow members (RHS / SHS / CHS).',
    standards: `${HOLES} Movement gap from the project movement settings; sleeve clearance allows for galvanizing (typical practice).`,
    keyParams: ['mode', 'sleeve', 'length', 'gap', 'bolt', 'slot'],
    joint: 'spliceStack',
    tags: ['movement joint', 'spigot', 'sleeve'],
  },

  // --- Bracing --------------------------------------------------------------
  gussetPlate: {
    type: 'gussetPlate',
    category: 'bracing',
    summary: 'Gusset welded to the main member; flat, angle or tube (knife plate) brace bolted on.',
    use: 'Wind bracing of facade frames, canopy and screen bracing.',
    members: 'Main: column / beam / mullion. Secondary: brace (FL, L, CHS, RHS).',
    standards: `${HOLES} Gusset outline keeps every edge distance by construction; tube slot length = knife insert (typical practice).`,
    keyParams: ['t', 'bolt', 'bolts', 'slot', 'knifeT', 'insert'],
    joint: 'columnBrace',
    previewProfiles: ['FL 60x8', 'L 60x60x6', 'CHS 48.3x3.2', 'CHS 60.3x4'],
  },
  crossBrace: {
    type: 'crossBrace',
    category: 'bracing',
    summary: 'Centre plate at the crossing of X-bracing.',
    use: 'Flat or angle X-bracing in facade frames and screens.',
    members: 'Two crossing braces (one continuous, or all split at the crossing).',
    standards: HOLES,
    keyParams: ['t', 'bolt', 'bolts', 'gap'],
    joint: 'crossBrace',
    previewProfiles: ['FL 60x8', 'FL 80x10', 'L 60x60x6'],
  },

  // --- Hangers & ties -------------------------------------------------------
  hangerRod: {
    type: 'hangerRod',
    category: 'hanger',
    summary: 'Rod end on a welded lug: fork (pinned) or welded tab (bolted, slotted).',
    use: 'Hung facades, canopies and soffit frames suspended from primary steel.',
    members: 'Main: supporting beam. Secondary: hanger rod (RD) or tube.',
    standards: `${HOLES} Pin holes sized as bolt holes; proprietary tension-rod systems by their supplier (typical practice).`,
    keyParams: ['variant', 'bolt', 'lugT', 'slot'],
    joint: 'hanger',
    previewProfiles: ['RD 20', 'RD 24', 'CHS 48.3x3.2'],
    tags: ['tension rod', 'clevis'],
  },
  tieBack: {
    type: 'tieBack',
    category: 'hanger',
    summary: 'Tie-back strut end on a lug: tongue in the slotted tube or fork on an end cap.',
    use: 'Struts restraining facade frames back to the main structure; slotted lug for length adjustment.',
    members: 'Main: mullion / column / beam. Secondary: strut (CHS / RHS / FL).',
    standards: `${HOLES} Tongue insert = tube slot length (typical practice).`,
    keyParams: ['variant', 'bolt', 'slot', 'plateT', 'insert'],
    joint: 'mullionStrut',
    previewProfiles: ['CHS 60.3x4', 'CHS 48.3x3.2', 'SHS 60x60x4'],
    expectedWarnings: [VENT],
  },

  // --- Custom -----------------------------------------------------------------
  custom: {
    type: 'custom',
    category: 'custom',
    summary: 'Formula-driven plates and bolt groups from your template library.',
    use: 'Office standards and project-specific details.',
    members: 'Per template: main + secondary (steel to steel) or secondary only (steel to concrete).',
    standards: 'Checked like every other connection once applied.',
    keyParams: ['template'],
    joint: 'mullionTransom',
  },
};

export function jointKindFor(type: ConnectionType, params: Record<string, ParamValue>): JointKind {
  const j = CATALOG[type]?.joint ?? 'mullionTransom';
  return typeof j === 'function' ? j(params) : j;
}

/** Search the catalogue by name, summary, use, tags (case-insensitive, all words must match). */
export function searchCatalog(q: string, labels: Partial<Record<ConnectionType, string>> = {}): CatalogEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return Object.values(CATALOG).filter((e) => {
    const hay = [labels[e.type] ?? '', e.type, e.summary, e.use, e.members, ...(e.tags ?? [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
