/**
 * Core data model. Everything is plain JSON so a project can be saved, diffed,
 * and snapshotted for undo/redo without custom serialisation.
 *
 * Units: millimetres and degrees. World axes: X east, Y north, Z up.
 */

export type Id = string;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A wireframe vertex. */
export interface WireNode {
  id: Id;
  p: Vec3;
}

export type MemberRole =
  | 'mullion'
  | 'transom'
  | 'post'
  | 'rail'
  | 'bracket'
  | 'outrigger'
  | 'brace'
  | 'beam'
  | 'other';

export const MEMBER_ROLES: MemberRole[] = [
  'mullion',
  'transom',
  'post',
  'rail',
  'bracket',
  'outrigger',
  'brace',
  'beam',
  'other',
];

export type Finish = 'none' | 'hdg' | 'paint' | 'hdg+paint';

/** -1 = line at the section's negative edge, 0 = centre, 1 = positive edge. */
export type Align = -1 | 0 | 1;

/**
 * A wireframe line. With `profile === null` it is a pure construction line;
 * once a profile is assigned it becomes a steel member.
 */
export interface Member {
  id: Id;
  start: Id;
  end: Id;
  profile: string | null;
  material: string;
  role: MemberRole;
  /** Rotation of the section about the member axis, degrees. */
  rotation: number;
  /** Where the wireframe line sits on the section (local y / local z). */
  alignY: Align;
  alignZ: Align;
  /** Extra offset of the section from the line, local y / z, mm. */
  offsetY: number;
  offsetZ: number;
  /** Positive extends the member past its node, negative cuts it back (mm). */
  startExt: number;
  endExt: number;
  finish: Finish;
  /** Optional source layer (DXF import) or user tag. */
  layer?: string;
  name?: string;
  /** End preparations (cuts, mitres, copes, fitting). Absent = square cut. */
  startPrep?: EndPrep;
  endPrep?: EndPrep;
  /** Erection phase (Project.phases id), zone tag and delivery batch (Project.batches id). */
  phase?: Id;
  zone?: string;
  batch?: Id;
  /** Manual assembly mark; overrides automatic numbering for this member's assembly. */
  markOverride?: string;
}

// ---------------------------------------------------------------------------
// End preparations (modelling)

export type EndPrepKind = 'square' | 'bevel' | 'mitre' | 'cope' | 'fit';

/**
 * How a member end is prepared. Angles are saw angles from square, degrees
 * (DSTV convention, |angle| < 90):
 * `angleWeb` is the cut seen in the web / side view (local x–z plane, so the cut
 * plane turns about local y); positive makes the top (+z) edge shorter at that end.
 * `angleFlange` is the cut seen from above (local x–y plane, turning about local z);
 * positive makes the +y edge shorter at that end.
 */
export interface EndPrep {
  kind: EndPrepKind;
  angleWeb?: number;
  angleFlange?: number;
  /** Member the end is mitred against or fitted to. */
  to?: Id;
  /** Cope (notch) size for 'cope': depth into the section and length along the member, mm. */
  copeDepth?: number;
  copeLength?: number;
  /** Which flange is coped: +z (top) / -z (bottom) / both. */
  copeSide?: 'top' | 'bottom' | 'both';
  /** Re-entrant corner radius of the cope, mm (default 15, ≥ 13 mm per AISC 360 J1.6). */
  copeRadius?: number;
  /** Gap left at the end, mm (fit / mitre). */
  gap?: number;
}

export type ConnectionType =
  | 'baseplate'
  | 'slabBracket'
  | 'finPlate'
  | 'angleCleat'
  | 'endPlate'
  | 'welded'
  | 'splicePlates'
  | 'custom';

export type ParamValue = number | string | boolean;

/** A parametric connection placed at a node. */
export interface Connection {
  id: Id;
  type: ConnectionType;
  node: Id;
  /** The supporting member (null when the support is concrete / a reference model). */
  main: Id | null;
  /** The supported member(s). */
  secondary: Id[];
  params: Record<string, ParamValue>;
}

