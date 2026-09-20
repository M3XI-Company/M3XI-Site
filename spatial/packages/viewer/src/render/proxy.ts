import * as THREE from 'three';
import type { Provenance, Vec3 } from '@m3xi/world-core';
import { weakestProvenance } from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';
import { DISPLAY_CLASS_OF, type DisplayClass } from '../provenance/classify.js';
import {
  applyTheme, createBoundaryMaterial, createSurfaceMaterial, type ThemeColours,
} from './materials.js';

/**
 * The proxy mesh, turned into something the GPU can draw.
 *
 * The spatial engine already built a triangle soup with per-triangle
 * attribution (`triSurface`, `triEntity`, `triRoom`). This walks it once,
 * decides a display class per triangle, and emits one non-indexed geometry per
 * class. Non-indexed because the classes cut across the shared vertex buffer
 * and de-duplicating per class would cost more than the vertices save at these
 * sizes -- a flat is tens of thousands of triangles, not millions.
 *
 * The result is invisible in a published world except where it is not supposed
 * to be: 'real' geometry is never drawn at all (the splat is the property),
 * and only estimated and unsurveyed geometry gets a hatch. In a world with no
 * splat yet, everything is drawn as a matte shell so an operator can review
 * the reconstruction on its own terms.
 */

/** Above this, per-triangle region lookups stop being worth the wait. */
const REGION_TEST_TRIANGLE_LIMIT = 200_000;

export interface ProxyBuildResult {
  readonly group: THREE.Group;
  readonly triangleCount: number;
  readonly classCounts: Readonly<Record<DisplayClass, number>>;
  /** True when per-triangle region provenance was skipped for size. */
  readonly regionTestSkipped: boolean;
}

export class ProxyLayer {
  readonly group = new THREE.Group();
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly boundaryMaterials: THREE.LineBasicMaterial[] = [];

  constructor(
    private readonly world: World,
    private theme: ThemeColours,
    private readonly opts: { shell: boolean; pixelRatio: number },
  ) {
    this.group.name = 'm3xi-proxy';
    this.build();
  }

