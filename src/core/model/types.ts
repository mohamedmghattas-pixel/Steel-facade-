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
}

export type ConnectionType =
  | 'baseplate'
  | 'slabBracket'
  | 'finPlate'
  | 'angleCleat'
  | 'endPlate'
  | 'welded';

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

/** XY: plan at z = offset; XZ: elevation at y = offset; YZ: elevation at x = offset. */
export interface WorkPlane {
  kind: PlaneKind;
  offset: number;
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
}