/** A named parameter set for a connection type, applied to selected connections or members. */
export interface ConnectionPreset {
  id: Id;
  name: string;
  type: ConnectionType;
  params: Record<string, ParamValue>;
}

/**
 * A plate in a custom connection. Values are formulas over the template's
 * parameters and the joint variables (h_sec, b_sec, h_main, b_main, depth_main …),
 * in the secondary member's end frame: u along the secondary away from the main
 * face, v across (local y), w up (local z).
 */
export interface CustomPlate {
  key: string;
  name: string;
  /** Plate lies across the member end (normal u), on a side (normal v) or on top (normal w). */
  plane: 'end' | 'side' | 'top';
  t: string;
  /** Size along the plate's first axis (v for end plates, u otherwise) and second axis (w, or v for top). */
  width: string;
  height: string;
  /** Contact plane / corner position in the end frame. */
  u: string;
  v: string;
  w: string;
  /** Shop weld: to the main member, the secondary member, another plate key, or none (loose). */
  weldTo: 'main' | 'secondary' | 'none' | string;
  bolts?: {
    size: string;
    grade: string;
    rows: string;
    cols: string;
    /** Spacing along the plate height / width axis. */
    pitch: string;
    gauge: string;
    /** What the bolts go through besides the plate. 'concrete' makes them anchors. */
    through: 'main' | 'secondary' | 'none' | 'concrete';
    /** Extra slot length (0 = round holes) and slot direction: along width or height. */
    slot?: string;
    slotAlong?: 'width' | 'height';
    anchorLength?: string;
  };
}

export interface CustomTemplate {
  id: Id;
  name: string;
  description: string;
  /** Joint to a supporting member (else the plates bear on concrete or a reference). */
  needsMain: boolean;
  params: { key: string; label: string; default: number }[];
  /** Cut-back of the secondary from the main face (or the node). */
  cut: string;
  plates: CustomPlate[];
}

export interface ProjectLibrary {
  presets: ConnectionPreset[];
  templates: CustomTemplate[];
  /** User or catalogue-imported profile definitions (see core/library). */
  profiles: Record<string, unknown>[];
}

export interface GridLine {
  id: Id;
  name: string;
  /** 'x' grids are lines of constant X, 'y' grids are lines of constant Y. */
  axis: 'x' | 'y';
  pos: number;
}

export interface Level {
  id: Id;
  name: string;
  z: number;
}

export type PlaneKind = 'XY' | 'XZ' | 'YZ';

/**
 * XY: plan at z = offset; XZ: elevation at y = offset; YZ: elevation at x = offset;
 * custom: a NamedWorkPlane (`planeId`), shifted by `offset` along its normal. Custom
 * planes carry a copy of their axes so geometry helpers need no project lookup.
 */
export interface WorkPlane {
  kind: PlaneKind | 'custom';
  offset: number;
  planeId?: Id;
  origin?: Vec3;
  xAxis?: Vec3;
  yAxis?: Vec3;
}

/** A user work plane: origin and in-plane axes (unit vectors, x ⟂ y). Normal = x × y. */
export interface NamedWorkPlane {
  id: Id;
  name: string;
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
}

// ---------------------------------------------------------------------------
// Free plates, bent plates and stiffeners (first-class parts)

export interface PlateBend {
  /** Bend line in outline coordinates (from a to b). */
  a: Vec2;
  b: Vec2;
  /** Bend angle in degrees (positive folds towards +z of the plate), inner radius mm. */
  angle: number;
  radius: number;
}

export interface FreePlate {
  id: Id;
  name: string;
  kind: 'plate' | 'bent' | 'stiffener';
  /** Plate coordinate system in world space; the plate occupies local z ∈ [0, t]. */
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  /** Flat (unfolded) outline, counter-clockwise, in plate x/y. */
  outline: Vec2[];
  t: number;
  material: string;
  finish: Finish;
  holes: { x: number; y: number; d: number; slot?: number; angle?: number }[];
  bends: PlateBend[];
  /** Member this plate is shop-welded to (makes it part of that member's assembly). */
  weldedTo?: Id;
  phase?: Id;
  batch?: Id;
  /** Neutral-axis K-factor for the flat pattern of bent plates (default 0.33). */
  kFactor?: number;
}

