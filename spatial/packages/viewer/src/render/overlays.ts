import * as THREE from 'three';
import type { Vec3 } from '@m3xi/world-core';
import type { World } from '@m3xi/spatial-engine';
import type { MeasurementOverlay } from '../types.js';
import {
  createHighlightMaterial, createMeasureFillMaterial, createMeasureLineMaterial,
  type ThemeColours,
} from './materials.js';

/**
 * Measurement geometry and entity highlights.
 *
 * Labels are NOT drawn here. They are real DOM elements positioned by
 * projecting their world anchor each frame, because a measurement rendered
 * into a texture is invisible to a screen reader, cannot be selected, does not
 * respect the user's font size and blurs on a high-DPI phone. The 3D line
 * points at the thing; the DOM says what it is.
 */

export interface LabelAnchor {
  readonly id: string;
  readonly at: Vec3;
  readonly text: string;
  readonly detail?: string;
  readonly status: 'defensible' | 'indicative';
}

export class OverlayLayer {
  readonly group = new THREE.Group();
  private readonly overlays = new Map<string, THREE.Group>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private highlightGroup: THREE.Group | undefined;

  constructor(private readonly world: World, private theme: ThemeColours) {
    this.group.name = 'm3xi-overlays';
  }

  /** Every label currently on screen, for the DOM layer to position. */
  get labels(): LabelAnchor[] {
    const out: LabelAnchor[] = [];
    for (const [id, group] of this.overlays) {
      const anchors = group.userData['labels'] as LabelAnchor[] | undefined;
      if (anchors) for (const a of anchors) out.push({ ...a, id: `${id}:${a.id}` });
    }
    return out;
  }

  show(overlay: MeasurementOverlay): boolean {
    const hasGeometry = overlay.lines.length > 0 || overlay.polygons.length > 0
      || overlay.footprints.length > 0 || overlay.labels.length > 0;
    if (!hasGeometry) return false;

    this.clear(overlay.id);
    const group = new THREE.Group();
    group.name = `m3xi-overlay-${overlay.id}`;
    group.renderOrder = 20;

    const status = overlay.labels[0]?.status ?? 'defensible';
    const lineMaterial = createMeasureLineMaterial(this.theme, status);
    this.disposables.push(lineMaterial);

    for (const line of overlay.lines) {
      if (line.length < 2) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints(
        line.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      );
      const obj = new THREE.Line(geometry, lineMaterial);
      obj.renderOrder = 21;
      group.add(obj);
      this.disposables.push(geometry);
    }

    const fillMaterial = createMeasureFillMaterial(this.theme);
    this.disposables.push(fillMaterial);

    for (const ring of overlay.polygons) {
      const mesh = fanMesh(ring, fillMaterial);
      if (mesh) { mesh.renderOrder = 20; group.add(mesh); this.disposables.push(mesh.geometry); }
    }

    for (const fp of overlay.footprints) {
      const mesh = fanMesh(fp.corners, fillMaterial);
      if (mesh) { mesh.renderOrder = 20; group.add(mesh); this.disposables.push(mesh.geometry); }
      const outline = new THREE.BufferGeometry().setFromPoints(
        [...fp.corners, fp.corners[0]].map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      );
      const line = new THREE.Line(outline, lineMaterial);
      line.renderOrder = 21;
      group.add(line);
      this.disposables.push(outline);
    }

    group.userData['labels'] = overlay.labels.map((l, i): LabelAnchor => ({
      id: String(i),
      at: l.at,
      text: l.text,
      status: l.status,
      ...(l.detail ? { detail: l.detail } : {}),
    }));

    this.overlays.set(overlay.id, group);
    this.group.add(group);
    return true;
  }

  clear(id?: string): void {
    if (id === undefined) {
      for (const key of [...this.overlays.keys()]) this.clear(key);
      return;
    }
    const group = this.overlays.get(id);
    if (!group) return;
    this.group.remove(group);
    group.clear();
    this.overlays.delete(id);
  }

  /**
   * Highlights entities with a wireframe box around their oriented bounds.
   * Falls back to the axis-aligned box when the pipeline published no OBB.
   */
  setHighlight(entityIds: readonly string[]): boolean {
    this.clearHighlight();
    const material = createHighlightMaterial(this.theme);
    this.disposables.push(material);
    const group = new THREE.Group();
    group.name = 'm3xi-highlight';
    let found = 0;

    for (const id of entityIds) {
      const e = this.world.entity(id);
      if (!e) continue;
      found++;
      const half = e.obb?.half ?? [
        (e.aabb.max[0] - e.aabb.min[0]) / 2,
        (e.aabb.max[1] - e.aabb.min[1]) / 2,
        (e.aabb.max[2] - e.aabb.min[2]) / 2,
      ];
      const box = new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2);
      const edges = new THREE.EdgesGeometry(box);
      box.dispose();
      const line = new THREE.LineSegments(edges, material);
      const centre = e.obb?.centre ?? e.centroid;
      line.position.set(centre[0], centre[1], centre[2]);
      if (e.obb) {
        line.quaternion.set(e.obb.quat[0], e.obb.quat[1], e.obb.quat[2], e.obb.quat[3]);
      }
      line.renderOrder = 22;
      group.add(line);
      this.disposables.push(edges);
    }

    if (found === 0) { group.clear(); return false; }
    this.highlightGroup = group;
    this.group.add(group);
    return true;
  }

  clearHighlight(): void {
    if (!this.highlightGroup) return;
    this.group.remove(this.highlightGroup);
    this.highlightGroup.clear();
    this.highlightGroup = undefined;
  }

  setTheme(theme: ThemeColours): void {
    this.theme = theme;
  }

  dispose(): void {
    this.clear();
    this.clearHighlight();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}

/**
 * A triangle fan from the ring centroid. Rooms here are simple and mostly
 * convex; the L-shaped kitchen is the awkward case and a centroid fan still
 * covers it, because the centroid of that outline is inside the polygon. A
 * concave outline whose centroid falls outside would spill, so the fill is
 * drawn at 14% opacity and the outline -- which is always exact -- carries the
 * shape.
 */
function fanMesh(ring: readonly Vec3[], material: THREE.Material): THREE.Mesh | null {
  if (ring.length < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (const p of ring) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= ring.length; cy /= ring.length; cz /= ring.length;

  const verts: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    verts.push(cx, cy, cz, a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}
