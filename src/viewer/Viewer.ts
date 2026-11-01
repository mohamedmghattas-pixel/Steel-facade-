import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Id, Project, Vec3, WorkPlane } from '../core/model/types';
import type { DerivedModel, Part } from '../core/derive/model';
import { planeAxes, planeToWorld, worldToPlane, lerp, dist, add, sub, scale, normalize, madd } from '../core/model/geometry';
import type { Selection, SnapSettings, Tool, ViewName } from '../state/store';
import {
  ROLE_COLORS,
  SELECT_COLOR,
  alongMatrix,
  cachedGeometries,
  disposeObject,
  geometryForKey,
  headGeo,
  headGeoCoarse,
  instancedEdgeMaterial,
  instancedEdges,
  isUnitLinearKey,
  linearMatrix,
  partGeometryKey,
  plateMatrix,
  shankGeo,
  shankGeoCoarse,
  v,
} from './meshes';
import { arcFrom3Points, arcPoints } from '../core/geometry/arc';
import { getBolt } from '../core/library/bolts';
import { groupColors, type ColorBy } from '../core/management/grouping';
import { FrustumTest, SpatialIndex } from './spatial';

/** Above this many parts, edges are not drawn (GPU line cost). */
const EDGE_PART_LIMIT = 20000;
/** Above this many parts, profiles are drawn with sharp corners and plates without holes (level of detail). */
const COARSE_PART_LIMIT = 15000;
/** Above this many members, mark labels are shown for the selection only. */
const LABEL_LIMIT = 1500;

/** One drawn part: where it lives in a render batch and how to pick it. */
interface SolidItem {
  part: Part;
  kind: 'member' | 'connection' | 'plate';
  /** Member id, connection id or free-plate id. */
  id: Id;
  role: keyof typeof ROLE_COLORS;
  batch: RenderBatch;
  /** Instance index (instanced) or item index (merged). */
  slot: number;
  matrix: THREE.Matrix4;
  /** Local geometry (shared) for exact picking, and its edges. */
  geometry: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
}

interface RenderBatch {
  kind: 'instanced' | 'merged';
  mesh: THREE.InstancedMesh | THREE.Mesh;
  items: SolidItem[];
  /** merged: first vertex and vertex count per item, and the colour attribute. */
  ranges?: [number, number][];
  colors?: THREE.BufferAttribute;
}

interface BoltItem {
  connectionId: Id;
  start: Vec3;
  dir: Vec3;
  length: number;
  d: number;
  /** Instance matrices of the shank and head (for the isolated view). */
  shank: THREE.Matrix4;
  head: THREE.Matrix4;
  anchor: boolean;
}

export interface PickHit {
  kind: 'member' | 'connection' | 'node' | 'plate';
  id: Id;
  /** The part hit (solids): its part ref, e.g. one plate of a connection. */
  ref?: string;
}

/** Parts of selected assemblies (Selection.assemblies), and their main parts. */
export const ASSEMBLY_COLOR = 0xff5aa8;
export const ASSEMBLY_MAIN_COLOR = 0xd61f7a;

export interface Display {
  solids: boolean;
  wire: boolean;
  connections: boolean;
  references: boolean;
  underlays: boolean;
  labels: boolean;
  /** Colour parts by role (default), erection phase, delivery batch or zone. */
  colorBy?: ColorBy;
}

/** Pointer state handed to the modify tools: member under the cursor, snapped point, pick ray. */
export interface ToolPointerInfo {
  member: Id | null;
  point: Vec3 | null;
  kind: string;
  ray: { origin: Vec3; dir: Vec3 } | null;
  shift: boolean;
}

export interface ViewerCallbacks {
  getState(): { tool: Tool; snap: SnapSettings; workPlane: WorkPlane; gridStep: number };
  /** A click in the select tool; `alt` = Alt held (select the whole assembly). */
  onPick(hit: PickHit | null, additive: boolean, alt?: boolean): void;
  onBoxSelect(sel: Selection, additive: boolean): void;
  onPoints(tool: Tool, pts: Vec3[]): void;
  onCursor(p: Vec3 | null, kind: string): void;
  onPrompt(text: string): void;
  onToolDone(): void;
  /** Modify tools (isModifyTool): hover, press (true = grabbed, e.g. a Stretch grip) and click. */
  onToolHover?(tool: Tool, info: ToolPointerInfo): void;
  onToolPress?(tool: Tool, info: ToolPointerInfo): boolean;
  onToolClick?(tool: Tool, info: ToolPointerInfo): void;
  /** Right click without dragging (context menu). */
  onContextMenu?(hit: PickHit | null, clientX: number, clientY: number, info: ToolPointerInfo): void;
  /** Whether a tool is handled through the modify-tool callbacks. */
  isModifyTool?(tool: Tool): boolean;
}

type SnapKind = 'end' | 'mid' | 'node' | 'ref' | 'grid' | 'plane';
interface Snap {
  p: Vec3;
  kind: SnapKind;
}

const PROMPTS: Partial<Record<Tool, string[]>> = {
  line: ['Pick start point (or type x,y,z / u,v)', 'Pick end point (or type a length)'],
  polyline: ['Pick start point', 'Pick next point · Esc or double-click to finish'],
  move: ['Pick base point', 'Pick target point'],
  copy: ['Pick base point', 'Pick target point'],
  measure: ['Pick first point', 'Pick second point'],
  calibrate: ['Pick first known point on the underlay', 'Pick second known point'],
  plate: ['Pick the first corner of the plate', 'Pick the next corner', 'Pick the next corner · double-click, click the first corner or type c to close'],
  arc: ['Pick the arc start point', 'Pick the arc end point', 'Pick a point on the arc'],
  plane3: ['Pick the work plane origin', 'Pick a point on the plane x axis', 'Pick a third point in the plane (+y side)'],
};