// ---------------------------------------------------------------------------
// Movement, tolerances and site survey

export interface ToleranceItem {
  id: Id;
  name: string;
  /** ± deviation, mm. */
  value: number;
  /** Direction it acts in, relative to the facade: along it, vertical, or out of plane. */
  direction: 'along' | 'vertical' | 'out';
  /** Where the value comes from (standard clause, spec). */
  source?: string;
  /**
   * What the tolerance belongs to: the supporting structure (slab, anchors — absorbed by
   * the slab brackets and replaced by the survey where one is matched) or the steel
   * (fabrication / erection — applies at every joint). Absent: inferred from the name.
   */
  scope?: 'structure' | 'steel';
}

export interface MovementSettings {
  /** Steel temperature at installation and design extremes, °C. */
  tempInstall: number;
  tempMin: number;
  tempMax: number;
  /** Vertical slab-edge deflection the brackets must accommodate (live load + creep), mm. */
  slabDeflection: number;
  /** In-plane inter-storey drift, mm. */
  storeyDrift: number;
  /** Combine tolerances by straight sum or root-sum-square. */
  combine: 'linear' | 'rss';
  tolerances: ToleranceItem[];
  /** Auto slot lengths are rounded up to this increment, mm (default 5). */
  slotIncrement?: number;
  /** Extra clearance added to every derived slot / gap, mm (default 0). */
  slotMargin?: number;
  /** Smallest auto stack-joint gap, mm (default 10). */
  minGap?: number;
  /** ± accuracy of the site survey; replaces the structure tolerances where a bracket is matched, mm (default 3). */
  surveyAccuracy?: number;
}

/** A surveyed point on the as-built structure (e.g. slab edge), with an optional design position. */
export interface SurveyPoint {
  id: Id;
  name: string;
  p: Vec3;
  design?: Vec3;
}

export interface SurveySet {
  points: SurveyPoint[];
  /** Brackets are matched to the nearest survey point within this distance, mm. */
  matchRadius: number;
  source?: string;
  importedAt?: string;
  /**
   * Use the along-facade deviation too (only meaningful when the points mark anchor /
   * channel positions rather than any point on the slab edge). Default false.
   */
  applyAlong?: boolean;
  /** Made-to-measure adjustments are rounded to this step, mm (default 5). */
  adjustStep?: number;
}

// ---------------------------------------------------------------------------
// Phases, delivery batches, mark locking, clashes

export interface Phase {
  id: Id;
  name: string;
  /** Erection order (1 = first). */
  sequence: number;
  color?: string;
}

export interface DeliveryBatch {
  id: Id;
  name: string;
  date?: string;
  phase?: Id;
  notes?: string;
}

export interface ClashIssue {
  id: Id;
  /** BCF topic GUID. */
  guid: string;
  title: string;
  kind: 'hard' | 'clearance';
  status: 'open' | 'resolved' | 'ignored';
  /** Part refs / reference element ids involved. */
  a: string;
  b: string;
  pos: Vec3;
  /** Penetration depth (hard) or gap (clearance), mm. */
  distance: number;
  created: string;
  comment?: string;
}

export interface ClashSettings {
  /** Required clearance to reference elements, mm. */
  clearance: number;
  issues: ClashIssue[];
}

/** An imported reference model (concrete, primary steel). Bytes live in IndexedDB. */
export interface ReferenceModel {
  id: Id;
  name: string;
  kind: 'ifc' | 'dxf';
  visible: boolean;
  opacity: number;
  /** Translation applied to the reference geometry, mm. */
  offset: Vec3;
  /** For DXF linework: which plane the 2D drawing is placed on. */
  plane?: WorkPlane;
  scale?: number;
}

