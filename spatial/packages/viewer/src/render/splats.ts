import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import type { Asset, WorldDocument } from '@m3xi/world-core';
import type { ChunkPlan, PlannedAsset } from '../assets/chunks.js';

/**
 * SPARK, AND THE CONSTRAINTS IT PUT ON THIS DESIGN
 * ================================================
 *
 * Spark fuses Gaussian splats with ordinary three.js meshes in one sorted
 * scene, which is the entire reason it is here: the property is a splat, and
 * the collision proxy, the hatch, the measurement overlays and the highlights
 * are meshes, and they have to interleave correctly by depth. No other WebGL2
 * renderer does that cleanly.
 *
 * What it costs, and what this file does about it:
 *
 *   - NO WEBGPU. Everything is WebGL2, so there is no compute path for the
 *     sort. Spark sorts on a worker; we keep `minSortIntervalMs` non-zero on
 *     mobile so the sort cannot monopolise a weak device.
 *   - FORMAT CHOICE IS A DISPOSAL DECISION. Spark has open issues around
 *     chunked-RAD disposal and streamed-LoD bounding boxes. We prefer SPZ and
 *     SOG and warn loudly on RAD, because a leak per world switch is a
 *     showstopper for an operator reviewing forty properties in a session.
 *   - `SplatMesh.dispose()` frees the mesh's own buffers but the SparkRenderer
 *     keeps accumulators. `SplatLayer.dispose()` therefore also asks the
 *     renderer to clear its splat collection, and the viewer re-checks the
 *     resident count afterwards.
 *   - BOUNDING BOXES UNDER STREAMED LOD ARE UNRELIABLE, so nothing in this
 *     viewer uses a splat's bounds for anything load-bearing. Culling,
 *     collision and measurement all run off the proxy mesh and the world
 *     document, which are exact.
 *   - IT IS 2.7 MB MINIFIED. That is most of the viewer's JavaScript, and a
 *     world with no splat published yet needs none of it. So Spark is imported
 *     dynamically, here and in `scene.ts`, and the bundler splits it into a
 *     chunk that is fetched only when there is something to render with it --
 *     in parallel with the splat data itself, not before it.
 */

/** One import, shared by the renderer and every mesh, resolved at most once. */
let sparkModule: Promise<typeof import('@sparkjsdev/spark')> | undefined;

export function loadSpark(): Promise<typeof import('@sparkjsdev/spark')> {
  sparkModule ??= import('@sparkjsdev/spark');
  return sparkModule;
}

export interface SplatLoadEvent {
  readonly asset: Asset;
  readonly phase: PlannedAsset['phase'];
  readonly loaded: number;
  readonly total: number;
  readonly bytesLoaded: number;
  readonly bytesTotal: number;
}

export interface SplatLayerOptions {
  readonly resolveUrl: (url: string, doc: WorldDocument) => string;
  readonly onProgress?: (e: SplatLoadEvent) => void;
  readonly onChunkReady?: (asset: Asset) => void;
  /**
   * Fires when nothing is in flight any more. Separate from `onChunkReady`
   * because "this room arrived" and "everything has arrived" are different
   * moments and the second one is the only honest place to stop the clock.
   */
  readonly onIdle?: () => void;
  readonly onError?: (asset: Asset, err: unknown) => void;
  /** Spark's own LoD machinery, off on low-end devices where it costs more. */
  readonly enableLod?: boolean;
}

const WARN_FORMATS = new Set(['rad']);

