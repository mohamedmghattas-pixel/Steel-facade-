import * as THREE from 'three';
import type { Underlay, Vec2, Vec3, WorkPlane } from '../core/model/types';
import { planeAxes, planeToWorld } from '../core/model/geometry';
import { v } from './meshes';

/**
 * IFC reference models (concrete frames, primary steel) are tessellated with
 * web-ifc and shown as translucent, snappable meshes. web-ifc returns Y-up
 * metres; the scene is Z-up millimetres.
 */
let apiPromise: Promise<import('web-ifc').IfcAPI> | null = null;

async function ifcApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const [{ IfcAPI }, { default: wasmUrl }] = await Promise.all([import('web-ifc'), import('web-ifc/web-ifc.wasm?url')]);
      const api = new IfcAPI();
      await api.Init(() => wasmUrl, true);
      return api;
    })();
  }
  return apiPromise;
}

export interface IfcLoadResult {
  group: THREE.Group;
  meshCount: number;
  schema: string;
}

export async function loadIfcReference(bytes: ArrayBuffer, opacity = 0.35): Promise<IfcLoadResult> {
  const api = await ifcApi();
  const id = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: false });
  if (id < 0) throw new Error('Could not open the IFC file.');
  const schema = api.GetModelSchema(id);
  // Merge triangles per colour to keep draw calls low.
  const buckets = new Map<string, { pos: number[]; nrm: number[]; idx: number[]; color: THREE.Color; alpha: number }>();
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  // Y-up metres → Z-up millimetres.
  const toZup = new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(1000, 1000, 1000));
  let meshCount = 0;
  api.StreamAllMeshes(id, (mesh) => {
    const geoms = mesh.geometries;
    for (let i = 0; i < geoms.size(); i++) {
      const pg = geoms.get(i);
      const geom = api.GetGeometry(id, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const index = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      m.fromArray(pg.flatTransformation).premultiply(toZup);
      nm.getNormalMatrix(m);
      const key = `${pg.color.x.toFixed(2)},${pg.color.y.toFixed(2)},${pg.color.z.toFixed(2)},${pg.color.w.toFixed(2)}`;
      let b = buckets.get(key);
      if (!b) {
        b = { pos: [], nrm: [], idx: [], color: new THREE.Color(pg.color.x, pg.color.y, pg.color.z), alpha: pg.color.w };
        buckets.set(key, b);
      }
      const base = b.pos.length / 3;
      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let k = 0; k < verts.length; k += 6) {
        p.set(verts[k], verts[k + 1], verts[k + 2]).applyMatrix4(m);
        n.set(verts[k + 3], verts[k + 4], verts[k + 5]).applyMatrix3(nm).normalize();
        b.pos.push(p.x, p.y, p.z);
        b.nrm.push(n.x, n.y, n.z);
      }
      for (let k = 0; k < index.length; k++) b.idx.push(base + index[k]);
      geom.delete();
      meshCount++;
    }
  });
  api.CloseModel(id);
  const group = new THREE.Group();
  for (const b of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setIndex(b.idx);
    const mat = new THREE.MeshStandardMaterial({
      color: b.color.clone().lerp(new THREE.Color(0xb8c0cc), 0.5),
      transparent: true,
      opacity: Math.min(opacity, b.alpha),
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    group.add(new THREE.Mesh(g, mat));
  }
  return { group, meshCount, schema };
}

export function setGroupOpacity(group: THREE.Object3D, opacity: number) {
  group.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (mat && 'opacity' in mat) {
      mat.opacity = opacity;
      mat.transparent = opacity < 1;
    }
  });
}

/** DXF linework placed on a work plane as reference lines. */
export function dxfReferenceObject(
  segments: { a: Vec3; b: Vec3 }[],
  plane: WorkPlane,
  scale: number,
  offset: Vec2,
): { object: THREE.LineSegments; points: Vec3[] } {
  const pts: THREE.Vector3[] = [];
  const snap: Vec3[] = [];
  for (const s of segments) {
    const a = planeToWorld(plane, s.a.x * scale + offset.x, s.a.y * scale + offset.y);
    const b = planeToWorld(plane, s.b.x * scale + offset.x, s.b.y * scale + offset.y);
    pts.push(v(a), v(b));
    snap.push(a, b);
  }
  const object = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xc07a3a, transparent: true, opacity: 0.8 }),
  );
  return { object, points: snap };
}

// ---------------------------------------------------------------------------
// Underlays (PDF pages or images of shop drawings for tracing)

export interface UnderlayImage {
  texture: THREE.Texture;
  width: number;
  height: number;
}

export async function loadUnderlayImage(kind: 'pdf' | 'image', bytes: ArrayBuffer, page = 1): Promise<UnderlayImage> {
  if (kind === 'image') {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const texture = new THREE.Texture(bmp as unknown as HTMLImageElement);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, width: bmp.width, height: bmp.height };
  }
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  const pg = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
  const base = pg.getViewport({ scale: 1 });
  const scale = Math.min(4, 4096 / Math.max(base.width, base.height));
  const vp = pg.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pg.render({ canvasContext: ctx, viewport: vp, canvas } as Parameters<typeof pg.render>[0]).promise;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Report size in PDF points × render scale so 1 px ≈ 1 rendered pixel.
  return { texture, width: canvas.width, height: canvas.height };
}

export function underlayMesh(u: Underlay, img: UnderlayImage): THREE.Mesh {
  const w = img.width * u.mmPerPx;
  const h = img.height * u.mmPerPx;
  const geo = new THREE.PlaneGeometry(w, h).translate(w / 2, h / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    map: img.texture,
    transparent: true,
    opacity: u.opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  placeUnderlay(mesh, u);
  mesh.renderOrder = -1;
  mesh.userData = { underlay: u.id };
  return mesh;
}

export function placeUnderlay(mesh: THREE.Object3D, u: Underlay) {
  const ax = planeAxes(u.plane);
  const r = (u.rotation * Math.PI) / 180;
  const uu = v(ax.u).multiplyScalar(Math.cos(r)).add(v(ax.v).multiplyScalar(Math.sin(r)));
  const vv = v(ax.v).multiplyScalar(Math.cos(r)).sub(v(ax.u).multiplyScalar(Math.sin(r)));
  const n = new THREE.Vector3().crossVectors(uu, vv);
  const m = new THREE.Matrix4().makeBasis(uu, vv, n);
  const o = v(planeToWorld(u.plane, u.origin.x, u.origin.y)).addScaledVector(v(ax.n), -2);
  m.setPosition(o);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(m);
  mesh.matrixWorldNeedsUpdate = true;
}