/** A PDF page or image used to trace shop drawings. Bytes live in IndexedDB. */
export interface Underlay {
  id: Id;
  name: string;
  kind: 'pdf' | 'image';
  page: number;
  plane: WorkPlane;
  /** Position of the image's bottom-left corner in plane coordinates (mm). */
  origin: Vec2;
  /** Millimetres per image pixel. */
  mmPerPx: number;
  rotation: number;
  opacity: number;
  visible: boolean;
}

export interface AutoAssignRule {
  /** Match lines by direction and/or DXF layer name. */
  match: 'vertical' | 'horizontal' | 'inclined' | 'layer';
  layer?: string;
  profile: string;
  role: MemberRole;
  rotation?: number;
}

export interface ProjectSettings {
  /** Stock bar lengths for cut optimisation, mm. */
  stockLengths: number[];
  /** Saw blade width, mm. */
  kerf: number;
  /** Waste trimmed from each bar end, mm. */
  endTrim: number;
  /** Stock plate sheets for plate nesting, mm. */
  plateSheets: { w: number; h: number }[];
  plateSpacing: number;
  defaultMaterial: string;
  defaultFinish: Finish;
  /** Assembly mark prefix per role (e.g. mullion → "M"). */
  assemblyPrefix: Record<MemberRole, string>;
  /** Prefix for loose connection assemblies such as brackets. */
  bracketPrefix: string;
  autoRules: AutoAssignRule[];
  gridStep: number;
  /** Code used for detailing checks and defaults; 'auto' follows the profile library in use. */
  designCode: 'auto' | 'AISC360' | 'EC3';
  movement: MovementSettings;
  /** Galvanizing bath inside dimensions, mm (dip size checks). */
  galvBath: { length: number; width: number; depth: number };
  /** Stock on hand for nesting; qty -1 = unlimited. Empty = use stockLengths. */
  stock: StockItem[];
  /** Fabrication outputs (labels, CNC DXF, paint, dip checks); missing keys use defaults (core/fabrication/settings). */
  fabrication?: Partial<FabricationSettings>;
}

export interface StockItem {
  profile: string;
  length: number;
  qty: number;
  material?: string;
}

export type LabelLayout = 'a4-3x8' | 'a4-2x7' | 'thermal-100x50';

export interface PaintCoat {
  name: string;
  /** Dry film thickness, µm. */
  dft: number;
  /** Volume solids, %. */
  solids: number;
}

export interface FabricationSettings {
  /** Write the part mark on a MARKING layer in plate DXF (ink-jet / etch marking). */
  dxfMarking: boolean;
  /** Marking text height, mm. */
  markHeight: number;
  /** Laser / plasma kerf added to the plate spacing when nesting, mm. */
  plateKerf: number;
  labelLayout: LabelLayout;
  /** One label per physical piece or one per unique mark. */
  labelPer: 'piece' | 'mark';
  /** Free space kept in the galvanizing bath on every dimension, mm. */
  galvClearance: number;
  /** Coating system for painted parts (paint and HDG + paint). */
  paintCoats: PaintCoat[];
  /** Application loss, % (0 = theoretical consumption). */
  paintLoss: number;
}

// ---------------------------------------------------------------------------
// Drawings

/** ISO: first-angle projection, ISO 2553 welds, EN 1090-2 notes. ASME: third-angle, AWS A2.4 welds, AISC 303 notes. */
export type DrawingStandard = 'ISO' | 'ASME';
export type SheetSize = 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
/** ISO 7200 document status. */
export type DocStatus = 'In preparation' | 'In approval' | 'Released' | 'Withdrawn';

export interface DrawingSettings {
  standard: DrawingStandard;
  /** Sheet for part and assembly drawings / for GA drawings. */
  sheet: SheetSize;
  gaSheet: SheetSize;
  /** Prefix of drawing numbers (defaults to the project number). */
  numberPrefix: string;
  /** EN 1090-2 execution class. */
  executionClass: string;
  /** Default fillet weld throat (ISO) / leg (ASME), mm, and process (ISO 4063 number). */
  weldSize: number;
  weldProcess: string;
  legalOwner: string;
  checkedBy: string;
  approvedBy: string;
  /** Revision index style: A, B, C… (ISO 7200) or 0, 1, 2… */
  revisionScheme: 'alpha' | 'numeric';
  /** Extra general notes printed on every drawing. */
  extraNotes: string[];
  /** Include erection drawings (setting-out plans, anchor schedules, erection sequences) in the set. Default on. */
  erection?: boolean;
}

