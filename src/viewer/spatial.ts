/**
 * Spatial index for the 3D view: a BVH (core/clash/bvh) over world-space
 * bounding boxes of nodes, wire lines, part solids and bolts, queried with
 * camera frusta (screen rectangles: snapping radius, pick radius, box select)
 * and rays (solid picking). Keeps picking, snapping and box select
 * logarithmic instead of scanning every member on every mouse move.
 */
import * as THREE from 'three';
import { Bvh } from '../core/clash/bvh';
import type { Vec3 } from '../core/model/types';

export class SpatialIndex {
  readonly bvh: Bvh;

  constructor(bounds: Float64Array) {
    this.bvh = new Bvh(bounds, 6);
  }

  get size(): number {
    return this.bvh.count;
  }

  /** Items whose box intersects the frustum. */
  frustum(f: FrustumTest, visit: (id: number) => boolean | void) {
    this.bvh.queryCustom((b, o) => f.classify(b, o), visit);
  }

  /** Items whose box a ray enters before tMax, nearest first; visit may shrink tMax. */
  ray(ray: THREE.Ray, tMax: number, visit: (id: number, t: number) => number | void, pad = 0) {
    this.bvh.queryRay(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, tMax, visit, pad);
  }

  box(min: Vec3, max: Vec3, visit: (id: number) => boolean | void) {
    this.bvh.queryBox(min.x, min.y, min.z, max.x, max.y, max.z, visit);
  }

  /** Index of points. */
  static points(pts: readonly Vec3[], pad = 0): SpatialIndex {
    const b = new Float64Array(pts.length * 6);
    pts.forEach((p, i) => b.set([p.x - pad, p.y - pad, p.z - pad, p.x + pad, p.y + pad, p.z + pad], i * 6));
    return new SpatialIndex(b);
  }

  /** Index of segments. */
  static segments(segs: readonly [Vec3, Vec3][], pad = 0): SpatialIndex {
    const b = new Float64Array(segs.length * 6);
    segs.forEach(([p, q], i) =>
      b.set([Math.min(p.x, q.x) - pad, Math.min(p.y, q.y) - pad, Math.min(p.z, q.z) - pad, Math.max(p.x, q.x) + pad, Math.max(p.y, q.y) + pad, Math.max(p.z, q.z) + pad], i * 6),
    );
    return new SpatialIndex(b);
  }
}

/** Six inward-facing planes; classifies boxes as outside (0), intersecting (1) or inside (2). */
export class FrustumTest {
  /** nx, ny, nz, d per plane: inside when n·p + d ≥ 0. */
  private planes: Float64Array;

  constructor(planes: THREE.Plane[]) {
    this.planes = new Float64Array(planes.length * 4);
    planes.forEach((pl, i) => this.planes.set([pl.normal.x, pl.normal.y, pl.normal.z, pl.constant], i * 4));
  }

  classify(b: Float64Array, o: number): 0 | 1 | 2 {
    let inside = true;
    const P = this.planes;
    for (let i = 0; i < P.length; i += 4) {
      const nx = P[i];
      const ny = P[i + 1];
      const nz = P[i + 2];
      const d = P[i + 3];
      // Farthest corner along the normal (p-vertex) and nearest (n-vertex).
      const px = nx >= 0 ? b[o + 3] : b[o];
      const py = ny >= 0 ? b[o + 4] : b[o + 1];
      const pz = nz >= 0 ? b[o + 5] : b[o + 2];
      if (nx * px + ny * py + nz * pz + d < 0) return 0;
      const qx = nx >= 0 ? b[o] : b[o + 3];
      const qy = ny >= 0 ? b[o + 1] : b[o + 4];
      const qz = nz >= 0 ? b[o + 2] : b[o + 5];
      if (nx * qx + ny * qy + nz * qz + d < 0) inside = false;
    }
    return inside ? 2 : 1;
  }

  containsPoint(p: Vec3): boolean {
    const P = this.planes;
    for (let i = 0; i < P.length; i += 4) if (P[i] * p.x + P[i + 1] * p.y + P[i + 2] * p.z + P[i + 3] < 0) return false;
    return true;
  }

  /**
   * Frustum of a screen rectangle in normalised device coordinates
   * (x0 < x1, y0 < y1 in [-1, 1]) for any camera (perspective or orthographic).
   */
  static fromNdcRect(camera: THREE.Camera, x0: number, y0: number, x1: number, y1: number): FrustumTest {
    camera.updateMatrixWorld();
    const un = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).unproject(camera);
    const n = [un(x0, y0, -1), un(x1, y0, -1), un(x1, y1, -1), un(x0, y1, -1)];
    const f = [un(x0, y0, 1), un(x1, y0, 1), un(x1, y1, 1), un(x0, y1, 1)];
    const centre = new THREE.Vector3();
    for (const v of [...n, ...f]) centre.add(v);
    centre.multiplyScalar(1 / 8);
    const mk = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
      const pl = new THREE.Plane().setFromCoplanarPoints(a, b, c);
      if (pl.distanceToPoint(centre) < 0) pl.negate();
      return pl;
    };
    return new FrustumTest([
      mk(n[0], n[1], n[2]), // near
      mk(f[0], f[2], f[1]), // far
      mk(n[0], f[0], f[3]), // left
      mk(n[1], n[2], f[2]), // right
      mk(n[0], n[1], f[1]), // bottom
      mk(n[3], f[3], f[2]), // top
    ]);
  }
}