  private build(): ProxyBuildResult {
    const soup = this.world.soup;
    const triCount = soup.indices.length / 3;
    const skipRegions = triCount > REGION_TEST_TRIANGLE_LIMIT;

    const buckets: Record<DisplayClass, number[]> = { real: [], estimated: [], unsurveyed: [] };
    const counts: Record<DisplayClass, number> = { real: 0, estimated: 0, unsurveyed: 0 };

    const pos = soup.positions;
    for (let t = 0; t < triCount; t++) {
      const i0 = soup.indices[t * 3]! * 3;
      const i1 = soup.indices[t * 3 + 1]! * 3;
      const i2 = soup.indices[t * 3 + 2]! * 3;

      const owner = this.ownerProvenance(t);
      let provenance = owner;
      if (!skipRegions) {
        const centroid: Vec3 = [
          (pos[i0]! + pos[i1]! + pos[i2]!) / 3,
          (pos[i0 + 1]! + pos[i1 + 1]! + pos[i2 + 1]!) / 3,
          (pos[i0 + 2]! + pos[i1 + 2]! + pos[i2 + 2]!) / 3,
        ];
        provenance = weakestProvenance(owner, this.world.provenanceAt(centroid));
      }
      const cls = DISPLAY_CLASS_OF[provenance];
      counts[cls]++;
      const bucket = buckets[cls];
      bucket.push(i0, i1, i2);
    }

    for (const cls of ['real', 'estimated', 'unsurveyed'] as const) {
      const tris = buckets[cls];
      if (tris.length === 0) continue;
      // 'real' geometry is only ever drawn as a shell. Over a splat it would
      // be a grey sheet pasted across the photograph.
      if (cls === 'real' && !this.opts.shell) continue;

      const geometry = buildGeometry(pos, tris);
      const material = createSurfaceMaterial({
        displayClass: cls,
        theme: this.theme,
        shell: this.opts.shell,
        pixelRatio: this.opts.pixelRatio,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `m3xi-proxy-${cls}`;
      // Splats are sorted and blended by Spark; the hatch must land on top of
      // them, so it renders after everything opaque.
      mesh.renderOrder = cls === 'unsurveyed' ? 12 : 11;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.materials.push(material);
      this.geometries.push(geometry);
    }

    this.addRegionHulls();

    return {
      group: this.group,
      triangleCount: triCount,
      classCounts: counts,
      regionTestSkipped: skipRegions,
    };
  }

  /**
   * Volumes the document declares as never observed get a hull of their own,
   * with an edge outline. Without this an unsurveyed void with no proxy
   * triangles in it -- the space above a ceiling, the corner behind a wardrobe
   * -- would be marked nowhere, and the one thing the visitor most needs to
   * know would be the one thing not drawn.
   */
  private addRegionHulls(): void {
    for (const region of this.world.doc.regions) {
      if (region.provenance === 'observed') continue;
      const cls = DISPLAY_CLASS_OF[region.provenance];
      const size: Vec3 = [
        region.volume.max[0] - region.volume.min[0],
        region.volume.max[1] - region.volume.min[1],
        region.volume.max[2] - region.volume.min[2],
      ];
      if (!(size[0] > 0.01 && size[1] > 0.01 && size[2] > 0.01)) continue;

      const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      geometry.translate(
        (region.volume.max[0] + region.volume.min[0]) / 2,
        (region.volume.max[1] + region.volume.min[1]) / 2,
        (region.volume.max[2] + region.volume.min[2]) / 2,
      );
      const material = createSurfaceMaterial({
        displayClass: cls,
        theme: this.theme,
        shell: false,
        pixelRatio: this.opts.pixelRatio,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `m3xi-region-${region.id}`;
      mesh.renderOrder = 13;
      mesh.userData['regionId'] = region.id;
      this.group.add(mesh);
      this.materials.push(material);
      this.geometries.push(geometry);

      if (region.provenance === 'generated') {
        const edges = new THREE.EdgesGeometry(geometry);
        const lineMaterial = createBoundaryMaterial(this.theme);
        const line = new THREE.LineSegments(edges, lineMaterial);
        line.name = `m3xi-region-edge-${region.id}`;
        line.renderOrder = 14;
        this.group.add(line);
        this.geometries.push(edges);
        this.boundaryMaterials.push(lineMaterial);
      }
    }
  }

  private ownerProvenance(tri: number): Provenance {
    const ei = this.world.soup.triEntity[tri]!;
    if (ei >= 0) return this.world.doc.entities[ei]?.grounding.provenance ?? 'reconstructed';
    const si = this.world.soup.triSurface[tri]!;
    if (si >= 0) return this.world.doc.surfaces[si]?.grounding.provenance ?? 'reconstructed';
    const ri = this.world.soup.triRoom[tri]!;
    if (ri >= 0) return this.world.doc.rooms[ri]?.grounding.provenance ?? 'reconstructed';
    return 'reconstructed';
  }

  setTheme(theme: ThemeColours): void {
    this.theme = theme;
    for (const m of this.materials) applyTheme(m, theme);
    for (const m of this.boundaryMaterials) m.color.copy(theme.ink);
  }

  setPixelRatio(ratio: number): void {
    for (const m of this.materials) {
      const u = m.uniforms['uPixelRatio'];
      if (u) u.value = ratio;
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * Full teardown. Every geometry and material this layer created is disposed
   * explicitly -- three.js does not free GPU buffers when an object leaves the
   * scene graph, and a viewer that switches worlds leaks a whole flat per
   * switch if this is skipped.
   */
  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const m of this.boundaryMaterials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.boundaryMaterials.length = 0;
    this.group.clear();
  }
}

function buildGeometry(positions: Float32Array, triangleOffsets: readonly number[]): THREE.BufferGeometry {
  const out = new Float32Array(triangleOffsets.length * 3);
  for (let i = 0; i < triangleOffsets.length; i++) {
    const src = triangleOffsets[i]!;
    out[i * 3] = positions[src]!;
    out[i * 3 + 1] = positions[src + 1]!;
    out[i * 3 + 2] = positions[src + 2]!;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