export interface DrawingRevision {
  rev: string;
  date: string;
  description: string;
  drawn: string;
  checked: string;
  approved: string;
  status: DocStatus;
  /** Content hash at issue — used to detect drawings changed since the last issue. */
  fingerprint: string;
}

export interface DrawingSet {
  settings: DrawingSettings;
  /** Revision history keyed by drawing id (e.g. "asm-M1", "part-m1", "ga-front"). */
  revisions: Record<string, DrawingRevision[]>;
  /** Manual edits per drawing id, applied on top of the generated sheet. */
  edits: Record<string, DrawingEdits>;
  /** User section cuts and detail callouts in the GA. */
  cuts: GaCut[];
  /** Company sheet templates; the active one is used for every sheet. */
  templates: SheetTemplate[];
  activeTemplate?: Id;
}

/** Manual drawing edits. Keys are stable ids of generated views / dimensions. */
export interface DrawingEdits {
  /** View offsets on the sheet, mm. */
  views: Record<string, Vec2>;
  /** Dimension line offsets (perpendicular shift), mm. */
  dims: Record<string, number>;
  /** Generated items the user removed. */
  hidden: string[];
  notes: { id: Id; p: Vec2; text: string; h?: number; leader?: Vec2 }[];
  clouds: { id: Id; pts: Vec2[]; rev: string }[];
}

/** A section cut or detail callout placed on the GA. */
export interface GaCut {
  id: Id;
  name: string;
  kind: 'section' | 'detail';
  /**
   * Section: cut line in world space (a → b) and look depth; detail: centre and radius.
   * For details `a` is the centre and `depth` the radius (model mm); `b` is not used.
   */
  a: Vec3;
  b: Vec3;
  depth: number;
  /** View scale denominator (ISO 5455), 0 = automatic. */
  scale: number;
  /** GA view the cut is drawn on (default the front elevation). */
  view?: 'front' | 'plan' | 'side';
  /** Section: look the other way (arrows reversed). */
  flip?: boolean;
}

/** A company sheet template: title block layout, logo and fixed notes. */
export interface SheetTemplate {
  id: Id;
  name: string;
  /**
   * Title block fields: label and value source (project field or fixed text), in grid cells
   * (`grid` mm each; column 0 at the left edge, row 0 at the bottom edge). Source is one of
   * the field sources in core/drawings/template.ts, or "text:<fixed text>". Optional value
   * style: lettering height (ISO 3098), bold, baseline above the cell bottom (mm).
   */
  fields: { label: string; source: string; col: number; row: number; w: number; h: number; textH?: number; bold?: boolean; dy?: number }[];
  /** Title block width / height, mm. */
  width: number;
  height: number;
  /** Grid cell size, mm (default 1). */
  grid?: number;
  /** Logo as data URL (PNG/SVG), placed in the title block. */
  logo?: string;
  notes: string[];
}

export interface ProjectInfo {
  name: string;
  number: string;
  client: string;
  designer: string;
}

export interface Project {
  version: 1;
  id: Id;
  info: ProjectInfo;
  nodes: Record<Id, WireNode>;
  members: Record<Id, Member>;
  connections: Record<Id, Connection>;
  grids: GridLine[];
  levels: Level[];
  references: ReferenceModel[];
  underlays: Underlay[];
  settings: ProjectSettings;
  drawings: DrawingSet;
  library: ProjectLibrary;
  workPlanes: NamedWorkPlane[];
  plates: Record<Id, FreePlate>;
  survey: SurveySet;
  phases: Phase[];
  batches: DeliveryBatch[];
  /** Locked marks: assembly/part signature → mark, kept stable through renumbering. */
  markLocks: Record<string, string>;
  clashes: ClashSettings;
}
