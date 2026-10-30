import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Id, Project, Vec3, WorkPlane } from '../core/model/types';
import type { DerivedModel } from '../core/derive/model';
import { planeAxes, planeToWorld, worldToPlane, lerp, dist, add, sub, scale, normalize } from '../core/model/geometry';
import type { Selection, SnapSettings, Tool, ViewName } from '../state/store';
import {
  ROLE_COLORS,
  SELECT_COLOR,
  alongMatrix,
  cachedGeometries,
  disposeObject,
  headGeo,
  linearMatrix,
  plateGeometry,
  plateMatrix,
  profileGeometry,
  shankGeo,
  v,
} from './meshes';
import { getBolt } from '../core/library/bolts';

export interface PickHit {
  kind: 'member' | 'connection' | 'node';
  id: Id;
}

export interface Display {
  solids: boolean;
  wire: boolean;
  connections: boolean;
  references: boolean;
  underlays: boolean;
  labels: boolean;
}

export interface ViewerCallbacks {
  getState(): { tool: Tool; snap: SnapSettings; workPlane: WorkPlane; gridStep: number };
  onPick(hit: PickHit | null, additive: boolean): void;
  onBoxSelect(sel: Selection, additive: boolean): void;
  onPoints(tool: Tool, pts: Vec3[]): void;
  onCursor(p: Vec3 | null, kind: string): void;
  onPrompt(text: string): void;
  onToolDone(): void;
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
};

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

  private memberObjs = new Map<Id, THREE.Mesh[]>();
  private connObjs = new Map<Id, THREE.Mesh[]>();
  private wireObjs = new Map<Id, THREE.Line>();
  private mats = new Map<string, THREE.Material>();
  private selectedMat = new THREE.MeshStandardMaterial({ color: SELECT_COLOR, metalness: 0.2, roughness: 0.5 });
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
  private marker: HTMLDivElement;
  private boxDiv: HTMLDivElement;
  private down: { x: number; y: number; button: number; shift: boolean } | null = null;
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
    this.scene.add(this.underlayGroup, this.planeGroup, this.refGroup, this.wireGroup, this.memberGroup, this.connGroup, this.helperGroup, this.labelGroup);

    const rubberGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.rubber = new THREE.Line(rubberGeo, new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false }));
    this.rubber.renderOrder = 10;
    this.rubber.visible = false;
    this.helperGroup.add(this.rubber);

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

  private mat(key: string, color: number): THREE.Material {
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      this.mats.set(key, m);
    }
    return m;
  }

  setModel(p: Project, dm: DerivedModel) {
    this.project = p;
    const keep = cachedGeometries();
    for (const g of [this.memberGroup, this.connGroup, this.wireGroup, this.labelGroup]) {
      for (const c of [...g.children]) {
        if (c instanceof CSS2DObject) c.element.remove();
        disposeObject(c, keep, false);
        g.remove(c);
      }
    }
    this.memberObjs.clear();
    this.connObjs.clear();
    this.wireObjs.clear();
    this.nodeList = Object.values(p.nodes).map((n) => ({ id: n.id, p: n.p }));

    // Wire lines.
    for (const m of Object.values(p.members)) {
      const a = p.nodes[m.start]?.p;
      const b = p.nodes[m.end]?.p;
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([v(a), v(b)]);
      const line = new THREE.Line(geo, m.profile ? this.wireAssignedMat : this.wireMat);
      if (!m.profile) line.computeLineDistances();
      line.userData = { kind: 'member', id: m.id };
      this.wireGroup.add(line);
      this.wireObjs.set(m.id, line);
    }
    // Node dots.
    if (this.nodeList.length) {
      const pts = new THREE.BufferGeometry().setFromPoints(this.nodeList.map((n) => v(n.p)));
      const dots = new THREE.Points(pts, this.nodeMat);
      this.wireGroup.add(dots);
    }

    // Parts.
    for (const part of dm.parts) {
      if (part.kind === 'plate' && part.outline) {
        const g = plateGeometry(part.outline, part.plateHoles ?? [], part.thickness);
        const mesh = new THREE.Mesh(g.mesh, this.mat('plate', ROLE_COLORS.plate));
        mesh.applyMatrix4(plateMatrix(part.frame));
        const edges = new THREE.LineSegments(g.edges, this.edgeMat);
        mesh.add(edges);
        mesh.userData = { kind: 'connection', id: part.connectionId, role: 'plate' };
        this.connGroup.add(mesh);
        this.track(this.connObjs, part.connectionId!, mesh);
      } else if (part.shape) {
        const g = profileGeometry(part.profile, part.shape);
        const role = part.role;
        const mesh = new THREE.Mesh(g.mesh, this.mat(role, ROLE_COLORS[role] ?? 0x8899aa));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(linearMatrix(part.frame, part.length));
        const edges = new THREE.LineSegments(g.edges, this.edgeMat);
        mesh.add(edges);
        if (part.kind === 'member') {
          mesh.userData = { kind: 'member', id: part.memberId, role };
          this.memberGroup.add(mesh);
          this.track(this.memberObjs, part.memberId!, mesh);
          const label = document.createElement('div');
          label.className = 'mark-label';
          label.textContent = part.assembly;
          const lo = new CSS2DObject(label);
          const mid = lerp(part.frame.origin, add(part.frame.origin, scale(part.frame.x, part.length)), 0.5);
          lo.position.copy(v(mid));
          this.labelGroup.add(lo);
        } else {
          mesh.userData = { kind: 'connection', id: part.connectionId, role };
          this.connGroup.add(mesh);
          this.track(this.connObjs, part.connectionId!, mesh);
        }
      }
    }

    // Bolts as instanced meshes.
    const bolts = dm.bolts.flatMap((b) => b.positions.map((pos) => ({ b, pos })));
    if (bolts.length) {
      const shanks = new THREE.InstancedMesh(shankGeo, this.boltMat, bolts.length);
      const heads = new THREE.InstancedMesh(headGeo, this.boltMat, bolts.length);
      const ids: Id[] = [];
      bolts.forEach(({ b, pos }, i) => {
        const size = getBolt(b.size);
        shanks.setMatrixAt(i, alongMatrix(pos, b.dir, size.d, b.length));
        heads.setMatrixAt(i, alongMatrix(pos, b.dir, size.af, size.head));
        shanks.setColorAt(i, new THREE.Color(b.kind === 'anchor' ? 0xb89a62 : 0xffffff));
        ids.push(b.connectionId);
      });
      shanks.userData = { kind: 'connection', instanceIds: ids };
      heads.userData = { kind: 'connection', instanceIds: ids };
      this.connGroup.add(shanks, heads);
    }

    this.applyDisplay();
    this.applySelection();
    this.requestRender();
  }

  private track(map: Map<Id, THREE.Mesh[]>, id: Id, m: THREE.Mesh) {
    const arr = map.get(id) ?? [];
    arr.push(m);
    map.set(id, arr);
  }

  setSelection(sel: Selection) {
    this.selection = sel;
    this.applySelection();
  }

  private applySelection() {
    const sm = new Set(this.selection.members);
    const sc = new Set(this.selection.connections);
    for (const [id, meshes] of this.memberObjs) {
      for (const m of meshes) {
        const role = m.userData.role as keyof typeof ROLE_COLORS;
        m.material = sm.has(id) ? this.selectedMat : this.mat(role, ROLE_COLORS[role] ?? 0x8899aa);
      }
    }
    for (const [id, meshes] of this.connObjs) {
      for (const m of meshes) {
        const role = m.userData.role as keyof typeof ROLE_COLORS;
        m.material = sc.has(id) ? this.selectedMat : this.mat(role, ROLE_COLORS[role] ?? 0xc9a46a);
      }
    }
    for (const [id, line] of this.wireObjs) {
      const m = this.project?.members[id];
      line.material = sm.has(id) ? this.wireSelMat : m?.profile ? this.wireAssignedMat : this.wireMat;
    }
    this.requestRender();
  }

  setDisplay(d: Display) {
    this.display = d;
    this.applyDisplay();
  }

  private applyDisplay() {
    const d = this.display;
    this.memberGroup.visible = d.solids;
    this.connGroup.visible = d.solids && d.connections;
    this.wireGroup.visible = d.wire || !d.solids;
    this.refGroup.visible = d.references;
    this.underlayGroup.visible = d.underlays;
    this.labelGroup.visible = d.labels;
    for (const c of this.labelGroup.children) if (c instanceof CSS2DObject) c.element.style.display = d.labels ? '' : 'none';
    this.requestRender();
  }

  /** Points that drawing tools can snap to on reference geometry (e.g. DXF linework). */
  setReferencePoints(pts: Vec3[]) {
    this.refPoints = pts;
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
    this.updatePrompt();
    this.requestRender();
  }

  private updatePrompt() {
    const { tool } = this.cb.getState();
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
    if (s.endpoint) for (const n of this.nodeList) consider(n.p, 'end', 12);
    if (s.midpoint && this.project) {
      for (const m of Object.values(this.project.members)) {
        const a = this.project.nodes[m.start]?.p;
        const b = this.project.nodes[m.end]?.p;
        if (a && b) consider(lerp(a, b, 0.5), 'mid', 10);
      }
    }
    if (s.reference) {
      for (const p of this.refPoints) consider(p, 'ref', 10);
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
      else this.cb.onPick(this.pick(e), e.shiftKey || e.ctrlKey || e.metaKey);
      return;
    }
    if (dragged) return;
    const snap = this.snapAt(e) ?? this.lastCursor;
    if (!snap) return;
    const now = performance.now();
    const dbl = now - this.lastClick < 300;
    this.lastClick = now;
    if (tool === 'polyline' && dbl && this.pending.length) {
      this.finishTool();
      return;
    }
    this.addPoint(snap.p);
  };

  /** Feed a point to the active tool (from a click or typed coordinates). */
  addPoint(p: Vec3) {
    const { tool } = this.cb.getState();
    if (this.pending.length && dist(this.pending[this.pending.length - 1], p) < 0.5) return;
    this.pending.push(p);
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
    this.pending = [];
    this.rubber.visible = false;
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
    const targets: THREE.Object3D[] = [];
    if (this.memberGroup.visible) targets.push(this.memberGroup);
    if (this.connGroup.visible) targets.push(this.connGroup);
    const hits = rc.intersectObjects(targets, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      if (o instanceof THREE.LineSegments) o = o.parent;
      if (!o) continue;
      if (o instanceof THREE.InstancedMesh && h.instanceId !== undefined) {
        const ids = o.userData.instanceIds as Id[];
        return { kind: 'connection', id: ids[h.instanceId] };
      }
      if (o.userData.kind) return { kind: o.userData.kind, id: o.userData.id };
    }
    // Screen-space test for wire lines and nodes.
    const mouse = this.localXY(e);
    let best: PickHit | null = null;
    let bestD = 8;
    for (const n of this.nodeList) {
      const sp = this.toScreen(n.p);
      if (sp && sp.distanceTo(mouse) < 7 && sp.distanceTo(mouse) < bestD) {
        bestD = sp.distanceTo(mouse) - 2;
        best = { kind: 'node', id: n.id };
      }
    }
    if (this.wireGroup.visible && this.project) {
      for (const m of Object.values(this.project.members)) {
        const a = this.toScreen(this.project.nodes[m.start].p);
        const b = this.toScreen(this.project.nodes[m.end].p);
        if (!a || !b) continue;
        const d = segDist2(mouse, a, b);
        if (d < bestD) {
          bestD = d;
          best = { kind: 'member', id: m.id };
        }
      }
    }
    return best;
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
    const sel: Selection = { members: [], nodes: [], connections: [] };
    for (const m of Object.values(this.project.members)) {
      const a = this.project.nodes[m.start].p;
      const b = this.project.nodes[m.end].p;
      const ok = crossing ? inside(a) || inside(b) || inside(lerp(a, b, 0.5)) : inside(a) && inside(b);
      if (ok) sel.members.push(m.id);
    }
    if (this.display.connections && this.display.solids) {
      for (const c of Object.values(this.project.connections)) {
        const n = this.project.nodes[c.node];
        if (n && inside(n.p)) sel.connections.push(c.id);
      }
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

function segDist2(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

