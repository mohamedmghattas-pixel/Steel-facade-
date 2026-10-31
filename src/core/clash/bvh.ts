/**
 * Static bounding-volume hierarchy over axis-aligned boxes. Used as the broad
 * phase of clash detection and by the 3D viewer's spatial index (picking,
 * snapping, box select). Build is O(n log n) with midpoint splits (median
 * fallback); queries visit only overlapping nodes.
 */

export interface BvhQueryStats {
  nodes: number;
  items: number;
}

export class Bvh {
  /** Item bounds: minX, minY, minZ, maxX, maxY, maxZ per item. */
  readonly bounds: Float64Array;
  readonly count: number;
  /** Item ids in leaf order. */
  private order: Uint32Array;
  /** Node bounds (6 per node), children (left; right = left + 1 for inner nodes) and leaf ranges. */
  private nb: Float64Array;
  private left: Int32Array;
  private start: Uint32Array;
  private size: Uint32Array;
  private nodes = 0;

  constructor(bounds: Float64Array, leafSize = 6) {
    this.bounds = bounds;
    this.count = Math.floor(bounds.length / 6);
    const n = this.count;
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const maxNodes = Math.max(1, 2 * n);
    this.nb = new Float64Array(maxNodes * 6);
    this.left = new Int32Array(maxNodes).fill(-1);
    this.start = new Uint32Array(maxNodes);
    this.size = new Uint32Array(maxNodes);
    const centroid = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) centroid[i * 3 + k] = (bounds[i * 6 + k] + bounds[i * 6 + 3 + k]) / 2;
    if (n) this.build(centroid, Math.max(1, leafSize));
    this.nb = this.nb.slice(0, this.nodes * 6);
  }

  private build(centroid: Float64Array, leafSize: number) {
    const stack: [number, number, number][] = [[this.alloc(), 0, this.count]];
    while (stack.length) {
      const [node, s, e] = stack.pop()!;
      // Node bounds and centroid extent.
      const o = node * 6;
      const b = this.nb;
      b[o] = b[o + 1] = b[o + 2] = Infinity;
      b[o + 3] = b[o + 4] = b[o + 5] = -Infinity;
      const cmin = [Infinity, Infinity, Infinity];
      const cmax = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) {
        const id = this.order[i];
        for (let k = 0; k < 3; k++) {
          b[o + k] = Math.min(b[o + k], this.bounds[id * 6 + k]);
          b[o + 3 + k] = Math.max(b[o + 3 + k], this.bounds[id * 6 + 3 + k]);
          const c = centroid[id * 3 + k];
          if (c < cmin[k]) cmin[k] = c;
          if (c > cmax[k]) cmax[k] = c;
        }
      }
      const n = e - s;
      if (n <= leafSize) {
        this.start[node] = s;
        this.size[node] = n;
        continue;
      }
      let axis = 0;
      for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
      let mid = s;
      if (cmax[axis] - cmin[axis] > 1e-9) {
        const split = (cmin[axis] + cmax[axis]) / 2;
        let i = s;
        let j = e - 1;
        while (i <= j) {
          if (centroid[this.order[i] * 3 + axis] < split) i++;
          else {
            const t = this.order[i];
            this.order[i] = this.order[j];
            this.order[j] = t;
            j--;
          }
        }
        mid = i;
      }
      if (mid <= s || mid >= e) {
        // All centroids on one side (or coincident): split at the median.
        const slice = Array.from(this.order.subarray(s, e)).sort((x, y) => centroid[x * 3 + axis] - centroid[y * 3 + axis]);
        this.order.set(slice, s);
        mid = s + (n >> 1);
      }
      const l = this.alloc();
      this.alloc();
      this.left[node] = l;
      stack.push([l, s, mid], [l + 1, mid, e]);
    }
  }

  private alloc(): number {
    return this.nodes++;
  }

  /** Visit items whose box overlaps [min, max]. Return true from `visit` to stop. */
  queryBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, visit: (id: number) => boolean | void, stats?: BvhQueryStats) {
    if (!this.count) return;
    const stack = [0];
    const b = this.nb;
    const ib = this.bounds;
    while (stack.length) {
      const node = stack.pop()!;
      const o = node * 6;
      if (stats) stats.nodes++;
      if (b[o] > maxX || b[o + 1] > maxY || b[o + 2] > maxZ || b[o + 3] < minX || b[o + 4] < minY || b[o + 5] < minZ) continue;
      const l = this.left[node];
      if (l >= 0) {
        stack.push(l, l + 1);
        continue;
      }
      const s = this.start[node];
      const e = s + this.size[node];
      for (let i = s; i < e; i++) {
        const id = this.order[i];
        const k = id * 6;
        if (ib[k] > maxX || ib[k + 1] > maxY || ib[k + 2] > maxZ || ib[k + 3] < minX || ib[k + 4] < minY || ib[k + 5] < minZ) continue;
        if (stats) stats.items++;
        if (visit(id)) return;
      }
    }
  }

  /**
   * Visit items whose box (grown by `pad`) a ray from `o` along `d` enters
   * before `tMax`, nearest node first. `visit` gets the entry distance and may
   * return a smaller tMax (e.g. after an exact hit) to prune the rest.
   */
  queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, visit: (id: number, tEnter: number) => number | void, pad = 0) {
    if (!this.count) return;
    const inv = [1 / dx, 1 / dy, 1 / dz];
    const org = [ox, oy, oz];
    const slab = (arr: Float64Array, o: number, limit: number): number => {
      let t0 = 0;
      let t1 = limit;
      for (let k = 0; k < 3; k++) {
        const lo = arr[o + k] - pad;
        const hi = arr[o + 3 + k] + pad;
        if (!Number.isFinite(inv[k])) {
          if (org[k] < lo || org[k] > hi) return -1;
          continue;
        }
        let a = (lo - org[k]) * inv[k];
        let c = (hi - org[k]) * inv[k];
        if (a > c) [a, c] = [c, a];
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
        if (t0 > t1) return -1;
      }
      return t0;
    };
    let limit = tMax;
    const stack: [number, number][] = [[0, 0]];
    while (stack.length) {
      const [node, tn] = stack.pop()!;
      if (tn > limit) continue;
      const l = this.left[node];
      if (l >= 0) {
        const ta = slab(this.nb, l * 6, limit);
        const tb = slab(this.nb, (l + 1) * 6, limit);
        // Push the farther child first so the nearer one is visited first.
        if (ta >= 0 && tb >= 0) {
          if (ta < tb) stack.push([l + 1, tb], [l, ta]);
          else stack.push([l, ta], [l + 1, tb]);
        } else if (ta >= 0) stack.push([l, ta]);
        else if (tb >= 0) stack.push([l + 1, tb]);
        continue;
      }
      if (node === 0 && slab(this.nb, 0, limit) < 0) return;
      const s = this.start[node];
      const e = s + this.size[node];
      for (let i = s; i < e; i++) {
        const id = this.order[i];
        const t = slab(this.bounds, id * 6, limit);
        if (t < 0) continue;
        const r = visit(id, t);
        if (typeof r === 'number' && r < limit) limit = r;
      }
    }
  }

  /**
   * Visit items for which `test(minX, minY, minZ, maxX, maxY, maxZ)` holds on
   * their node chain (e.g. frustum–box tests). `test` returns 0 = outside,
   * 1 = intersects, 2 = fully inside (children are then accepted without testing).
   */
  queryCustom(test: (b: Float64Array, o: number) => 0 | 1 | 2, visit: (id: number) => boolean | void) {
    if (!this.count) return;
    const stack: [number, boolean][] = [[0, false]];
    while (stack.length) {
      const [node, inside] = stack.pop()!;
      const r = inside ? 2 : test(this.nb, node * 6);
      if (r === 0) continue;
      const l = this.left[node];
      if (l >= 0) {
        stack.push([l, r === 2], [l + 1, r === 2]);
        continue;
      }
      const s = this.start[node];
      const e = s + this.size[node];
      for (let i = s; i < e; i++) {
        const id = this.order[i];
        if (r === 2 || test(this.bounds, id * 6) !== 0) if (visit(id)) return;
      }
    }
  }
}

/** Bounds array for n items, filled by `fill(i, out, offset)`. */
export function boundsArray(n: number, fill: (i: number, out: Float64Array, o: number) => void): Float64Array {
  const out = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) fill(i, out, i * 6);
  return out;
}