/** Points a tool collects before it fires; polyline / plate keep going. */
const TOOL_POINTS: Partial<Record<Tool, number>> = { arc: 3, plane3: 3, plate: Infinity };

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  camera: THREE.Camera;
  private controlsP: OrbitControls;
  private controlsO: OrbitControls;
  private container: HTMLElement;
  private cb: ViewerCallbacks;

  private memberGroup = new THREE.Group();
  private connGroup = new THREE.Group();
  private wireGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private planeGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  readonly refGroup = new THREE.Group();
  readonly underlayGroup = new THREE.Group();

  private solids: SolidItem[] = [];
  private batches: RenderBatch[] = [];
  private bolts: BoltItem[] = [];
  private memberItems = new Map<Id, SolidItem[]>();
  private connItems = new Map<Id, SolidItem[]>();
  /** Free / bent plates and stiffeners (Project.plates): modelled objects drawn with the members. */
  private plateItems = new Map<Id, SolidItem[]>();
  /** Every drawn part by part ref (assembly highlight, isolation, focus). */
  private refItems = new Map<string, SolidItem[]>();
  /** Parts of the selected assemblies and their main parts (painted in the assembly colours). */
  private asmRefs = new Set<string>();
  private asmMains = new Set<string>();
  /** Isolated parts (only these are drawn and pickable), or null. */
  private isoRefs: Set<string> | null = null;
  private isoOwners: { members: Set<Id>; plates: Set<Id>; connections: Set<Id> } | null = null;
  private isoGroup = new THREE.Group();
  private isoMats: THREE.Material[] = [];
  private ownedGeoms: THREE.BufferGeometry[] = [];
  private dirtyBatches = new Set<RenderBatch>();
  private paintedSel = { members: new Set<Id>(), connections: new Set<Id>(), plates: new Set<Id>() };
  private groupColor: ((key: string | undefined) => number) | null = null;
  private tmpColor = new THREE.Color();
  private wireIds: Id[] = [];
  private wireSegs: [Vec3, Vec3][] = [];
  private wireSel: THREE.LineSegments | null = null;
  private nodeIndex: SpatialIndex | null = null;
  private wireIndex: SpatialIndex | null = null;
  private solidIndex: SpatialIndex | null = null;
  private refIndex: SpatialIndex | null = null;
  private nodeConns = new Map<Id, Id[]>();
  private labelsBuilt = false;
  private dm: DerivedModel | null = null;
  private marker3d: THREE.Object3D | null = null;
  private wireOverlay: THREE.Object3D | null = null;
  private solidMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.25, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private solidVcMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.25, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private instEdgeMat = instancedEdgeMaterial(0x1b2430, 0.55);
  private tmpMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  private edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.55 });
  private wireMat = new THREE.LineDashedMaterial({ color: 0x8a96a8, dashSize: 60, gapSize: 40 });
  private wireAssignedMat = new THREE.LineBasicMaterial({ color: 0x51627a });
  private wireSelMat = new THREE.LineBasicMaterial({ color: SELECT_COLOR });
  private nodeMat = new THREE.PointsMaterial({ color: 0x9fb3c8, size: 5, sizeAttenuation: false });
  private boltMat = new THREE.MeshStandardMaterial({ color: 0x5a616b, metalness: 0.6, roughness: 0.4 });

  private project: Project | null = null;
  private selection: Selection = { members: [], nodes: [], connections: [] };
  private display: Display = { solids: true, wire: true, connections: true, references: true, underlays: true, labels: false };
  private nodeList: { id: Id; p: Vec3 }[] = [];
  private refPoints: Vec3[] = [];

  private pending: Vec3[] = [];
  private lastCursor: Snap | null = null;
  private rubber: THREE.Line;
  private preview: THREE.Line;
  private marker: HTMLDivElement;
  private boxDiv: HTMLDivElement;
  private down: { x: number; y: number; button: number; shift: boolean } | null = null;
  /** Right-button press (context menu when released without dragging). */
  private rdown: { x: number; y: number } | null = null;
  /** A modify tool grabbed something on press (Stretch grip): the release is the target. */
  private grabbed = false;
  private toolOverlay: THREE.Object3D | null = null;
  private raf = 0;
  private dirty = true;
  private ro: ResizeObserver;
  private lastClick = 0;

  constructor(container: HTMLElement, cb: ViewerCallbacks) {
    this.container = container;
    this.cb = cb;
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.persp = new THREE.PerspectiveCamera(45, 1, 10, 5e6);
    this.persp.up.set(0, 0, 1);
    this.persp.position.set(12000, -16000, 9000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5e6, 5e6);
    this.ortho.up.set(0, 0, 1);
    this.ortho.position.set(0, -20000, 0);
    this.camera = this.persp;

    const mk = (cam: THREE.Camera) => {
      const c = new OrbitControls(cam, this.renderer.domElement);
      c.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
      c.enableDamping = false;
      c.zoomToCursor = true;
      c.screenSpacePanning = true;
      c.addEventListener('change', () => this.requestRender());
      return c;
    };
    this.controlsP = mk(this.persp);
    this.controlsO = mk(this.ortho);
    this.controlsO.enabled = false;

    this.scene.add(new THREE.HemisphereLight(0xeef3ff, 0x30343a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.4, -0.7, 1);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-0.6, 0.5, -0.3);
    this.scene.add(fill);
    this.scene.add(this.underlayGroup, this.planeGroup, this.refGroup, this.wireGroup, this.memberGroup, this.connGroup, this.isoGroup, this.helperGroup, this.labelGroup);
    this.isoGroup.visible = false;

    const rubberGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.rubber = new THREE.Line(rubberGeo, new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false }));
    this.rubber.renderOrder = 10;
    this.rubber.visible = false;
    this.helperGroup.add(this.rubber);
    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false, transparent: true, opacity: 0.8 }));
    this.preview.renderOrder = 10;
    this.preview.visible = false;
    this.helperGroup.add(this.preview);

    this.marker = document.createElement('div');
    this.marker.className = 'snap-marker';
    container.appendChild(this.marker);
    this.boxDiv = document.createElement('div');
    this.boxDiv.className = 'box-select';
    container.appendChild(this.boxDiv);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerleave', () => {
      this.marker.style.display = 'none';
      this.cb.onCursor(null, '');
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) this.rdown = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 2 || !this.rdown) return;
      const moved = Math.abs(e.clientX - this.rdown.x) > 4 || Math.abs(e.clientY - this.rdown.y) > 4;
      this.rdown = null;
      if (!moved && this.cb.onContextMenu) this.cb.onContextMenu(this.pick(e), e.clientX, e.clientY, this.toolInfo(e));
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controlsP.dispose();
    this.controlsO.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }

  requestRender() {
    this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const half = (this.ortho.top - this.ortho.bottom) / 2 || 10000;
    this.ortho.left = (-half * w) / h;
    this.ortho.right = (half * w) / h;
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Model content

  setModel(p: Project, dm: DerivedModel) {
    this.project = p;
    this.dm = dm;
    this.clearModel();
    this.nodeList = Object.values(p.nodes).map((n) => ({ id: n.id, p: n.p }));
    this.buildWires(p);
    if (this.nodeList.length) {
      const pts = new THREE.BufferGeometry().setFromPoints(this.nodeList.map((n) => v(n.p)));
      this.wireGroup.add(new THREE.Points(pts, this.nodeMat));
    }
    this.buildSolids(p, dm);
    this.buildBolts(dm, dm.parts.length > COARSE_PART_LIMIT);
    this.buildIndexes(p);
    this.labelsBuilt = false;
    this.asmRefs = this.assemblyRefs(this.selection);
    this.buildIsolation();
    this.applyDisplay();
    this.applySelection(true);
    this.requestRender();
  }

  /** Remove model objects; dispose what this viewer created (shared profile geometries stay cached). */
  private clearModel() {
    const keep = cachedGeometries();
    for (const g of [this.memberGroup, this.connGroup, this.wireGroup, this.labelGroup]) {
      for (const c of [...g.children]) {
        if (c instanceof CSS2DObject) c.element.remove();
        if (c instanceof THREE.InstancedMesh) c.dispose();
        else disposeObject(c, keep, false);
        g.remove(c);
      }
    }
    for (const geo of this.ownedGeoms) if (!keep.has(geo)) geo.dispose();
    this.ownedGeoms = [];
    this.solids = [];
    this.batches = [];
    this.bolts = [];
    this.memberItems.clear();
    this.connItems.clear();
    this.plateItems.clear();
    this.refItems.clear();
    this.wireIds = [];
    this.wireSegs = [];
    this.wireSel = null;
    this.paintedSel = { members: new Set(), connections: new Set(), plates: new Set() };
  }

  /** All wire lines in two batched line sets (with / without profile) plus a selection overlay. */
  private buildWires(p: Project) {
    const assigned: number[] = [];
    const plain: number[] = [];
    for (const m of Object.values(p.members)) {
      const a = p.nodes[m.start]?.p;
      const b = p.nodes[m.end]?.p;
      if (!a || !b) continue;
      (m.profile ? assigned : plain).push(a.x, a.y, a.z, b.x, b.y, b.z);
      this.wireIds.push(m.id);
      this.wireSegs.push([a, b]);
    }
    const mk = (arr: number[], mat: THREE.Material, dashed: boolean) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const ls = new THREE.LineSegments(geo, mat);
      if (dashed) ls.computeLineDistances();
      return ls;
    };
    if (assigned.length) this.wireGroup.add(mk(assigned, this.wireAssignedMat, false));
    if (plain.length) this.wireGroup.add(mk(plain, this.wireMat, true));
    this.wireSel = mk([], this.wireSelMat, false);
    this.wireSel.renderOrder = 2;
    this.wireGroup.add(this.wireSel);
  }

  /**
   * Parts with the same geometry signature (meshes.ts partGeometryKey) are one
   * InstancedMesh; geometries used once are merged into one batched mesh per
   * group. Per-part colours live in instance / vertex colours, so selection
   * and colour modes never rebuild geometry.
   */
  private buildSolids(p: Project, dm: DerivedModel) {
    const edgesOn = dm.parts.length <= EDGE_PART_LIMIT;
    const coarse = dm.parts.length > COARSE_PART_LIMIT;
    const groups = new Map<string, { key: string; parts: Part[] }>();
    for (const part of dm.parts) {
      if (part.kind === 'plate' ? !part.outline?.length : !part.shape) continue;
      const key = partGeometryKey(part, part.memberId ? p.members[part.memberId] : undefined);
      const g = groups.get(key);
      if (g) g.parts.push(part);
      else groups.set(key, { key, parts: [part] });
    }
    const singles: { member: SolidItem[]; conn: SolidItem[] } = { member: [], conn: [] };
    const groupOf = (kind: SolidItem['kind']) => (kind === 'connection' ? this.connGroup : this.memberGroup);
    for (const { key, parts } of groups.values()) {
      const geo = geometryForKey(key, parts[0], coarse);
      if (!geo.cached) this.ownedGeoms.push(geo.mesh, geo.edges);
      geo.mesh.computeBoundingBox();
      const unit = isUnitLinearKey(key);
      const items = parts.map((part) => this.solidItem(part, geo.mesh, geo.edges, unit));
      if (parts.length === 1 && !unit) {
        (items[0].kind === 'connection' ? singles.conn : singles.member).push(items[0]);
        continue;
      }
      for (const kind of ['member', 'connection', 'plate'] as const) {
        const its = items.filter((x) => x.kind === kind);
        if (!its.length) continue;
        const mesh = new THREE.InstancedMesh(geo.mesh, this.solidMat, its.length);
        const batch: RenderBatch = { kind: 'instanced', mesh, items: its };
        const mats = new Float32Array(its.length * 16);
        its.forEach((it, i) => {
          it.batch = batch;
          it.slot = i;
          mesh.setMatrixAt(i, it.matrix);
          it.matrix.toArray(mats, i * 16);
        });
        mesh.setColorAt(0, new THREE.Color(0xffffff));
        mesh.computeBoundingSphere();
        this.batches.push(batch);
        const group = groupOf(kind);
        group.add(mesh);
        if (edgesOn) group.add(instancedEdges(geo.edges, mats, this.instEdgeMat));
      }
    }
    for (const [kind, its] of [
      ['member', singles.member],
      ['connection', singles.conn],
    ] as const) {
      if (!its.length) continue;
      this.mergeSingles(its, kind === 'member' ? this.memberGroup : this.connGroup, edgesOn);
    }
  }

  private solidItem(part: Part, geometry: THREE.BufferGeometry, edges: THREE.BufferGeometry, unit: boolean): SolidItem {
    const isMember = part.kind === 'member';
    const isPlate = !!part.plateId;
    const matrix = part.kind === 'plate' ? plateMatrix(part.frame) : linearMatrix(part.frame, unit ? part.length : 1);
    const it: SolidItem = {
      part,
      kind: isPlate ? 'plate' : isMember ? 'member' : 'connection',
      id: (isPlate ? part.plateId : isMember ? part.memberId : part.connectionId) ?? part.ref,
      role: part.role,
      batch: null as unknown as RenderBatch,
      slot: 0,
      matrix,
      geometry,
      edges,
    };
    this.solids.push(it);
    const map = isPlate ? this.plateItems : isMember ? this.memberItems : this.connItems;
    const arr = map.get(it.id);
    if (arr) arr.push(it);
    else map.set(it.id, [it]);
    const byRef = this.refItems.get(part.ref);
    if (byRef) byRef.push(it);
    else this.refItems.set(part.ref, [it]);
    return it;
  }

  /** Geometries used once: merged into one mesh with vertex colours (and one edge set). */
  private mergeSingles(items: SolidItem[], group: THREE.Group, edgesOn: boolean) {
    let vertCount = 0;
    const parts: THREE.BufferGeometry[] = [];
    const edgeParts: number[] = [];
    const ranges: [number, number][] = [];
    for (const it of items) {
      const g = (it.geometry.index ? it.geometry.toNonIndexed() : it.geometry.clone()).applyMatrix4(it.matrix);
      g.deleteAttribute('uv');
      const n = g.getAttribute('position').count;
      ranges.push([vertCount, n]);
      vertCount += n;
      parts.push(g);
      if (edgesOn) {
        const e = it.edges.clone().applyMatrix4(it.matrix);
        const pa = e.getAttribute('position');
        for (let i = 0; i < pa.count; i++) edgeParts.push(pa.getX(i), pa.getY(i), pa.getZ(i));
        e.dispose();
      }
    }
    const pos = new Float32Array(vertCount * 3);
    const nrm = new Float32Array(vertCount * 3);
    let o = 0;
    for (const g of parts) {
      pos.set(g.getAttribute('position').array as Float32Array, o * 3);
      const na = g.getAttribute('normal');
      if (na) nrm.set(na.array as Float32Array, o * 3);
      o += g.getAttribute('position').count;
      g.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const colors = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    merged.setAttribute('color', colors);
    merged.computeBoundingSphere();
    this.ownedGeoms.push(merged);
    const mesh = new THREE.Mesh(merged, this.solidVcMat);
    const batch: RenderBatch = { kind: 'merged', mesh, items, ranges, colors };
    items.forEach((it, i) => {
      it.batch = batch;
      it.slot = i;
    });
    this.batches.push(batch);
    group.add(mesh);
    if (edgesOn && edgeParts.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(edgeParts, 3));
      this.ownedGeoms.push(eg);
      group.add(new THREE.LineSegments(eg, this.edgeMat));
    }
  }

  /** Bolts as instanced meshes (already one draw call each for shanks and heads). */
  private buildBolts(dm: DerivedModel, coarse = false) {
    const bolts = dm.bolts.flatMap((b) => b.positions.map((pos) => ({ b, pos })));
    if (!bolts.length) return;
    const shanks = new THREE.InstancedMesh(coarse ? shankGeoCoarse : shankGeo, this.boltMat, bolts.length);
    const heads = new THREE.InstancedMesh(coarse ? headGeoCoarse : headGeo, this.boltMat, bolts.length);
    const ids: Id[] = [];
    const color = new THREE.Color();
    bolts.forEach(({ b, pos }, i) => {
      const size = getBolt(b.size);
      const shank = alongMatrix(pos, b.dir, size.d, b.length);
      const head = alongMatrix(pos, b.dir, size.af, size.head);
      shanks.setMatrixAt(i, shank);
      heads.setMatrixAt(i, head);
      shanks.setColorAt(i, color.setHex(b.kind === 'anchor' ? 0xb89a62 : 0xffffff));
      ids.push(b.connectionId);
      this.bolts.push({ connectionId: b.connectionId, start: madd(pos, b.dir, -size.head), dir: normalize(b.dir), length: b.length + size.head, d: Math.max(size.af, size.d), shank, head, anchor: b.kind === 'anchor' });
    });
    shanks.computeBoundingSphere();
    heads.computeBoundingSphere();
    shanks.userData = { kind: 'connection', instanceIds: ids };
    heads.userData = { kind: 'connection', instanceIds: ids };
    this.connGroup.add(shanks, heads);
  }

  /** BVHs for snapping / picking / box select (see spatial.ts). */
  private buildIndexes(p: Project) {
    this.nodeIndex = SpatialIndex.points(this.nodeList.map((n) => n.p));
    this.wireIndex = SpatialIndex.segments(this.wireSegs);
    const S = this.solids.length;
    const bounds = new Float64Array((S + this.bolts.length) * 6);
    const box = new THREE.Box3();
    this.solids.forEach((it, i) => {
      box.copy(it.geometry.boundingBox!).applyMatrix4(it.matrix);
      bounds.set([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z], i * 6);
    });
    this.bolts.forEach((b, i) => {
      const e = madd(b.start, b.dir, b.length);
      const r = b.d / 2;
      bounds.set([Math.min(b.start.x, e.x) - r, Math.min(b.start.y, e.y) - r, Math.min(b.start.z, e.z) - r, Math.max(b.start.x, e.x) + r, Math.max(b.start.y, e.y) + r, Math.max(b.start.z, e.z) + r], (S + i) * 6);
    });
    this.solidIndex = new SpatialIndex(bounds);
    this.nodeConns.clear();
    for (const c of Object.values(p.connections)) {
      const arr = this.nodeConns.get(c.node);
      if (arr) arr.push(c.id);
      else this.nodeConns.set(c.node, [c.id]);
    }
  }

  /** Mark labels: all members up to LABEL_LIMIT, else only the selected ones. */
  private buildLabels() {
    for (const c of [...this.labelGroup.children]) {
      if (c instanceof CSS2DObject) c.element.remove();
      this.labelGroup.remove(c);
    }
    this.labelsBuilt = true;
    if (!this.dm || !this.display.labels) return;
    const members = this.dm.parts.filter((pt) => pt.kind === 'member');
    const sel = new Set(this.selection.members);
    const list = members.length <= LABEL_LIMIT ? members : members.filter((pt) => sel.has(pt.memberId!));
    for (const part of list) {
      const label = document.createElement('div');
      label.className = 'mark-label';
      label.textContent = part.assembly;
      const lo = new CSS2DObject(label);
      lo.position.copy(v(lerp(part.frame.origin, add(part.frame.origin, scale(part.frame.x, part.length)), 0.5)));
      this.labelGroup.add(lo);
    }
  }

  setSelection(sel: Selection) {
    this.selection = sel;
    const prev = this.asmRefs;
    this.asmRefs = this.assemblyRefs(sel);
    // Parts that enter or leave a selected assembly are repainted too.
    for (const r of new Set([...prev, ...this.asmRefs])) for (const it of this.refItems.get(r) ?? []) this.paint(it, this.colorOf(it));
    this.applySelection();
  }

  /** Part refs of the selected assemblies (Selection.assemblies holds their main part refs). */
  private assemblyRefs(sel: Selection): Set<string> {
    this.asmMains = new Set(sel.assemblies ?? []);
    const out = new Set<string>();
    if (!this.asmMains.size || !this.dm) return out;
    for (const a of this.dm.assemblies) if (this.asmMains.has(a.main)) for (const r of a.parts) out.add(r);
    return out;
  }

  private selSets: { sel: Selection | null; members: Set<Id>; plates: Set<Id>; connections: Set<Id> } = { sel: null, members: new Set(), plates: new Set(), connections: new Set() };

  private colorOf(it: SolidItem): number {
    const s = this.selection;
    if (this.selSets.sel !== s) this.selSets = { sel: s, members: new Set(s.members), plates: new Set(s.plates ?? []), connections: new Set(s.connections) };
    const set = it.kind === 'member' ? this.selSets.members : it.kind === 'plate' ? this.selSets.plates : this.selSets.connections;
    return this.itemColor(it, set.has(it.id));
  }

  private itemColor(it: SolidItem, selected: boolean): number {
    if (this.asmRefs.has(it.part.ref)) return this.asmMains.has(it.part.ref) ? ASSEMBLY_MAIN_COLOR : ASSEMBLY_COLOR;
    if (selected) return SELECT_COLOR;
    if (this.groupColor) {
      const mode = this.display.colorBy;
      const key = mode === 'phase' ? it.part.phase : mode === 'batch' ? it.part.batch : it.part.zone;
      return this.groupColor(key);
    }
    return ROLE_COLORS[it.role] ?? 0x8899aa;
  }

  private paint(it: SolidItem, hex: number) {
    const b = it.batch;
    if (!b) return;
    this.tmpColor.setHex(hex);
    if (b.kind === 'instanced') {
      (b.mesh as THREE.InstancedMesh).setColorAt(it.slot, this.tmpColor);
      this.dirtyBatches.add(b);
    } else {
      const [start, n] = b.ranges![it.slot];
      const arr = b.colors!.array as Float32Array;
      const c = this.tmpColor;
      for (let i = start; i < start + n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      this.dirtyBatches.add(b);
    }
  }

  private flushPaint() {
    for (const b of this.dirtyBatches) {
      if (b.kind === 'instanced') {
        const m = b.mesh as THREE.InstancedMesh;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      } else b.colors!.needsUpdate = true;
    }
    this.dirtyBatches.clear();
  }

  /** Colour items; with `all` every part is repainted (model or colour mode change), else only selection changes. */
  private applySelection(all = false) {
    const sm = new Set(this.selection.members);
    const sc = new Set(this.selection.connections);
    const sp = new Set(this.selection.plates ?? []);
    const prev = this.paintedSel;
    if (all) {
      for (const it of this.solids) this.paint(it, this.itemColor(it, (it.kind === 'member' ? sm : it.kind === 'plate' ? sp : sc).has(it.id)));
    } else {
      const touch = (ids: Set<Id>, map: Map<Id, SolidItem[]>, selSet: Set<Id>) => {
        for (const id of ids) for (const it of map.get(id) ?? []) this.paint(it, this.itemColor(it, selSet.has(id)));
      };
      touch(new Set([...prev.members, ...sm]), this.memberItems, sm);
      touch(new Set([...prev.connections, ...sc]), this.connItems, sc);
      touch(new Set([...prev.plates, ...sp]), this.plateItems, sp);
    }
    this.flushPaint();
    this.paintedSel = { members: sm, connections: sc, plates: sp };
    // Selected wire lines as an overlay.
    if (this.wireSel && this.project) {
      const pts: number[] = [];
      for (const id of sm) {
        const m = this.project.members[id];
        const a = m && this.project.nodes[m.start]?.p;
        const b = m && this.project.nodes[m.end]?.p;
        if (a && b) pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      this.wireSel.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.wireSel.geometry = g;
    }
    if (this.display.labels && this.dm && this.dm.parts.length > LABEL_LIMIT) this.labelsBuilt = false;
    if (this.display.labels && !this.labelsBuilt) this.buildLabels();
    if (this.isoRefs) this.buildIsolation();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Isolation: only some parts (e.g. the selected assemblies) are drawn

  /** Show only these parts (part refs) with the bolts of their connections; null shows everything again. */
  setIsolation(refs: string[] | null) {
    this.isoRefs = refs && refs.length ? new Set(refs) : null;
    this.buildIsolation();
    this.applyDisplay();
  }

  private buildIsolation() {
    for (const c of [...this.isoGroup.children]) this.isoGroup.remove(c);
    for (const m of this.isoMats) m.dispose();
    this.isoMats = [];
    this.isoOwners = null;
    const iso = this.isoRefs;
    if (!iso) return;
    const owners = { members: new Set<Id>(), plates: new Set<Id>(), connections: new Set<Id>() };
    const mats = new Map<number, THREE.MeshStandardMaterial>();
    const matFor = (hex: number) => {
      let m = mats.get(hex);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ color: hex, metalness: 0.25, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        mats.set(hex, m);
        this.isoMats.push(m);
      }
      return m;
    };
    const place = (o: THREE.Object3D, m: THREE.Matrix4) => {
      o.matrixAutoUpdate = false;
      o.matrix.copy(m);
      o.matrixWorldNeedsUpdate = true;
      this.isoGroup.add(o);
    };
    for (const r of iso) {
      for (const it of this.refItems.get(r) ?? []) {
        (it.kind === 'member' ? owners.members : it.kind === 'plate' ? owners.plates : owners.connections).add(it.id);
        place(new THREE.Mesh(it.geometry, matFor(this.colorOf(it))), it.matrix);
        place(new THREE.LineSegments(it.edges, this.edgeMat), it.matrix);
      }
    }
    for (const b of this.bolts) {
      if (!owners.connections.has(b.connectionId)) continue;
      const mat = b.anchor ? matFor(0xb89a62) : this.boltMat;
      place(new THREE.Mesh(shankGeo, mat), b.shank);
      place(new THREE.Mesh(headGeo, this.boltMat), b.head);
    }
    this.isoOwners = owners;
  }

  setDisplay(d: Display) {
    const recolour = (d.colorBy ?? 'role') !== (this.display.colorBy ?? 'role');
    const labels = d.labels !== this.display.labels;
    this.display = d;
    if (labels) this.labelsBuilt = false;
    this.applyDisplay();
    if (recolour) this.applySelection(true);
    else if (labels) this.applySelection();
  }

  private applyDisplay() {
    const d = this.display;
    const iso = !!this.isoRefs;
    this.memberGroup.visible = d.solids && !iso;
    this.connGroup.visible = d.solids && d.connections && !iso;
    this.wireGroup.visible = (d.wire || !d.solids) && !iso;
    this.isoGroup.visible = iso;
    this.refGroup.visible = d.references;
    this.underlayGroup.visible = d.underlays;
    this.labelGroup.visible = d.labels && !iso;
    this.groupColor = this.project && d.colorBy && d.colorBy !== 'role' ? groupColors(this.project, d.colorBy) : null;
    if (d.labels && !this.labelsBuilt) this.buildLabels();
    for (const c of this.labelGroup.children) if (c instanceof CSS2DObject) c.element.style.display = d.labels ? '' : 'none';
    this.requestRender();
  }

  /** Points that drawing tools can snap to on reference geometry (e.g. DXF linework). */
  setReferencePoints(pts: Vec3[]) {
    this.refPoints = pts;
    this.refIndex = pts.length ? SpatialIndex.points(pts) : null;
  }

  /** Aim the camera at a point (e.g. a clash) from the current viewing direction. */
  focusPoint(p: Vec3, distance = 2500) {
    const target = v(p);
    if (this.camera === this.persp) {
      const dir = new THREE.Vector3().subVectors(this.persp.position, this.controlsP.target).normalize();
      if (dir.lengthSq() < 1e-9) dir.set(-0.55, -0.7, 0.45).normalize();
      this.controlsP.target.copy(target);
      this.persp.position.copy(target).addScaledVector(dir, distance);
      this.controlsP.update();
    } else {
      const delta = new THREE.Vector3().subVectors(target, this.controlsO.target);
      this.controlsO.target.add(delta);
      this.ortho.position.add(delta);
      const half = (this.ortho.top - this.ortho.bottom) / 2;
      this.ortho.zoom = Math.max(0.01, half / distance);
      this.ortho.updateProjectionMatrix();
      this.controlsO.update();
    }
    this.requestRender();
  }

  /**
   * Coloured overlay drawn on top of the model (the wireframe check preview):
   * segments and marker points with one colour each; null removes it.
   */
  setWireOverlay(o: { segments: number[]; colors: number[]; points: number[]; pointColors: number[] } | null) {
    if (this.wireOverlay) {
      this.helperGroup.remove(this.wireOverlay);
      disposeObject(this.wireOverlay);
      this.wireOverlay = null;
    }
    if (o && (o.segments.length || o.points.length)) {
      const g = new THREE.Group();
      const rgb = (list: number[], per: number) => {
        const out = new Float32Array(list.length * per * 3);
        const c = new THREE.Color();
        list.forEach((hex, i) => {
          c.setHex(hex);
          for (let k = 0; k < per; k++) out.set([c.r, c.g, c.b], (i * per + k) * 3);
        });
        return out;
      };
      if (o.segments.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(o.segments, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(rgb(o.colors, 2), 3));
        const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
        ls.renderOrder = 12;
        g.add(ls);
      }
      if (o.points.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(o.points, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(rgb(o.pointColors, 1), 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false, depthTest: false }));
        pts.renderOrder = 13;
        g.add(pts);
      }
      this.wireOverlay = g;
      this.helperGroup.add(g);
    }
    this.requestRender();
  }

  /**
   * Centre of the visible reference models (concrete, primary steel), or null when none is
   * loaded: the surface orientation takes the exterior side as away from it.
   */
  referenceCentre(): Vec3 | null {
    if (!this.refGroup.visible || !this.refGroup.children.length) return null;
    const box = new THREE.Box3().setFromObject(this.refGroup);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    return { x: c.x, y: c.y, z: c.z };
  }

  /**
   * Preview of a modify tool (what a click would do), drawn on top of the model
   * like the wireframe-check overlay; null removes it.
   */
  setToolPreview(o: { segments: number[]; colors: number[]; points: number[]; pointColors: number[] } | null) {
    if (this.toolOverlay) {
      this.helperGroup.remove(this.toolOverlay);
      disposeObject(this.toolOverlay);
      this.toolOverlay = null;
    }
    if (o && (o.segments.length || o.points.length)) {
      const g = new THREE.Group();
      const rgb = (list: number[], per: number) => {
        const out = new Float32Array(list.length * per * 3);
        const c = new THREE.Color();
        list.forEach((hex, i) => {
          c.setHex(hex);
          for (let k = 0; k < per; k++) out.set([c.r, c.g, c.b], (i * per + k) * 3);
        });
        return out;
      };
      if (o.segments.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(o.segments, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(rgb(o.colors, 2), 3));
        const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
        ls.renderOrder = 14;
        g.add(ls);
      }
      if (o.points.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(o.points, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(rgb(o.pointColors, 1), 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, size: 8, sizeAttenuation: false, depthTest: false }));
        pts.renderOrder = 15;
        g.add(pts);
      }
      this.toolOverlay = g;
      this.helperGroup.add(g);
    }
    this.requestRender();
  }

  /** Anchor of a modify tool's rubber band (and of ortho snapping), or null. */
  setToolAnchor(p: Vec3 | null) {
    this.pending = p ? [p] : [];
    if (!p) this.rubber.visible = false;
    this.requestRender();
  }

  /** Member under the cursor, snapped point and pick ray, for the modify tools. */
  private toolInfo(e: PointerEvent, snapped?: Snap | null): ToolPointerInfo {
    const hit = this.pick(e);
    const snap = snapped !== undefined ? snapped : (this.snapAt(e) ?? this.lastCursor);
    const rc = this.rayAt(e);
    return {
      member: hit?.kind === 'member' ? hit.id : null,
      point: snap?.p ?? null,
      kind: snap?.kind ?? '',
      ray: { origin: { x: rc.ray.origin.x, y: rc.ray.origin.y, z: rc.ray.origin.z }, dir: { x: rc.ray.direction.x, y: rc.ray.direction.y, z: rc.ray.direction.z } },
      shift: e.shiftKey,
    };
  }

  /** World box of some parts (part refs), or null when none is drawn. */
  boxOfRefs(refs: Iterable<string>): { min: Vec3; max: Vec3 } | null {
    const box = new THREE.Box3();
    const b = new THREE.Box3();
    for (const r of refs) {
      for (const it of this.refItems.get(r) ?? []) {
        if (!it.geometry.boundingBox) it.geometry.computeBoundingBox();
        box.union(b.copy(it.geometry.boundingBox!).applyMatrix4(it.matrix));
      }
    }
    if (box.isEmpty()) return null;
    return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
  }

  /** Aim the camera at a box (e.g. the members of a check item) from the current viewing direction. */
  focusBox(min: Vec3, max: Vec3) {
    const c = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    const size = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z);
    this.focusPoint(c, Math.max(1500, size * 1.6));
  }

  /** Show (or hide with null) a marker at a point, e.g. the active clash. */
  setMarker(p: Vec3 | null, color = 0xff3b30) {
    if (this.marker3d) {
      this.helperGroup.remove(this.marker3d);
      disposeObject(this.marker3d);
      this.marker3d = null;
    }
    if (p) {
      const g = new THREE.Group();
      const s = 120;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-s, 0, 0), new THREE.Vector3(s, 0, 0),
        new THREE.Vector3(0, -s, 0), new THREE.Vector3(0, s, 0),
        new THREE.Vector3(0, 0, -s), new THREE.Vector3(0, 0, s),
      ]);
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      const ball = new THREE.Mesh(new THREE.SphereGeometry(25, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }));
      lines.renderOrder = ball.renderOrder = 11;
      g.add(lines, ball);
      g.position.copy(v(p));
      this.marker3d = g;
      this.helperGroup.add(g);
    }
    this.requestRender();
  }

  /** Frustum around a screen point (pixels relative to the canvas) for index queries. */
  private nearFrustum(mouse: THREE.Vector2, r: number): FrustumTest {
    const el = this.renderer.domElement;
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    return FrustumTest.fromNdcRect(this.camera, ((mouse.x - r) / w) * 2 - 1, -((mouse.y + r) / h) * 2 + 1, ((mouse.x + r) / w) * 2 - 1, -((mouse.y - r) / h) * 2 + 1);
  }

  /** Exact ray test of one part: distance along the ray, or null. */
  private raycastItem(rc: THREE.Raycaster, it: SolidItem): number | null {
    this.tmpMesh.geometry = it.geometry;
    this.tmpMesh.matrixWorld.copy(it.matrix);
    const hits: THREE.Intersection[] = [];
    this.tmpMesh.raycast(rc, hits);
    let best: number | null = null;
    for (const h of hits) if (best === null || h.distance < best) best = h.distance;
    return best;
  }

  // -------------------------------------------------------------------------
  // Work plane, grids and levels

  setWorkPlane(wp: WorkPlane, step: number, p?: Project) {
    for (const c of [...this.planeGroup.children]) {
      if (c instanceof CSS2DObject) c.element.remove();
      disposeObject(c);
      this.planeGroup.remove(c);
    }
    const box = this.modelBox();
    const corners = [box.min, box.max].map((pt) => worldToPlane(wp, { x: pt.x, y: pt.y, z: pt.z }));
    const pad = 3000;
    let u0 = Math.min(corners[0].x, corners[1].x) - pad;
    let u1 = Math.max(corners[0].x, corners[1].x) + pad;
    let v0 = Math.min(corners[0].y, corners[1].y) - pad;
    let v1 = Math.max(corners[0].y, corners[1].y) + pad;
    let s = Math.max(step, 1);
    while ((u1 - u0) / s + (v1 - v0) / s > 400) s *= 2;
    const major = s * 10;
    u0 = Math.floor(u0 / major) * major;
    v0 = Math.floor(v0 / major) * major;
    u1 = Math.ceil(u1 / major) * major;
    v1 = Math.ceil(v1 / major) * major;
    const minor: THREE.Vector3[] = [];
    const maj: THREE.Vector3[] = [];
    const P = (u: number, vv: number) => v(planeToWorld(wp, u, vv));
    for (let u = u0; u <= u1 + 1e-6; u += s) (Math.abs(u % major) < 1e-6 ? maj : minor).push(P(u, v0), P(u, v1));
    for (let vv = v0; vv <= v1 + 1e-6; vv += s) (Math.abs(vv % major) < 1e-6 ? maj : minor).push(P(u0, vv), P(u1, vv));
    const mk = (pts: THREE.Vector3[], color: number, opacity: number) =>
      new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    this.planeGroup.add(mk(minor, 0x7f8da0, 0.12), mk(maj, 0x7f8da0, 0.3));
    // Axis lines through the plane origin.
    const axes: THREE.Vector3[] = [P(u0, 0), P(u1, 0), P(0, v0), P(0, v1)];
    this.planeGroup.add(mk(axes, 0xd05050, 0.5));

    if (p) {
      const pts: THREE.Vector3[] = [];
      for (const lvl of p.levels) {
        const a = { x: box.min.x - 1500, y: box.min.y - 1500, z: lvl.z };
        const b = { x: box.max.x + 1500, y: box.max.y + 1500, z: lvl.z };
        const c = [v(a), v({ ...a, x: b.x }), v(b), v({ ...a, y: b.y })];
        pts.push(c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]);
        this.planeGroup.add(this.label(`${lvl.name}  +${(lvl.z / 1000).toFixed(3)}`, v(a), 'level-label'));
      }
      for (const g of p.grids) {
        const z0 = box.min.z - 500;
        const z1 = box.max.z + 500;
        const a = g.axis === 'x' ? { x: g.pos, y: box.min.y - 2000, z: z0 } : { x: box.min.x - 2000, y: g.pos, z: z0 };
        const b = g.axis === 'x' ? { x: g.pos, y: box.max.y + 2000, z: z0 } : { x: box.max.x + 2000, y: g.pos, z: z0 };
        pts.push(v(a), v(b), v(a), v({ ...a, z: z1 }));
        this.planeGroup.add(this.label(g.name, v({ ...a, z: z1 }), 'grid-label'));
      }
      if (pts.length) {
        const ls = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineDashedMaterial({ color: 0x5b9bd5, dashSize: 200, gapSize: 120, transparent: true, opacity: 0.7 }),
        );
        ls.computeLineDistances();
        this.planeGroup.add(ls);
      }
    }
    this.requestRender();
  }

  private label(text: string, pos: THREE.Vector3, cls: string) {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    const o = new CSS2DObject(div);
    o.position.copy(pos);
    return o;
  }

  // -------------------------------------------------------------------------
  // Views

  modelBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const n of this.nodeList) box.expandByPoint(v(n.p));
    // Free plates have no nodes: include them through their placed geometry.
    for (const items of this.plateItems.values()) {
      for (const it of items) {
        it.geometry.computeBoundingBox();
        if (it.geometry.boundingBox) box.union(it.geometry.boundingBox.clone().applyMatrix4(it.matrix));
      }
    }
    if (this.display.references && this.refGroup.children.length) box.union(new THREE.Box3().setFromObject(this.refGroup));
    if (this.underlayGroup.children.length) box.union(new THREE.Box3().setFromObject(this.underlayGroup));
    if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6000, 1000, 4000));
    return box;
  }

  setView(name: ViewName) {
    const box = this.modelBox();
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.length() / 2, 1000);
    if (name === '3d') {
      this.camera = this.persp;
        this.controlsP.enabled = true;
      this.controlsO.enabled = false;
      const dir = new THREE.Vector3(0.75, -1, 0.65).normalize();
      this.persp.position.copy(c).addScaledVector(dir, r / Math.tan((this.persp.fov * Math.PI) / 360) * 1.1);
      this.controlsP.target.copy(c);
      this.controlsP.update();
    } else {
      this.camera = this.ortho;
      this.controlsO.enabled = true;
      this.controlsP.enabled = false;
      const d = r * 4;
      const offs =
        name === 'front' ? new THREE.Vector3(0, -d, 0) : name === 'plan' ? new THREE.Vector3(0, -0.001 * d, d) : new THREE.Vector3(d, 0, 0);
      this.ortho.position.copy(c).add(offs);
      this.controlsO.target.copy(c);
      this.ortho.zoom = 1;
      const w = this.container.clientWidth || 1;
      const h = this.container.clientHeight || 1;
      const extentU = name === 'side' ? size.y : size.x;
      const extentV = name === 'plan' ? size.y : size.z;
      const half = Math.max(extentV / 2, ((extentU / 2) * h) / w, 500) * 1.15;
      this.ortho.top = half;
      this.ortho.bottom = -half;
      this.ortho.left = (-half * w) / h;
      this.ortho.right = (half * w) / h;
      this.ortho.updateProjectionMatrix();
      this.controlsO.update();
    }
    this.requestRender();
  }

  zoomExtents() {
    if (this.camera === this.persp) this.setView('3d');
    else {
      const dir = new THREE.Vector3().subVectors(this.ortho.position, this.controlsO.target).normalize();
      const name: ViewName = Math.abs(dir.z) > 0.9 ? 'plan' : Math.abs(dir.x) > 0.9 ? 'side' : 'front';
      this.setView(name);
    }
  }

  /** Snapshot of the current view as a PNG data URL. */
  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // -------------------------------------------------------------------------
  // Interaction

  resetTool() {
    this.pending = [];
    this.rubber.visible = false;
    this.preview.visible = false;
    this.updatePrompt();
    this.requestRender();
  }

  /** Preview of multi-point tools: the plate polygon so far, or the arc through the cursor. */
  private updatePreview(cursor: Vec3 | null) {
    const { tool } = this.cb.getState();
    let pts: Vec3[] = [];
    if (tool === 'plate' && this.pending.length >= 1) pts = cursor ? [...this.pending, cursor, this.pending[0]] : [...this.pending, this.pending[0]];
    else if (tool === 'arc' && this.pending.length === 2 && cursor) {
      const arc = arcFrom3Points(this.pending[0], this.pending[1], cursor);
      pts = arc ? arcPoints(arc, { maxDeviation: Math.max(1, arc.radius / 500) }) : [this.pending[0], cursor, this.pending[1]];
    } else if (tool === 'plane3' && this.pending.length === 2 && cursor) pts = [this.pending[0], this.pending[1], cursor, this.pending[0]];
    if (pts.length < 2) {
      this.preview.visible = false;
      return;
    }
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(v));
    this.preview.visible = true;
  }

  private updatePrompt() {
    const { tool } = this.cb.getState();
    if (this.cb.isModifyTool?.(tool)) return; // modify tools keep their own prompts
    const prompts = PROMPTS[tool];
    if (!prompts) {
      this.cb.onPrompt(tool === 'select' ? 'Click to select · drag a box (left→right inside, right→left crossing) · Shift adds' : '');
      return;
    }
    this.cb.onPrompt(prompts[Math.min(this.pending.length, prompts.length - 1)]);
  }

  private ndc(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private toScreen(p: Vec3): THREE.Vector2 | null {
    const q = v(p).project(this.camera);
    if (q.z > 1 || q.z < -1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height);
  }

  private localXY(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
  }

  private rayAt(e: { clientX: number; clientY: number }) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(this.ndc(e.clientX, e.clientY), this.camera);
    return rc;
  }

  private planeHit(e: { clientX: number; clientY: number }, wp: WorkPlane): Vec3 | null {
    const rc = this.rayAt(e);
    const ax = planeAxes(wp);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v(ax.n), v(ax.origin));
    const out = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, out) ? { x: out.x, y: out.y, z: out.z } : null;
  }

  private snapAt(e: PointerEvent): Snap | null {
    const st = this.cb.getState();
    const s = st.snap;
    const mouse = this.localXY(e);
    let best: Snap | null = null;
    let bestD = Infinity;
    const consider = (p: Vec3, kind: SnapKind, radius: number) => {
      const sp = this.toScreen(p);
      if (!sp) return;
      const d = sp.distanceTo(mouse);
      if (d < radius && d < bestD) {
        bestD = d;
        best = { p, kind };
      }
    };
    if (s.endpoint) this.nodeIndex?.frustum(this.nearFrustum(mouse, 12), (i) => void consider(this.nodeList[i].p, 'end', 12));
    if (s.midpoint && this.project) {
      this.wireIndex?.frustum(this.nearFrustum(mouse, 10), (i) => {
        const [a, b] = this.wireSegs[i];
        consider(lerp(a, b, 0.5), 'mid', 10);
      });
    }
    if (s.reference) {
      this.refIndex?.frustum(this.nearFrustum(mouse, 10), (i) => void consider(this.refPoints[i], 'ref', 10));
      if (!best && this.refGroup.visible && this.refGroup.children.length) {
        const hits = this.rayAt(e).intersectObject(this.refGroup, true);
        const h = hits.find((x) => x.face);
        if (h && h.face && (h.object as THREE.Mesh).geometry) {
          const geo = (h.object as THREE.Mesh).geometry as THREE.BufferGeometry;
          const pos = geo.getAttribute('position');
          for (const idx of [h.face.a, h.face.b, h.face.c]) {
            const w = new THREE.Vector3().fromBufferAttribute(pos, idx).applyMatrix4(h.object.matrixWorld);
            consider({ x: w.x, y: w.y, z: w.z }, 'ref', 14);
          }
          if (!best) best = { p: { x: h.point.x, y: h.point.y, z: h.point.z }, kind: 'ref' };
        }
      }
    }
    if (best) return best;
    const hit = this.planeHit(e, st.workPlane);
    if (!hit) return null;
    let uv = worldToPlane(st.workPlane, hit);
    let kind: SnapKind = 'plane';
    if (s.grid) {
      const g = st.gridStep;
      uv = { x: Math.round(uv.x / g) * g, y: Math.round(uv.y / g) * g };
      kind = 'grid';
    }
    if (s.ortho && this.pending.length) {
      const last = worldToPlane(st.workPlane, this.pending[this.pending.length - 1]);
      if (Math.abs(uv.x - last.x) > Math.abs(uv.y - last.y)) uv.y = last.y;
      else uv.x = last.x;
    }
    return { p: planeToWorld(st.workPlane, uv.x, uv.y), kind };
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.down = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
    const { tool } = this.cb.getState();
    this.grabbed = !!this.cb.isModifyTool?.(tool) && !!this.cb.onToolPress?.(tool, this.toolInfo(e));
  };

  private onMove = (e: PointerEvent) => {
    const { tool } = this.cb.getState();
    if (tool === 'select') {
      this.marker.style.display = 'none';
      if (this.down && (Math.abs(e.clientX - this.down.x) > 4 || Math.abs(e.clientY - this.down.y) > 4)) {
        const r = this.renderer.domElement.getBoundingClientRect();
        const x0 = Math.min(this.down.x, e.clientX) - r.left;
        const y0 = Math.min(this.down.y, e.clientY) - r.top;
        Object.assign(this.boxDiv.style, {
          display: 'block',
          left: `${x0}px`,
          top: `${y0}px`,
          width: `${Math.abs(e.clientX - this.down.x)}px`,
          height: `${Math.abs(e.clientY - this.down.y)}px`,
        });
        this.boxDiv.classList.toggle('crossing', e.clientX < this.down.x);
      }
      const hit = this.planeHit(e, this.cb.getState().workPlane);
      this.cb.onCursor(hit, '');
      return;
    }
    const snap = this.snapAt(e);
    this.lastCursor = snap;
    if (this.cb.isModifyTool?.(tool)) this.cb.onToolHover?.(tool, this.toolInfo(e, snap));
    if (!snap) {
      this.marker.style.display = 'none';
      return;
    }
    const sp = this.toScreen(snap.p);
    if (sp) {
      this.marker.style.display = 'block';
      this.marker.style.left = `${sp.x}px`;
      this.marker.style.top = `${sp.y}px`;
      this.marker.dataset.kind = snap.kind;
    }
    this.cb.onCursor(snap.p, snap.kind);
    this.updatePreview(snap.p);
    if (this.pending.length) {
      const last = this.pending[this.pending.length - 1];
      const pos = this.rubber.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, last.x, last.y, last.z);
      pos.setXYZ(1, snap.p.x, snap.p.y, snap.p.z);
      pos.needsUpdate = true;
      this.rubber.geometry.computeBoundingSphere();
      this.rubber.visible = true;
    }
    this.requestRender();
  };

  private onUp = (e: PointerEvent) => {
    if (e.button !== 0 || !this.down) return;
    const d = this.down;
    this.down = null;
    const { tool } = this.cb.getState();
    const dragged = Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4;
    if (tool === 'select') {
      this.boxDiv.style.display = 'none';
      if (dragged) this.boxSelect(d.x, d.y, e.clientX, e.clientY, e.shiftKey);
      else this.cb.onPick(this.pick(e), e.shiftKey || e.ctrlKey || e.metaKey, e.altKey);
      return;
    }
    if (this.cb.isModifyTool?.(tool)) {
      // A grabbed grip (Stretch): the release after a drag is the target; a plain click only grabbed it.
      const grabbed = this.grabbed;
      this.grabbed = false;
      if (grabbed ? !dragged : dragged) return;
      this.cb.onToolClick?.(tool, this.toolInfo(e));
      return;
    }
    if (dragged) return;
    const snap = this.snapAt(e) ?? this.lastCursor;
    if (!snap) return;
    const now = performance.now();
    const dbl = now - this.lastClick < 300;
    this.lastClick = now;
    if ((tool === 'polyline' || tool === 'plate') && dbl && this.pending.length) {
      this.finishTool();
      return;
    }
    // Clicking the first corner again closes a plate.
    if (tool === 'plate' && this.pending.length >= 3) {
      const a = this.toScreen(this.pending[0]);
      const b = this.toScreen(snap.p);
      if (a && b && a.distanceTo(b) < 10) {
        this.finishTool();
        return;
      }
    }
    this.addPoint(snap.p);
  };

  /** Feed a point to the active tool (from a click or typed coordinates). */
  addPoint(p: Vec3) {
    const { tool } = this.cb.getState();
    if (this.pending.length && dist(this.pending[this.pending.length - 1], p) < 0.5) return;
    this.pending.push(p);
    const need = TOOL_POINTS[tool];
    if (need !== undefined) {
      // Multi-point tools fire once they have their points (plates fire on close).
      if (this.pending.length >= need) {
        const pts = this.pending;
        this.pending = [];
        this.rubber.visible = false;
        this.preview.visible = false;
        this.cb.onPoints(tool, pts);
      }
      this.updatePreview(null);
      this.updatePrompt();
      this.requestRender();
      return;
    }
    if (this.pending.length >= 2) {
      const pts = this.pending.slice(-2);
      this.cb.onPoints(tool, pts);
      if (tool === 'polyline') this.pending = [pts[1]];
      else if (tool === 'line') this.pending = [];
      else {
        this.pending = [];
        this.rubber.visible = false;
        this.cb.onToolDone();
      }
      if (!this.pending.length) this.rubber.visible = false;
    }
    this.updatePrompt();
    this.requestRender();
  }

  finishTool() {
    const { tool } = this.cb.getState();
    const pts = this.pending;
    this.pending = [];
    this.rubber.visible = false;
    this.preview.visible = false;
    if (tool === 'plate' && pts.length >= 3) this.cb.onPoints(tool, pts);
    this.updatePrompt();
    this.requestRender();
  }

  /**
   * Typed input: "x,y,z" world; "u,v" work-plane; "@dx,dy,dz" / "@du,dv" relative;
   * a single number = length along the current rubber-band direction.
   */
  typed(text: string): string | null {
    const st = this.cb.getState();
    const t = text.trim();
    if (!t) return null;
    if (/^(c|close)$/i.test(t) && st.tool === 'plate') {
      if (this.pending.length < 3) return 'A plate needs at least three corners.';
      this.finishTool();
      return null;
    }
    const rel = t.startsWith('@');
    const nums = t.replace('@', '').split(/[ ,;]+/).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return 'Could not read the coordinates.';
    const last = this.pending[this.pending.length - 1];
    let p: Vec3 | null = null;
    if (nums.length === 1) {
      if (!last) return 'Pick a first point before typing a length.';
      const towards = this.lastCursor?.p;
      const dir = towards && dist(towards, last) > 1 ? normalize(sub(towards, last)) : planeAxes(st.workPlane).u;
      p = add(last, scale(dir, nums[0]));
    } else if (nums.length === 2) {
      const ax = planeAxes(st.workPlane);
      if (rel) {
        if (!last) return 'Pick a first point before typing a relative offset.';
        p = add(last, add(scale(ax.u, nums[0]), scale(ax.v, nums[1])));
      } else p = planeToWorld(st.workPlane, nums[0], nums[1]);
    } else if (nums.length === 3) {
      const d = { x: nums[0], y: nums[1], z: nums[2] };
      if (rel) {
        if (!last) return 'Pick a first point before typing a relative offset.';
        p = add(last, d);
      } else p = d;
    } else return 'Type 1, 2 or 3 numbers.';
    this.addPoint(p);
    return null;
  }

  private pick(e: PointerEvent): PickHit | null {
    const rc = this.rayAt(e);
    const iso = this.isoRefs;
    const wantMembers = iso ? true : this.memberGroup.visible;
    const wantConns = iso ? true : this.connGroup.visible;
    let best: { t: number; hit: PickHit } | null = null;
    const S = this.solids.length;
    // Solids: BVH candidates along the ray, exact test on each, nearest wins.
    this.solidIndex?.ray(rc.ray, Infinity, (i, tEnter) => {
      if (best && tEnter > best.t) return best.t;
      let t: number | null = null;
      let hit: PickHit;
      if (i < S) {
        const it = this.solids[i];
        if (it.kind === 'connection' ? !wantConns : !wantMembers) return;
        if (iso && !iso.has(it.part.ref)) return;
        t = this.raycastItem(rc, it);
        hit = { kind: it.kind, id: it.id, ref: it.part.ref };
      } else {
        const b = this.bolts[i - S];
        if (!wantConns) return;
        if (iso && !this.isoOwners?.connections.has(b.connectionId)) return;
        t = rayCylinderBox(rc.ray, b);
        hit = { kind: 'connection', id: b.connectionId };
      }
      if (t !== null && (!best || t < best.t)) best = { t, hit };
      return best?.t;
    });
    const solidHit = best as { t: number; hit: PickHit } | null;
    if (solidHit) return solidHit.hit;
    if (iso) return null;
    // Screen-space test for wire lines and nodes (candidates from the indexes).
    const mouse = this.localXY(e);
    let near: PickHit | null = null;
    let bestD = 8;
    this.nodeIndex?.frustum(this.nearFrustum(mouse, 7), (i) => {
      const n = this.nodeList[i];
      const sp = this.toScreen(n.p);
      if (sp && sp.distanceTo(mouse) < 7 && sp.distanceTo(mouse) < bestD) {
        bestD = sp.distanceTo(mouse) - 2;
        near = { kind: 'node', id: n.id };
      }
    });
    if (this.wireGroup.visible && this.project) {
      this.wireIndex?.frustum(this.nearFrustum(mouse, 8), (i) => {
        const [pa, pb] = this.wireSegs[i];
        const a = this.toScreen(pa);
        const b = this.toScreen(pb);
        if (!a || !b) return;
        const d = segDist2(mouse, a, b);
        if (d < bestD) {
          bestD = d;
          near = { kind: 'member', id: this.wireIds[i] };
        }
      });
    }
    return near;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    if (!this.project) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const minX = Math.min(x0, x1) - r.left;
    const maxX = Math.max(x0, x1) - r.left;
    const minY = Math.min(y0, y1) - r.top;
    const maxY = Math.max(y0, y1) - r.top;
    const crossing = x1 < x0;
    const inside = (p: Vec3) => {
      const s = this.toScreen(p);
      return !!s && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
    };
    const w = r.width || 1;
    const h = r.height || 1;
    const f = FrustumTest.fromNdcRect(this.camera, (minX / w) * 2 - 1, -(maxY / h) * 2 + 1, (maxX / w) * 2 - 1, -(minY / h) * 2 + 1);
    const sel: Selection = { members: [], nodes: [], connections: [] };
    this.wireIndex?.frustum(f, (i) => {
      const [a, b] = this.wireSegs[i];
      const ok = crossing ? inside(a) || inside(b) || inside(lerp(a, b, 0.5)) : inside(a) && inside(b);
      if (ok) sel.members.push(this.wireIds[i]);
    });
    if (this.display.solids) {
      sel.plates = Object.values(this.project.plates ?? {})
        .filter((pl) => inside(pl.origin))
        .map((pl) => pl.id);
    }
    if (this.display.connections && this.display.solids) {
      this.nodeIndex?.frustum(f, (i) => {
        const n = this.nodeList[i];
        if (inside(n.p)) for (const c of this.nodeConns.get(n.id) ?? []) sel.connections.push(c);
      });
    }
    const own = this.isoOwners;
    if (own) {
      sel.members = sel.members.filter((id) => own.members.has(id));
      sel.plates = (sel.plates ?? []).filter((id) => own.plates.has(id));
      sel.connections = sel.connections.filter((id) => own.connections.has(id));
    }
    this.cb.onBoxSelect(sel, additive);
  }

  /** Approximate camera direction (used for e.g. the work plane hint). */
  viewDir(): Vec3 {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return { x: d.x, y: d.y, z: d.z };
  }
}

/** Ray distance to a bolt's bounding box (axis along the bolt), or null. */
function rayCylinderBox(ray: THREE.Ray, b: BoltItem): number | null {
  const x = v(b.dir);
  const helper = Math.abs(x.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const y = new THREE.Vector3().crossVectors(helper, x).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(v(b.start));
  const inv = m.clone().invert();
  const local = ray.clone().applyMatrix4(inv);
  const r = b.d / 2;
  const hit = local.intersectBox(new THREE.Box3(new THREE.Vector3(0, -r, -r), new THREE.Vector3(b.length, r, r)), new THREE.Vector3());
  return hit ? hit.applyMatrix4(m).distanceTo(ray.origin) : null;
}

function segDist2(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