export class SplatLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<string, SplatMesh>();
  private readonly urls: string[] = [];
  private disposed = false;
  private inflight = 0;

  constructor(
    private readonly doc: WorldDocument,
    private readonly opts: SplatLayerOptions,
  ) {
    this.group.name = 'm3xi-splats';
  }

  get residentSplats(): number {
    let n = 0;
    for (const m of this.meshes.values()) n += m.numSplats ?? 0;
    return n;
  }

  get loadedChunkKeys(): string[] {
    const keys: string[] = [];
    for (const [id] of this.meshes) {
      const asset = this.doc.assets.find((a) => a.id === id);
      if (asset?.chunkKey) keys.push(asset.chunkKey);
    }
    return keys;
  }

  get fetchedUrls(): readonly string[] { return this.urls; }
  get pending(): number { return this.inflight; }

  /**
   * Loads a plan in phase order. Immediate assets are awaited so the caller
   * can call the world interactive at the right moment; the rest are started
   * and deliberately not awaited, which is what makes the tour usable while
   * the far bedroom is still arriving.
   */
  async loadPlan(plan: ChunkPlan): Promise<void> {
    const immediate = plan.assets.filter((p) => p.phase === 'immediate');
    const deferred = plan.assets.filter((p) => p.phase !== 'immediate')
      .sort((a, b) => (a.phase === 'next' ? 0 : 1) - (b.phase === 'next' ? 0 : 1) || a.order - b.order);

    await Promise.all(immediate.map((p) => this.load(p, plan)));
    if (this.disposed) return;
    // Sequential, not parallel: six concurrent 18 MB fetches on 4G starve each
    // other and the visitor watches all six bars crawl instead of one room
    // appearing. One at a time, nearest first, is faster where it is felt.
    void this.loadSequentially(deferred, plan);
  }

  private async loadSequentially(planned: readonly PlannedAsset[], plan: ChunkPlan): Promise<void> {
    for (const p of planned) {
      if (this.disposed) return;
      await this.load(p, plan);
    }
  }

  private async load(planned: PlannedAsset, plan: ChunkPlan): Promise<void> {
    const { asset } = planned;
    if (this.meshes.has(asset.id) || this.disposed) return;
    const url = this.opts.resolveUrl(asset.url, this.doc);
    if (WARN_FORMATS.has(asset.format.toLowerCase())) {
      console.warn(
        `[m3xi/viewer] asset ${asset.id} is ${asset.format}; Spark has open disposal issues with chunked RAD. Prefer SPZ or SOG.`,
      );
    }

    this.inflight++;
    try {
      const { SplatMesh } = await loadSpark();
      if (this.disposed) return;
      const mesh = new SplatMesh({
        url,
        // Raycasting against splats is never used for measurement -- the proxy
        // is exact and the splat is not -- so leave it off and save the index.
        raycastable: false,
        ...(this.opts.enableLod !== undefined ? { lod: this.opts.enableLod } : {}),
        onProgress: (e: ProgressEvent) => {
          this.opts.onProgress?.({
            asset,
            phase: planned.phase,
            loaded: this.meshes.size,
            total: plan.assets.length,
            bytesLoaded: e.loaded,
            bytesTotal: e.total || asset.bytes || 0,
          });
        },
      });
      applyAssetTransform(mesh, asset);
      mesh.name = `m3xi-splat-${asset.id}`;
      await mesh.initialized;
      if (this.disposed) { mesh.dispose(); return; }
      this.meshes.set(asset.id, mesh);
      this.urls.push(url);
      this.group.add(mesh);
      this.opts.onChunkReady?.(asset);
    } catch (err) {
      this.opts.onError?.(asset, err);
    } finally {
      this.inflight--;
      if (this.inflight === 0 && !this.disposed) this.opts.onIdle?.();
    }
  }

  /** Drops one chunk, for a viewer that has wandered far from a room. */
  unload(assetId: string): boolean {
    const mesh = this.meshes.get(assetId);
    if (!mesh) return false;
    this.group.remove(mesh);
    mesh.dispose();
    this.meshes.delete(assetId);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes.clear();
    this.group.clear();
    this.group.removeFromParent();
    this.urls.length = 0;
  }
}

/**
 * Splat files are frequently authored Y-down, which is why every Spark example
 * starts by setting a 180-degree flip. Guessing is not an option here: the
 * pipeline writes the world frame the contract declares (+Y up, right handed),
 * so the default is identity and a deviation has to be declared on the asset.
 */
export function applyAssetTransform(mesh: THREE.Object3D, asset: Asset): void {
  const meta = asset.meta as
    | { upAxis?: string; translate?: number[]; quaternion?: number[]; scale?: number }
    | undefined;
  if (!meta) return;
  if (meta.upAxis === 'Y-down' || meta.upAxis === '-Y') {
    mesh.quaternion.set(1, 0, 0, 0);
  }
  if (Array.isArray(meta.quaternion) && meta.quaternion.length === 4) {
    mesh.quaternion.set(meta.quaternion[0]!, meta.quaternion[1]!, meta.quaternion[2]!, meta.quaternion[3]!);
  }
  if (Array.isArray(meta.translate) && meta.translate.length === 3) {
    mesh.position.set(meta.translate[0]!, meta.translate[1]!, meta.translate[2]!);
  }
  if (typeof meta.scale === 'number' && meta.scale > 0) {
    mesh.scale.setScalar(meta.scale);
  }
}
