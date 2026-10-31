/**
 * Live connection preview: a small self-contained Three.js view (own renderer,
 * orbit controls, lights, fit-to-view) that renders a mini project built by
 * core/connections/preview.ts through the real deriveModel — members
 * (translucent), plates with cut-through holes, cleats, bolts and anchors,
 * holes through member walls (dark), welds (orange), concrete (translucent)
 * and optional part labels. The camera is kept between updates.
 *
 * `renderThumbnail` uses one shared offscreen renderer to make cached data URLs.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Id, Vec3 } from '../core/model/types';
import type { DerivedModel } from '../core/derive/model';
import { holeRuns, weldLines, type PreviewBox } from '../core/connections/preview';
import { getBolt } from '../core/library/bolts';
import { ROLE_COLORS, alongMatrix, cachedGeometries, disposeObject, headGeo, linearMatrix, plateGeometry, plateMatrix, profileGeometry, shankGeo, slottedMemberGeometry, v } from './meshes';

export interface PreviewContent {
  dm: DerivedModel;
  connectionId: Id;
  boxes: PreviewBox[];
}

export interface PreviewViewOptions {
  labels?: boolean;
  /** Offscreen (thumbnails): no controls, no animation loop, preserve the drawing buffer. */
  offscreen?: boolean;
  width?: number;
  height?: number;
}

const COLORS = {
  plate: 0xd2a35c,
  cleat: 0xe0b85a,
  bolt: 0x7d8590,
  anchor: 0xb48a4a,
  hole: 0x0b0e12,
  weld: 0xff6a2a,
  concrete: 0x9aa3ad,
  channel: 0x3d444d,
};

