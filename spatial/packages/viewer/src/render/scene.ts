import * as THREE from 'three';
import type { SparkRenderer } from '@sparkjsdev/spark';
import type { Vec3, WorldDocument } from '@m3xi/world-core';
import type { RayHit, World } from '@m3xi/spatial-engine';
import type { CameraPose } from '../types.js';
import { themeFor, type ThemeColours } from './materials.js';
import { OverlayLayer } from './overlays.js';
import { ProxyLayer } from './proxy.js';
import { loadSpark, SplatLayer, type SplatLayerOptions } from './splats.js';

/**
 * The rig: one renderer, one camera, one Spark, three layers.
 *
 * Nothing in here knows about panels, keyboard handling or the agent. It draws
 * a world and it takes itself apart again without leaking, which on a viewer
 * that switches between forty properties in an operator session is the whole
 * ballgame.
 */

export interface SceneRigOptions {
  readonly canvas: HTMLCanvasElement;
  readonly world: World;
  readonly dark: boolean;
  readonly shell: boolean;
  readonly splats: SplatLayerOptions;
  /** Mobile needs a sort budget or the worker starves the frame. */
  readonly mobile?: boolean;
}

export class SceneRig {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly proxy: ProxyLayer;
  readonly splats: SplatLayer;
  readonly overlays: OverlayLayer;

  private theme: ThemeColours;
  private readonly raycaster = new THREE.Raycaster();
  private disposed = false;
  private readonly world: World;
  private readonly mobile: boolean;
  /**
   * Created only when the world actually has splats to draw. Spark is 2.7 MB
   * minified; a proxy-only world -- the operator-review state -- never fetches
   * it, and a published world fetches it alongside its first chunk rather than
   * ahead of the first frame.
   */
  private sparkRenderer: SparkRenderer | undefined;

  constructor(opts: SceneRigOptions) {
    this.world = opts.world;
    this.theme = themeFor(opts.dark);

    // antialias: false is Spark's documented requirement -- MSAA does nothing
    // for Gaussians and costs a great deal of fill rate.
    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(pickPixelRatio(opts.mobile === true));
    this.renderer.setClearColor(this.theme.paper, 1);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 120);
    // Yaw about +Y then pitch about local X. Roll is never applied: a level
    // horizon is what makes a walkthrough feel like walking.
    this.camera.rotation.order = 'YXZ';

    this.mobile = opts.mobile === true;

    this.proxy = new ProxyLayer(opts.world, this.theme, {
      shell: opts.shell,
      pixelRatio: this.renderer.getPixelRatio(),
    });
    this.scene.add(this.proxy.group);

    this.splats = new SplatLayer(opts.world.doc, opts.splats);
    this.scene.add(this.splats.group);

