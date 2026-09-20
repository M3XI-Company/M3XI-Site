export interface Bounds2 {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/**
 * A uniform bucket grid over the XZ plane, stored CSR-style.
 *
 * Rooms and unobserved regions are a handful of large, mostly axis-aligned
 * boxes, so a grid beats an interval tree here: build is linear, lookup is a
 * pair of divisions, and the constant factor is what matters when `roomAt` runs
 * once per frame per camera. Items are bucketed by their XZ bounds, so a lookup
 * returns a small candidate set that still needs the exact polygon test.
 */
export class XZGrid {
  private readonly originX: number;
  private readonly originZ: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  readonly empty: boolean;

  constructor(bounds: readonly Bounds2[], targetPerAxis = 0) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of bounds) {
      if (!Number.isFinite(b.minX + b.minZ + b.maxX + b.maxZ)) continue;
      if (b.minX < minX) minX = b.minX;
      if (b.minZ < minZ) minZ = b.minZ;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    if (!(maxX >= minX) || !(maxZ >= minZ)) {
      this.empty = true;
      this.originX = 0; this.originZ = 0; this.cell = 1; this.nx = 1; this.nz = 1;
      this.start = new Int32Array(2);
      this.items = new Int32Array(0);
      return;
    }
    this.empty = false;
    // Pad so a point exactly on the world's outer edge still lands in a cell.
    const pad = 1e-6;
    this.originX = minX - pad;
    this.originZ = minZ - pad;
    const w = Math.max(maxX - minX + 2 * pad, 1e-6);
    const h = Math.max(maxZ - minZ + 2 * pad, 1e-6);
    const perAxis = targetPerAxis > 0
      ? targetPerAxis
      : Math.min(128, Math.max(2, Math.ceil(Math.sqrt(bounds.length) * 3)));
    this.cell = Math.max(w, h) / perAxis;
    this.nx = Math.max(1, Math.ceil(w / this.cell));
    this.nz = Math.max(1, Math.ceil(h / this.cell));

    const cellTotal = this.nx * this.nz;
    const counts = new Int32Array(cellTotal + 1);
    const spans: Array<[number, number, number, number]> = [];
    for (const b of bounds) {
      if (!Number.isFinite(b.minX + b.minZ + b.maxX + b.maxZ) || b.maxX < b.minX || b.maxZ < b.minZ) {
        spans.push([1, 0, 1, 0]);
        continue;
      }
      const x0 = this.clampX(b.minX), x1 = this.clampX(b.maxX);
      const z0 = this.clampZ(b.minZ), z1 = this.clampZ(b.maxZ);
      spans.push([x0, x1, z0, z1]);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * this.nx + x + 1]!++;
    }
    for (let i = 0; i < cellTotal; i++) counts[i + 1]! += counts[i]!;
    this.start = counts;
    this.items = new Int32Array(counts[cellTotal]!);
    const cursor = new Int32Array(cellTotal);
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]!;
      for (let z = s[2]; z <= s[3]; z++) {
        for (let x = s[0]; x <= s[1]; x++) {
          const c = z * this.nx + x;
          this.items[this.start[c]! + cursor[c]!] = i;
          cursor[c]!++;
        }
      }
    }
  }

  private clampX(x: number): number {
    const i = Math.floor((x - this.originX) / this.cell);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }

  private clampZ(z: number): number {
    const i = Math.floor((z - this.originZ) / this.cell);
    return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i;
  }

  /**
   * Candidate item indices for a point. Returns an empty view when the point is
   * outside the grid's extent, which is the common case for a camera that has
   * walked out of the property.
   */
  candidates(x: number, z: number): Int32Array {
    if (this.empty || !Number.isFinite(x) || !Number.isFinite(z)) return EMPTY;
    const ix = Math.floor((x - this.originX) / this.cell);
    const iz = Math.floor((z - this.originZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return EMPTY;
    const c = iz * this.nx + ix;
    return this.items.subarray(this.start[c]!, this.start[c + 1]!);
  }
}

const EMPTY = new Int32Array(0);