export class ConnectionPreview {
  readonly renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer | null = null;
  private scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private content = new THREE.Group();
  private labelGroup = new THREE.Group();
  private container: HTMLElement | null;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private dirty = true;
  private fitted = false;
  private labels: boolean;
  private mats = {
    member: new Map<string, THREE.Material>(),
    plate: new THREE.MeshStandardMaterial({ color: COLORS.plate, metalness: 0.3, roughness: 0.55, side: THREE.DoubleSide }),
    cleat: new THREE.MeshStandardMaterial({ color: COLORS.cleat, metalness: 0.3, roughness: 0.55 }),
    bolt: new THREE.MeshStandardMaterial({ color: COLORS.bolt, metalness: 0.6, roughness: 0.35 }),
    anchor: new THREE.MeshStandardMaterial({ color: COLORS.anchor, metalness: 0.5, roughness: 0.4 }),
    washer: new THREE.MeshStandardMaterial({ color: 0xa9b0b8, metalness: 0.6, roughness: 0.35 }),
    hole: new THREE.MeshBasicMaterial({ color: COLORS.hole }),
    weld: new THREE.MeshStandardMaterial({ color: COLORS.weld, emissive: 0x6a1800, roughness: 0.6 }),
    concrete: new THREE.MeshStandardMaterial({ color: COLORS.concrete, transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.95, side: THREE.DoubleSide }),
    channel: new THREE.MeshStandardMaterial({ color: COLORS.channel, metalness: 0.4, roughness: 0.6 }),
    edge: new THREE.LineBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.6 }),
    concreteEdge: new THREE.LineBasicMaterial({ color: 0xc4ccd6, transparent: true, opacity: 0.45 }),
  };
  private unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 18, 1).translate(0, 0.5, 0);
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private ownGeos = new Set<THREE.BufferGeometry>([this.unitCyl, this.unitBox]);

  constructor(container: HTMLElement | null, opts: PreviewViewOptions = {}) {
    this.container = container;
    this.labels = !!opts.labels;
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts.offscreen });
    this.renderer.setPixelRatio(opts.offscreen ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(900, -1200, 700);
    this.scene.add(new THREE.HemisphereLight(0xeef3ff, 0x30343a, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(0.5, -0.8, 1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-0.6, 0.6, -0.2);
    this.scene.add(sun, fill, this.content, this.labelGroup);
    if (opts.offscreen) {
      this.renderer.setSize(opts.width ?? 220, opts.height ?? 150, false);
      this.camera.aspect = (opts.width ?? 220) / (opts.height ?? 150);
      this.camera.updateProjectionMatrix();
      return;
    }
    if (!container) throw new Error('ConnectionPreview needs a container');
    this.renderer.domElement.className = 'cp-canvas';
    container.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'cp-labels';
    container.appendChild(this.labelRenderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.dirty) return;
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer?.render(this.scene, this.camera);
    };
    loop();
  }

  private resize() {
    if (!this.container) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.labelRenderer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.controls?.dispose();
    this.clear();
    for (const g of this.ownGeos) g.dispose();
    for (const m of this.mats.member.values()) m.dispose();
    for (const [k, m] of Object.entries(this.mats)) if (k !== 'member') (m as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labelRenderer?.domElement.remove();
  }

  private clear() {
    for (const g of [this.content, this.labelGroup]) {
      for (const c of [...g.children]) {
        if (c instanceof CSS2DObject) c.element.remove();
        c.traverse((o) => {
          if (o instanceof CSS2DObject) o.element.remove();
        });
        disposeObject(c, new Set([...cachedGeometries(), ...this.ownGeos]), false);
        g.remove(c);
      }
    }
  }

  private memberMat(role: string): THREE.Material {
    let m = this.mats.member.get(role);
    if (!m) {
      const color = ROLE_COLORS[role as keyof typeof ROLE_COLORS] ?? 0x8899aa;
      m = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false });
      this.mats.member.set(role, m);
    }
    return m;
  }

  setLabels(on: boolean) {
    this.labels = on;
    this.labelGroup.visible = on;
    for (const c of this.labelGroup.children) if (c instanceof CSS2DObject) c.element.style.display = on ? '' : 'none';
    this.dirty = true;
  }

  private label(text: string, at: Vec3, cls = '') {
    const el = document.createElement('div');
    el.className = `cp-label ${cls}`;
    el.textContent = text;
    el.style.display = this.labels ? '' : 'none';
    const o = new CSS2DObject(el);
    o.position.copy(v(at));
    this.labelGroup.add(o);
  }

  /** Replace the content; the camera is kept unless `refit` (or nothing was shown yet). */
  setContent(c: PreviewContent, refit = false) {
    this.clear();
    const { dm, connectionId } = c;
    const focus = new THREE.Box3();
    const plateLabels = new Map<string, { n: number; at: Vec3 }>();
    const co = dm.connectionOut.get(connectionId);
    for (const pt of dm.parts) {
      if (pt.kind === 'plate' && pt.outline) {
        const g = plateGeometry(pt.outline, pt.plateHoles ?? [], pt.thickness);
        const mesh = new THREE.Mesh(g.mesh, this.mats.plate);
        mesh.applyMatrix4(plateMatrix(pt.frame));
        mesh.add(new THREE.LineSegments(g.edges, this.mats.edge));
        this.content.add(mesh);
        if (pt.connectionId === connectionId) {
          mesh.updateMatrixWorld(true);
          focus.expandByObject(mesh);
          const cx = pt.outline.reduce((s, q) => s + q.x, 0) / pt.outline.length;
          const cy = pt.outline.reduce((s, q) => s + q.y, 0) / pt.outline.length;
          const o = pt.frame;
          const at = { x: o.origin.x + o.x.x * cx + o.y.x * cy + o.z.x * pt.thickness, y: o.origin.y + o.x.y * cx + o.y.y * cy + o.z.y * pt.thickness, z: o.origin.z + o.x.z * cx + o.y.z * cy + o.z.z * pt.thickness };
          const text = `${pt.name} · PL${pt.thickness} × ${Math.round(pt.length)} × ${Math.round(pt.width)}`;
          const seen = plateLabels.get(text);
          if (seen) seen.n++;
          else plateLabels.set(text, { n: 1, at });
        }
      } else if (pt.shape) {
        // Members with open end slots (knife / tongue / stem) get their slotted body.
        const slotted = !!pt.slots?.length && !pt.ends;
        const g = slotted ? slottedMemberGeometry(pt) : profileGeometry(pt.profile, pt.shape);
        const isMember = pt.kind === 'member';
        const mesh = new THREE.Mesh(g.mesh, isMember ? this.memberMat(pt.role) : this.mats.cleat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(linearMatrix(pt.frame, slotted ? 1 : pt.length));
        mesh.add(new THREE.LineSegments(g.edges, this.mats.edge));
        mesh.renderOrder = isMember ? 2 : 0;
        this.content.add(mesh);
        const mid = { x: pt.frame.origin.x + (pt.frame.x.x * pt.length) / 2, y: pt.frame.origin.y + (pt.frame.x.y * pt.length) / 2, z: pt.frame.origin.z + (pt.frame.x.z * pt.length) / 2 };
        if (isMember) {
          this.label(pt.profile, mid, 'member');
        } else if (pt.connectionId === connectionId) {
          mesh.updateMatrixWorld(true);
          focus.expandByObject(mesh);
          this.label(`${pt.name} · ${pt.profile} × ${Math.round(pt.length)}`, mid, 'plate');
        }
        // Holes through the walls: dark cylinders (slots: two cylinders and a bar).
        for (const run of holeRuns(pt)) this.addHole(run.a, run.b, run.d, run.slot, run.axis);
      }
    }
    for (const [text, { n, at }] of plateLabels) this.label(n > 1 ? `${n}× ${text}` : text, at, 'plate');
    // Bolts, nuts, washers; anchors and studs.
    for (const b of dm.bolts) {
      if (b.connectionId !== connectionId && !co) continue;
      const size = getBolt(b.size);
      const dir = b.dir;
      const mat = b.kind === 'anchor' ? this.mats.anchor : this.mats.bolt;
      const back = (p: Vec3, s: number) => ({ x: p.x - dir.x * s, y: p.y - dir.y * s, z: p.z - dir.z * s });
      const fwd = (p: Vec3, s: number) => back(p, -s);
      const rev = { x: -dir.x, y: -dir.y, z: -dir.z };
      for (const pos of b.positions) {
        const parts: THREE.Mesh[] = [];
        if (/stud/i.test(b.grade)) {
          const root = fwd(pos, b.grip);
          parts.push(this.cyl(root, dir, size.d, Math.max(1, b.length - b.grip), mat));
          parts.push(this.cyl(fwd(root, b.length - b.grip - 8), dir, size.d * 1.6, 8, mat));
        } else if (b.kind === 'anchor') {
          const top = back(pos, size.washer + size.nut + 3);
          parts.push(this.cyl(top, dir, size.d, b.length, mat));
          parts.push(this.hex(back(pos, size.washer), dir, size.af, size.nut, mat));
          parts.push(this.washer(pos, dir, size));
        } else {
          const start = back(pos, size.washer);
          parts.push(this.cyl(start, dir, size.d, b.length, mat));
          parts.push(this.hex(start, dir, size.af, size.head, mat));
          parts.push(this.washer(pos, dir, size));
          const end = fwd(pos, b.grip);
          parts.push(this.washer(end, rev, size));
          parts.push(this.hex(fwd(end, size.washer), rev, size.af, size.nut, mat));
        }
        for (const m of parts) {
          this.content.add(m);
          m.updateMatrixWorld(true);
          focus.expandByObject(m);
        }
      }
      if (b.positions.length) {
        const n = b.positions.length;
        const c0 = b.positions.reduce((s, q) => ({ x: s.x + q.x / n, y: s.y + q.y / n, z: s.z + q.z / n }), { x: 0, y: 0, z: 0 });
        this.label(`${n}× ${b.size} ${b.kind === 'anchor' ? b.grade.replace(/^anchor – /, '') : b.grade} L${Math.round(b.length)}`, c0, b.kind);
      }
    }
    // Welds.
    for (const [a, b] of weldLines(dm, connectionId)) {
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (len < 0.5) continue;
      const m = new THREE.Mesh(this.unitCyl, this.mats.weld);
      m.applyMatrix4(alongMatrix(a, { x: (b.x - a.x) / len, y: (b.y - a.y) / len, z: (b.z - a.z) / len }, 5, len));
      this.content.add(m);
    }
    // Concrete and channels.
    for (const box of c.boxes) {
      const geo = this.unitBox;
      const mesh = new THREE.Mesh(geo, box.kind === 'concrete' ? this.mats.concrete : this.mats.channel);
      const m = new THREE.Matrix4().makeBasis(v(box.axes[0]).multiplyScalar(box.size[0]), v(box.axes[1]).multiplyScalar(box.size[1]), v(box.axes[2]).multiplyScalar(box.size[2]));
      m.setPosition(v(box.centre));
      mesh.applyMatrix4(m);
      mesh.renderOrder = 3;
      if (box.kind === 'concrete') {
        const eg = new THREE.EdgesGeometry(geo);
        mesh.add(new THREE.LineSegments(eg, this.mats.concreteEdge));
      }
      this.content.add(mesh);
    }
    this.labelGroup.visible = this.labels;
    this.focus = focus.isEmpty() ? new THREE.Box3().setFromObject(this.content) : focus;
    if (refit || !this.fitted) this.fitTo(this.focus);
    this.dirty = true;
  }

  private cyl(pos: Vec3, dir: Vec3, d: number, len: number, mat: THREE.Material) {
    const m = new THREE.Mesh(shankGeo, mat);
    m.applyMatrix4(alongMatrix(pos, dir, d, Math.max(0.5, len)));
    return m;
  }

  private hex(pos: Vec3, dir: Vec3, af: number, h: number, mat: THREE.Material) {
    const m = new THREE.Mesh(headGeo, mat);
    m.applyMatrix4(alongMatrix(pos, dir, af * 1.12, h));
    return m;
  }

  private washer(pos: Vec3, dir: Vec3, size: ReturnType<typeof getBolt>) {
    const m = new THREE.Mesh(this.unitCyl, this.mats.washer);
    const back = { x: pos.x - dir.x * size.washer, y: pos.y - dir.y * size.washer, z: pos.z - dir.z * size.washer };
    m.applyMatrix4(alongMatrix(back, dir, size.washerOD ?? size.d * 2, size.washer));
    return m;
  }

  private addHole(a: Vec3, b: Vec3, d: number, slot: number, axis: Vec3) {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (len < 0.1) return;
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len, z: (b.z - a.z) / len };
    const centres = slot > 0 ? [-slot / 2, slot / 2] : [0];
    for (const s of centres) {
      const m = new THREE.Mesh(this.unitCyl, this.mats.hole);
      m.applyMatrix4(alongMatrix({ x: a.x + axis.x * s, y: a.y + axis.y * s, z: a.z + axis.z * s }, dir, d + 0.4, len));
      this.content.add(m);
    }
    if (slot > 0) {
      const bar = new THREE.Mesh(this.unitBox, this.mats.hole);
      const across = new THREE.Vector3().crossVectors(v(dir), v(axis)).normalize();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      const mtx = new THREE.Matrix4().makeBasis(v(axis).multiplyScalar(slot), across.multiplyScalar(d + 0.4), v(dir).multiplyScalar(len));
      mtx.setPosition(v(mid));
      bar.applyMatrix4(mtx);
      this.content.add(bar);
    }
  }

  /** Frame the box from an isometric-ish direction (keeps the current view direction once fitted). */
  fitTo(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const r = Math.max(170, (size.length() / 2) * 1.15);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = r / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2);
    const dir = this.fitted ? this.camera.position.clone().sub(this.controls?.target ?? centre).normalize() : new THREE.Vector3(0.62, -0.95, 0.55).normalize();
    this.camera.position.copy(centre.clone().add(dir.multiplyScalar(dist)));
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(centre);
    if (this.controls) {
      this.controls.target.copy(centre);
      this.controls.update();
    }
    this.fitted = true;
    this.dirty = true;
  }

  private focus = new THREE.Box3();

  /** Re-frame the connection (fresh isometric view). */
  fit() {
    this.fitted = false;
    this.fitTo(this.focus);
  }

  /** Render now and return a PNG data URL (offscreen thumbnails). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

}

// ---------------------------------------------------------------------------
// Shared offscreen thumbnail renderer

let thumbView: ConnectionPreview | null = null;
const thumbCache = new Map<string, string>();

/** Render a thumbnail (cached by key). Uses one offscreen WebGL context for all thumbnails. */
export function renderThumbnail(key: string, content: PreviewContent): string {
  const hit = thumbCache.get(key);
  if (hit) return hit;
  if (!thumbView) thumbView = new ConnectionPreview(null, { offscreen: true, width: 240, height: 160 });
  thumbView.setContent(content, true);
  const url = thumbView.snapshot();
  thumbCache.set(key, url);
  return url;
}

export function cachedThumbnail(key: string): string | undefined {
  return thumbCache.get(key);
}
