/**
 * A bounding volume hierarchy over a triangle soup.
 *
 * Built with binned SAH rather than a median split: a flat's proxy mesh is
 * wildly non-uniform (a 200k-triangle sofa next to a 2-triangle wall) and
 * median splitting produces hierarchies with 3-4x the traversal cost on exactly
 * the rays the viewer casts most -- long horizontal rays down a hall. 12 bins
 * is the usual knee: beyond that the build slows measurably and the tree stops
 * improving.
 *
 * Everything lives in typed arrays and the traversal allocates nothing, because
 * this runs per frame and a garbage collection pause is a visible stutter.
 */

const BIN_COUNT = 12;
const MAX_LEAF_TRIS = 4;
/** Below this, a triangle cannot be hit reliably and only pollutes the SAH. */
const MIN_TRI_AREA = 1e-10;

export interface BvhRayHit {
  /** Index into the ORIGINAL triangle list, not the internal permutation. */
  tri: number;
  t: number;
  u: number;
  v: number;
}

export interface BvhClosest {
  tri: number;
  distance: number;
  px: number;
  py: number;
  pz: number;
}

export class Bvh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Triangles that survived the degeneracy filter, in build order. */
  private readonly triRef: Uint32Array;
  private readonly triMin: Float32Array;
  private readonly triMax: Float32Array;
  private readonly triCentroid: Float32Array;
  /**
   * Triangle corner indices in BVH order, so a leaf reads three contiguous
   * words instead of chasing `triRef` back into the caller's index buffer.
   * Worth about a third of the traversal time on a real proxy mesh.
   */
  private orderedIndices: Uint32Array;
  private readonly nodeMin: Float32Array;
  private readonly nodeMax: Float32Array;
  private readonly nodeLeftFirst: Int32Array;
  private readonly nodeCount: Int32Array;
  private nodesUsed = 0;
  readonly triangleCount: number;
  readonly skippedTriangles: number;

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.positions = positions;
    this.indices = indices;

    const total = Math.floor(indices.length / 3);
    const vertCount = Math.floor(positions.length / 3);
    const refs = new Uint32Array(total);
    const tmin = new Float32Array(total * 3);
    const tmax = new Float32Array(total * 3);
    const cent = new Float32Array(total * 3);
    let kept = 0;

    for (let t = 0; t < total; t++) {
      const i0 = indices[t * 3]!;
      const i1 = indices[t * 3 + 1]!;
      const i2 = indices[t * 3 + 2]!;
      if (i0 >= vertCount || i1 >= vertCount || i2 >= vertCount) continue;
      const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!;
      const bx = positions[i1 * 3]!, by = positions[i1 * 3 + 1]!, bz = positions[i1 * 3 + 2]!;
      const cx = positions[i2 * 3]!, cy = positions[i2 * 3 + 1]!, cz = positions[i2 * 3 + 2]!;
      const sum = ax + ay + az + bx + by + bz + cx + cy + cz;
      if (!Number.isFinite(sum)) continue; // NaN/Inf vertices: drop the triangle
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      if (0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) < MIN_TRI_AREA) continue;

      refs[kept] = t;
      const mnx = Math.min(ax, bx, cx), mny = Math.min(ay, by, cy), mnz = Math.min(az, bz, cz);
      const mxx = Math.max(ax, bx, cx), mxy = Math.max(ay, by, cy), mxz = Math.max(az, bz, cz);
      tmin[kept * 3] = mnx; tmin[kept * 3 + 1] = mny; tmin[kept * 3 + 2] = mnz;
      tmax[kept * 3] = mxx; tmax[kept * 3 + 1] = mxy; tmax[kept * 3 + 2] = mxz;
      cent[kept * 3] = (ax + bx + cx) / 3;
      cent[kept * 3 + 1] = (ay + by + cy) / 3;
      cent[kept * 3 + 2] = (az + bz + cz) / 3;
      kept++;
    }

    this.triangleCount = kept;
    this.skippedTriangles = total - kept;
    this.triRef = refs.subarray(0, kept);
    this.triMin = tmin.subarray(0, kept * 3);
    this.triMax = tmax.subarray(0, kept * 3);
    this.triCentroid = cent.subarray(0, kept * 3);

    const maxNodes = Math.max(1, 2 * kept);
    this.nodeMin = new Float32Array(maxNodes * 3);
    this.nodeMax = new Float32Array(maxNodes * 3);
    this.nodeLeftFirst = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    this.orderedIndices = new Uint32Array(0);
    this.build();

    const ordered = new Uint32Array(kept * 3);
    for (let i = 0; i < kept; i++) {
      const t = this.triRef[i]!;
      ordered[i * 3] = indices[t * 3]!;
      ordered[i * 3 + 1] = indices[t * 3 + 1]!;
      ordered[i * 3 + 2] = indices[t * 3 + 2]!;
    }
    this.orderedIndices = ordered;
  }

  get nodeCountUsed(): number { return this.nodesUsed; }

  private setNodeBounds(node: number, first: number, count: number): void {
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = first; i < first + count; i++) {
      const b = i * 3;
      if (this.triMin[b]! < mnx) mnx = this.triMin[b]!;
      if (this.triMin[b + 1]! < mny) mny = this.triMin[b + 1]!;
      if (this.triMin[b + 2]! < mnz) mnz = this.triMin[b + 2]!;
      if (this.triMax[b]! > mxx) mxx = this.triMax[b]!;
      if (this.triMax[b + 1]! > mxy) mxy = this.triMax[b + 1]!;
      if (this.triMax[b + 2]! > mxz) mxz = this.triMax[b + 2]!;
    }
    this.nodeMin[node * 3] = mnx; this.nodeMin[node * 3 + 1] = mny; this.nodeMin[node * 3 + 2] = mnz;
    this.nodeMax[node * 3] = mxx; this.nodeMax[node * 3 + 1] = mxy; this.nodeMax[node * 3 + 2] = mxz;
  }

  private swapTri(i: number, j: number): void {
    if (i === j) return;
    const r = this.triRef[i]!; this.triRef[i] = this.triRef[j]!; this.triRef[j] = r;
    for (let k = 0; k < 3; k++) {
      let tmp = this.triMin[i * 3 + k]!;
      this.triMin[i * 3 + k] = this.triMin[j * 3 + k]!; this.triMin[j * 3 + k] = tmp;
      tmp = this.triMax[i * 3 + k]!;
      this.triMax[i * 3 + k] = this.triMax[j * 3 + k]!; this.triMax[j * 3 + k] = tmp;
      tmp = this.triCentroid[i * 3 + k]!;
      this.triCentroid[i * 3 + k] = this.triCentroid[j * 3 + k]!; this.triCentroid[j * 3 + k] = tmp;
    }
  }

  private build(): void {
    this.nodesUsed = 1;
    if (this.triangleCount === 0) {
      this.nodeMin.fill(Infinity, 0, 3);
      this.nodeMax.fill(-Infinity, 0, 3);
      this.nodeLeftFirst[0] = 0;
      this.nodeCount[0] = 0;
      return;
    }
    this.nodeLeftFirst[0] = 0;
    this.nodeCount[0] = this.triangleCount;
    this.setNodeBounds(0, 0, this.triangleCount);

    const stack: number[] = [0];
    const binMin = new Float32Array(BIN_COUNT * 3);
    const binMax = new Float32Array(BIN_COUNT * 3);
    const binCount = new Int32Array(BIN_COUNT);
    const leftArea = new Float64Array(BIN_COUNT);
    const leftCount = new Int32Array(BIN_COUNT);
    // Accumulated bounds to the left of each candidate plane, kept so the
    // chosen split hands its children their bounds directly. Recomputing them
    // with a second pass over the node's triangles is the single most
    // expensive avoidable thing a binned-SAH build does.
    const leftBounds = new Float64Array(BIN_COUNT * 6);

    while (stack.length > 0) {
      const node = stack.pop()!;
      const first = this.nodeLeftFirst[node]!;
      const count = this.nodeCount[node]!;
      if (count <= MAX_LEAF_TRIS) continue;

      // Split axis: widest spread of centroids, not of bounds -- bounds spread
      // is dominated by a few large triangles and picks bad axes.
      let cmnx = Infinity, cmny = Infinity, cmnz = Infinity;
      let cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
      for (let i = first; i < first + count; i++) {
        const c = i * 3;
        const x = this.triCentroid[c]!, y = this.triCentroid[c + 1]!, z = this.triCentroid[c + 2]!;
        if (x < cmnx) cmnx = x; if (x > cmxx) cmxx = x;
        if (y < cmny) cmny = y; if (y > cmxy) cmxy = y;
        if (z < cmnz) cmnz = z; if (z > cmxz) cmxz = z;
      }
      const ex = cmxx - cmnx, ey = cmxy - cmny, ez = cmxz - cmnz;
      let axis = 0;
      let lo = cmnx, hi = cmxx;
      if (ey > ex && ey >= ez) { axis = 1; lo = cmny; hi = cmxy; }
      else if (ez > ex && ez > ey) { axis = 2; lo = cmnz; hi = cmxz; }
      if (!(hi - lo > 1e-12)) continue; // coincident centroids: leave as a leaf

      binMin.fill(Infinity); binMax.fill(-Infinity); binCount.fill(0);
      const scale = BIN_COUNT / (hi - lo);
      for (let i = first; i < first + count; i++) {
        const c = this.triCentroid[i * 3 + axis]!;
        let b = Math.floor((c - lo) * scale);
        if (b < 0) b = 0; else if (b >= BIN_COUNT) b = BIN_COUNT - 1;
        binCount[b]!++;
        for (let k = 0; k < 3; k++) {
          if (this.triMin[i * 3 + k]! < binMin[b * 3 + k]!) binMin[b * 3 + k] = this.triMin[i * 3 + k]!;
          if (this.triMax[i * 3 + k]! > binMax[b * 3 + k]!) binMax[b * 3 + k] = this.triMax[i * 3 + k]!;
        }
      }

      // Forward sweep: surface area and count of everything left of each plane.
      let amnx = Infinity, amny = Infinity, amnz = Infinity;
      let amxx = -Infinity, amxy = -Infinity, amxz = -Infinity;
      let acc = 0;
      for (let b = 0; b < BIN_COUNT - 1; b++) {
        acc += binCount[b]!;
        if (binCount[b]! > 0) {
          amnx = Math.min(amnx, binMin[b * 3]!); amxx = Math.max(amxx, binMax[b * 3]!);
          amny = Math.min(amny, binMin[b * 3 + 1]!); amxy = Math.max(amxy, binMax[b * 3 + 1]!);
          amnz = Math.min(amnz, binMin[b * 3 + 2]!); amxz = Math.max(amxz, binMax[b * 3 + 2]!);
        }
        leftCount[b] = acc;
        leftArea[b] = acc === 0 ? 0 : surfaceArea(amxx - amnx, amxy - amny, amxz - amnz);
        leftBounds[b * 6] = amnx; leftBounds[b * 6 + 1] = amny; leftBounds[b * 6 + 2] = amnz;
        leftBounds[b * 6 + 3] = amxx; leftBounds[b * 6 + 4] = amxy; leftBounds[b * 6 + 5] = amxz;
      }

      // Backward sweep, evaluating the SAH at each candidate plane as we go.
      let bmnx = Infinity, bmny = Infinity, bmnz = Infinity;
      let bmxx = -Infinity, bmxy = -Infinity, bmxz = -Infinity;
      let racc = 0;
      let bestCost = Infinity;
      let bestSplit = -1;
      let rmnx = 0, rmny = 0, rmnz = 0, rmxx = 0, rmxy = 0, rmxz = 0;
      for (let b = BIN_COUNT - 1; b > 0; b--) {
        racc += binCount[b]!;
        if (binCount[b]! > 0) {
          bmnx = Math.min(bmnx, binMin[b * 3]!); bmxx = Math.max(bmxx, binMax[b * 3]!);
          bmny = Math.min(bmny, binMin[b * 3 + 1]!); bmxy = Math.max(bmxy, binMax[b * 3 + 1]!);
          bmnz = Math.min(bmnz, binMin[b * 3 + 2]!); bmxz = Math.max(bmxz, binMax[b * 3 + 2]!);
        }
        const lc = leftCount[b - 1]!;
        if (lc === 0 || racc === 0) continue;
        const rArea = surfaceArea(bmxx - bmnx, bmxy - bmny, bmxz - bmnz);
        const cost = leftCount[b - 1]! * leftArea[b - 1]! + racc * rArea;
        if (cost < bestCost) {
          bestCost = cost;
          bestSplit = b;
          rmnx = bmnx; rmny = bmny; rmnz = bmnz;
          rmxx = bmxx; rmxy = bmxy; rmxz = bmxz;
        }
      }

      const parentArea = surfaceArea(
        this.nodeMax[node * 3]! - this.nodeMin[node * 3]!,
        this.nodeMax[node * 3 + 1]! - this.nodeMin[node * 3 + 1]!,
        this.nodeMax[node * 3 + 2]! - this.nodeMin[node * 3 + 2]!,
      );
      const leafCost = count * parentArea;
      if (bestSplit < 0 || bestCost >= leafCost) continue;

      // Partition in place around the chosen plane.
      let i = first;
      let j = first + count - 1;
      while (i <= j) {
        const c = this.triCentroid[i * 3 + axis]!;
        let b = Math.floor((c - lo) * scale);
        if (b < 0) b = 0; else if (b >= BIN_COUNT) b = BIN_COUNT - 1;
        if (b < bestSplit) i++;
        else { this.swapTri(i, j); j--; }
      }
      const leftN = i - first;
      if (leftN === 0 || leftN === count) continue;

      const left = this.nodesUsed++;
      const right = this.nodesUsed++;
      this.nodeLeftFirst[left] = first;
      this.nodeCount[left] = leftN;
      this.nodeLeftFirst[right] = i;
      this.nodeCount[right] = count - leftN;
      const lb = (bestSplit - 1) * 6;
      this.nodeMin[left * 3] = leftBounds[lb]!;
      this.nodeMin[left * 3 + 1] = leftBounds[lb + 1]!;
      this.nodeMin[left * 3 + 2] = leftBounds[lb + 2]!;
      this.nodeMax[left * 3] = leftBounds[lb + 3]!;
      this.nodeMax[left * 3 + 1] = leftBounds[lb + 4]!;
      this.nodeMax[left * 3 + 2] = leftBounds[lb + 5]!;
      this.nodeMin[right * 3] = rmnx;
      this.nodeMin[right * 3 + 1] = rmny;
      this.nodeMin[right * 3 + 2] = rmnz;
      this.nodeMax[right * 3] = rmxx;
      this.nodeMax[right * 3 + 1] = rmxy;
      this.nodeMax[right * 3 + 2] = rmxz;
      this.nodeLeftFirst[node] = left;
      this.nodeCount[node] = 0;
      stack.push(left, right);
    }
  }

  /**
   * Nearest triangle along the ray. `dir` need not be unit; `t` is returned in
   * units of `dir`, and `maxDistance` is measured in the same units.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance = Infinity,
    skip?: (originalTri: number) => boolean,
  ): BvhRayHit | null {
    if (this.triangleCount === 0) return null;
    if (!Number.isFinite(ox + oy + oz + dx + dy + dz)) return null;
    if (dx === 0 && dy === 0 && dz === 0) return null;

    const idx = this.orderedIndices;
    const pos = this.positions;
    const invx = 1 / dx, invy = 1 / dy, invz = 1 / dz;

    let bestT = maxDistance;
    let bestTri = -1;
    let bestU = 0, bestV = 0;

    const stack = RAY_STACK;
    const tstack = RAY_TSTACK;
    let sp = 0;
    const rootEntry = this.slabEntry(0, ox, oy, oz, invx, invy, invz, bestT);
    if (rootEntry === Infinity) return null;
    stack[0] = 0; tstack[0] = rootEntry; sp = 1;

    while (sp > 0) {
      sp--;
      const node = stack[sp]!;
      if (tstack[sp]! >= bestT) continue;

      const count = this.nodeCount[node]!;
      if (count > 0) {
        const first = this.nodeLeftFirst[node]!;
        for (let i = first; i < first + count; i++) {
          const i0 = idx[i * 3]! * 3, i1 = idx[i * 3 + 1]! * 3, i2 = idx[i * 3 + 2]! * 3;
          const ax = pos[i0]!, ay = pos[i0 + 1]!, az = pos[i0 + 2]!;
          const e1x = pos[i1]! - ax, e1y = pos[i1 + 1]! - ay, e1z = pos[i1 + 2]! - az;
          const e2x = pos[i2]! - ax, e2y = pos[i2 + 1]! - ay, e2z = pos[i2 + 2]! - az;
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det;
          const tx = ox - ax, ty = oy - ay, tz = oz - az;
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < -1e-9 || u > 1 + 1e-9) continue;
          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < -1e-9 || u + v > 1 + 1e-9) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (!(t > 1e-9 && t < bestT)) continue;
          // The skip test runs last: it is the only part of the inner loop that
          // can call out to user code, and most triangles never reach here.
          const orig = this.triRef[i]!;
          if (skip && skip(orig)) continue;
          bestT = t; bestTri = orig; bestU = u; bestV = v;
        }
      } else {
        const l = this.nodeLeftFirst[node]!;
        const el = this.slabEntry(l, ox, oy, oz, invx, invy, invz, bestT);
        const er = this.slabEntry(l + 1, ox, oy, oz, invx, invy, invz, bestT);
        // Push the far child first so the near one is examined first and its
        // hit tightens bestT before the far subtree is ever opened.
        if (el <= er) {
          if (er !== Infinity) { stack[sp] = l + 1; tstack[sp] = er; sp++; }
          if (el !== Infinity) { stack[sp] = l; tstack[sp] = el; sp++; }
        } else {
          if (el !== Infinity) { stack[sp] = l; tstack[sp] = el; sp++; }
          if (er !== Infinity) { stack[sp] = l + 1; tstack[sp] = er; sp++; }
        }
      }
    }

    if (bestTri < 0) return null;
    return { tri: bestTri, t: bestT, u: bestU, v: bestV };
  }

  /**
   * Ray entry distance for a node's box, or Infinity when the ray misses it or
   * enters beyond `limit`. The +/-Infinity produced by a zero direction
   * component is handled by the min/max ordering rather than by branching.
   */
  private slabEntry(
    node: number,
    ox: number, oy: number, oz: number,
    invx: number, invy: number, invz: number,
    limit: number,
  ): number {
    const nm = node * 3;
    let t0 = (this.nodeMin[nm]! - ox) * invx;
    let t1 = (this.nodeMax[nm]! - ox) * invx;
    let tmin = t0 < t1 ? t0 : t1;
    let tmax = t0 < t1 ? t1 : t0;
    t0 = (this.nodeMin[nm + 1]! - oy) * invy;
    t1 = (this.nodeMax[nm + 1]! - oy) * invy;
    const amin = t0 < t1 ? t0 : t1;
    const amax = t0 < t1 ? t1 : t0;
    if (amin > tmin) tmin = amin;
    if (amax < tmax) tmax = amax;
    t0 = (this.nodeMin[nm + 2]! - oz) * invz;
    t1 = (this.nodeMax[nm + 2]! - oz) * invz;
    const bmin = t0 < t1 ? t0 : t1;
    const bmax = t0 < t1 ? t1 : t0;
    if (bmin > tmin) tmin = bmin;
    if (bmax < tmax) tmax = bmax;
    if (tmin < 0) tmin = 0;
    if (!(tmax >= tmin) || tmin >= limit) return Infinity;
    return tmin;
  }

  /**
   * Every triangle whose own bounds overlap the box, by original index.
   * Filtered per triangle, not just per node, so a caller can treat the result
   * as a real candidate set rather than a node dump.
   */
  queryAabb(
    mnx: number, mny: number, mnz: number,
    mxx: number, mxy: number, mxz: number,
    visit: (originalTri: number) => void,
  ): void {
    if (this.triangleCount === 0) return;
    const stack = AABB_STACK;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      const nm = node * 3;
      if (
        this.nodeMin[nm]! > mxx || this.nodeMax[nm]! < mnx ||
        this.nodeMin[nm + 1]! > mxy || this.nodeMax[nm + 1]! < mny ||
        this.nodeMin[nm + 2]! > mxz || this.nodeMax[nm + 2]! < mnz
      ) continue;
      const count = this.nodeCount[node]!;
      if (count > 0) {
        const first = this.nodeLeftFirst[node]!;
        for (let i = first; i < first + count; i++) {
          const b = i * 3;
          if (
            this.triMin[b]! > mxx || this.triMax[b]! < mnx ||
            this.triMin[b + 1]! > mxy || this.triMax[b + 1]! < mny ||
            this.triMin[b + 2]! > mxz || this.triMax[b + 2]! < mnz
          ) continue;
          visit(this.triRef[i]!);
        }
      } else {
        const l = this.nodeLeftFirst[node]!;
        stack[sp++] = l;
        stack[sp++] = l + 1;
      }
    }
  }

  /**
   * Closest point on any triangle to p, within maxDistance.
   * Depth-first with the near child first and a running-best cut, which is what
   * makes a clearance query cost about the same as a raycast.
   */
  closestPoint(
    px: number, py: number, pz: number,
    maxDistance = Infinity,
    skip?: (originalTri: number) => boolean,
  ): BvhClosest | null {
    if (this.triangleCount === 0) return null;
    let best = maxDistance;
    let bestTri = -1;
    let bx = 0, by = 0, bz = 0;
    const idx = this.orderedIndices;
    const pos = this.positions;

    const stack = NEAR_STACK;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      if (this.nodeDistance(node, px, py, pz) >= best) continue;
      const count = this.nodeCount[node]!;
      if (count > 0) {
        const first = this.nodeLeftFirst[node]!;
        for (let i = first; i < first + count; i++) {
          const orig = this.triRef[i]!;
          if (skip && skip(orig)) continue;
          const i0 = idx[i * 3]! * 3, i1 = idx[i * 3 + 1]! * 3, i2 = idx[i * 3 + 2]! * 3;
          const c = closestOnTriScalar(
            px, py, pz,
            pos[i0]!, pos[i0 + 1]!, pos[i0 + 2]!,
            pos[i1]!, pos[i1 + 1]!, pos[i1 + 2]!,
            pos[i2]!, pos[i2 + 1]!, pos[i2 + 2]!,
          );
          const dx = c[0] - px, dy = c[1] - py, dz = c[2] - pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < best) { best = d; bestTri = orig; bx = c[0]; by = c[1]; bz = c[2]; }
        }
      } else {
        const l = this.nodeLeftFirst[node]!;
        const dl = this.nodeDistance(l, px, py, pz);
        const dr = this.nodeDistance(l + 1, px, py, pz);
        // Push the far child first so the near one is popped first.
        if (dl < dr) { stack[sp++] = l + 1; stack[sp++] = l; }
        else { stack[sp++] = l; stack[sp++] = l + 1; }
      }
    }
    if (bestTri < 0) return null;
    return { tri: bestTri, distance: best, px: bx, py: by, pz: bz };
  }

  private nodeDistance(node: number, px: number, py: number, pz: number): number {
    const nm = node * 3;
    const cx = Math.min(Math.max(px, this.nodeMin[nm]!), this.nodeMax[nm]!);
    const cy = Math.min(Math.max(py, this.nodeMin[nm + 1]!), this.nodeMax[nm + 1]!);
    const cz = Math.min(Math.max(pz, this.nodeMin[nm + 2]!), this.nodeMax[nm + 2]!);
    const dx = cx - px, dy = cy - py, dz = cz - pz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

function surfaceArea(ex: number, ey: number, ez: number): number {
  if (!(ex >= 0) || !(ey >= 0) || !(ez >= 0)) return 0;
  return 2 * (ex * ey + ey * ez + ez * ex);
}

/**
 * Per-operation traversal stacks, shared across calls to remove an allocation
 * from every ray. Each traversal gets its own stack so that a callback passed
 * to `queryAabb` may safely cast a ray, which the collision path does.
 * 256 is far above the depth a SAH tree over a flat reaches (about
 * log2(200k/4) ~= 16, with generous slack for adversarial geometry).
 */
const RAY_STACK = new Int32Array(256);
const RAY_TSTACK = new Float64Array(256);
const AABB_STACK = new Int32Array(256);
const NEAR_STACK = new Int32Array(256);

function closestOnTriScalar(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const den = d1 - d3;
    const v = den !== 0 ? d1 / den : 0;
    return [ax + abx * v, ay + aby * v, az + abz * v];
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const den = d2 - d6;
    const w = den !== 0 ? d2 / den : 0;
    return [ax + acx * w, ay + acy * w, az + acz * w];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const den = (d4 - d3) + (d5 - d6);
    const w = den !== 0 ? (d4 - d3) / den : 0;
    return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w];
  }

  const den = va + vb + vc;
  if (!(Math.abs(den) > 0)) return [ax, ay, az];
  const v = vb / den;
  const w = vc / den;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}