    this.overlays = new OverlayLayer(opts.world, this.theme);
    this.scene.add(this.overlays.group);
  }

  get spark(): SparkRenderer | undefined { return this.sparkRenderer; }

  /**
   * Bring Spark in. Idempotent, and safe to call while a dispose is racing it:
   * a renderer created after teardown is disposed immediately rather than left
   * holding a context.
   */
  async enableSplats(): Promise<void> {
    if (this.sparkRenderer || this.disposed) return;
    const { SparkRenderer } = await loadSpark();
    if (this.disposed) return;
    const spark = new SparkRenderer({
      renderer: this.renderer,
      // A weak device must not let the sort worker eat the frame budget.
      ...(this.mobile ? { minSortIntervalMs: 33, maxStdDev: Math.sqrt(5) } : {}),
    });
    this.sparkRenderer = spark;
    this.scene.add(spark);
  }

  setPose(pose: CameraPose): void {
    this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
  }

  getPose(): CameraPose {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      yaw: this.camera.rotation.y,
      pitch: this.camera.rotation.x,
    };
  }

  resize(width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.proxy.setPixelRatio(this.renderer.getPixelRatio());
  }

  setTheme(dark: boolean): void {
    this.theme = themeFor(dark);
    this.renderer.setClearColor(this.theme.paper, 1);
    this.proxy.setTheme(this.theme);
    this.overlays.setTheme(this.theme);
  }

  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Picking runs against the spatial engine's BVH, not against three.js.
   *
   * That is deliberate and it is the difference between a measurement tool and
   * a toy: the engine's hit carries the surface id, the entity id and the
   * provenance of what was hit, which is exactly what a measurement needs to
   * declare itself. A three.js raycast against the proxy would return a
   * triangle index and nothing else, and a raycast against the splat would
   * return a fuzzy point on a cloud of Gaussians.
   */
  pick(ndcX: number, ndcY: number, maxDistance = 40): RayHit | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    return this.world.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], { maxDistance });
  }

  /** Project a world point to normalised screen coordinates, for DOM labels. */
  project(p: Vec3): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    return {
      x: (v.x + 1) / 2,
      y: (1 - v.y) / 2,
      visible: v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.15 && Math.abs(v.y) <= 1.15,
    };
  }

  renderStats(): { calls: number; geometries: number; textures: number } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  /**
   * Teardown, in dependency order.
   *
   * `spark.clearSplats()` before `spark.dispose()` matters: the SparkRenderer
   * holds splat accumulators that outlive the meshes that fed them, and on a
   * world switch those are the buffers that leak. `renderer.dispose()` last,
   * because everything above it still wants a live context to free against.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Spark's sort and LoD workers reject their in-flight requests with
    // "Worker terminate" when the renderer goes away. That is correct -- the
    // work is genuinely abandoned -- but it surfaces as an uncaught rejection,
    // and an agency embedding this viewer would see one in their error
    // monitoring for every world switch. Swallowing exactly that, for exactly
    // the length of the teardown, keeps the noise out of their dashboard
    // without hiding anything real.
    const restore = suppressSparkTeardownNoise();

    this.overlays.dispose();
    this.splats.dispose();
    this.proxy.dispose();

    if (this.sparkRenderer) {
      try {
        this.sparkRenderer.clearSplats();
      } catch {
        // Spark throws here if the context is already lost; that is fine, the
        // driver has freed everything anyway.
      }
      this.scene.remove(this.sparkRenderer);
      this.sparkRenderer.dispose();
      this.sparkRenderer = undefined;
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();

    // Leave the guard in place for its timeout rather than lifting it here:
    // the worker rejections arrive after this function returns.
    void restore;
  }

  get isDisposed(): boolean { return this.disposed; }
}

/**
 * Device pixel ratio is the single biggest fill-rate lever on a phone. Splats
 * are fill-rate bound, so a 3x-DPR handset rendering at native resolution
 * spends triple the fragments on a screen the user holds at arm's length.
 * Capping at 2 on desktop and 1.5 on mobile is the usual compromise and is
 * visually indistinguishable at normal viewing distance.
 */
/**
 * Suppresses the rejections Spark's workers emit while being torn down, and
 * only those: a rejection with a real reason that is not the worker teardown
 * passes through untouched, and the guard lifts itself after a second.
 */
function suppressSparkTeardownNoise(): () => void {
  if (typeof window === 'undefined') return () => {};

  const isTeardown = (reason: unknown): boolean => {
    if (reason === undefined || reason === null) return true;
    const message = reason instanceof Error ? reason.message : String(reason);
    return /worker\s*terminate|terminated/i.test(message);
  };

  const onRejection = (e: PromiseRejectionEvent): void => {
    if (isTeardown(e.reason)) e.preventDefault();
  };
  const onError = (e: ErrorEvent): void => {
    if (isTeardown(e.error ?? e.message)) e.preventDefault();
  };

  window.addEventListener('unhandledrejection', onRejection, true);
  window.addEventListener('error', onError, true);

  let lifted = false;
  const lift = (): void => {
    if (lifted) return;
    lifted = true;
    window.removeEventListener('unhandledrejection', onRejection, true);
    window.removeEventListener('error', onError, true);
  };
  // A worker rejection lands a turn or two after terminate(), so the guard
  // outlives the synchronous dispose by a short, bounded window.
  setTimeout(lift, 1000);
  return lift;
}

function pickPixelRatio(mobile: boolean): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(dpr, mobile ? 1.5 : 2);
}

export function isMobileViewport(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? '');
}

export function defaultResolveAssetUrl(url: string, doc: WorldDocument): string {
  // `asset://<propertyId>/<path>` is what the pipeline writes into a world
  // document so a bundle stays portable. A deployment maps it to wherever it
  // actually serves assets from; with no mapping configured, same-origin
  // `/worlds/<id>/<path>` is the convention this repo uses.
  if (!url.startsWith('asset://')) return url;
  const rest = url.slice('asset://'.length);
  const slash = rest.indexOf('/');
  const path = slash >= 0 ? rest.slice(slash + 1) : rest;
  return `/worlds/${doc.id}/${path}`;
}
