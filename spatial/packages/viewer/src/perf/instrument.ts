/**
 * Instrumentation, reported rather than guessed at.
 *
 * Every number here is measured in the browser that is running: frame times
 * from the render loop, bytes from the Resource Timing API's `transferSize`
 * (which is the compressed figure that actually crossed the network, not the
 * decoded size), and heap from `performance.memory` where the engine exposes
 * it. Where a number is not available -- Safari and Firefox do not implement
 * `performance.memory` -- it is reported as undefined rather than estimated.
 */

export interface FrameStats {
  readonly count: number;
  /** Frames per second at the median frame time. */
  readonly fpsMedian: number;
  /** The slowest 1% of frames, expressed as FPS. The number users feel. */
  readonly fpsOnePercentLow: number;
  readonly frameMsMedian: number;
  readonly frameMsP95: number;
  readonly frameMsMax: number;
  /** Fraction of frames slower than 20 ms (below 50 fps). */
  readonly jankFraction: number;
}

export interface PerfReport {
  /** First frame actually presented, ms from viewer construction. */
  readonly firstPaintMs?: number;
  /**
   * Controls live and the world navigable: proxy built, constraint solver
   * ready, first splat chunk decoded (or, for a proxy-only world, the proxy).
   */
  readonly timeToInteractiveMs?: number;
  /** Every splat chunk resident. */
  readonly fullyLoadedMs?: number;
  readonly frames: FrameStats;
  readonly bytesTransferred: number;
  readonly splatsResident: number;
  readonly jsHeapUsedMb?: number;
  readonly jsHeapLimitMb?: number;
  readonly drawCalls?: number;
  readonly geometries?: number;
  readonly textures?: number;
  readonly deviceProfile: string;
}

const JANK_MS = 20;

/** Pure: exposed so the statistics themselves are testable without a GPU. */
export function summariseFrames(frameMs: readonly number[]): FrameStats {
  const clean = frameMs.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return {
      count: 0, fpsMedian: 0, fpsOnePercentLow: 0,
      frameMsMedian: 0, frameMsP95: 0, frameMsMax: 0, jankFraction: 0,
    };
  }
  const at = (q: number): number => clean[Math.min(clean.length - 1, Math.floor(q * clean.length))]!;
  const median = at(0.5);
  // The "1% low" convention is the mean of the slowest 1% of frames, not the
  // 99th percentile sample: it is what a stutter actually feels like.
  const lowCount = Math.max(1, Math.floor(clean.length * 0.01));
  const slowest = clean.slice(clean.length - lowCount);
  const lowMean = slowest.reduce((s, v) => s + v, 0) / slowest.length;
  return {
    count: clean.length,
    fpsMedian: 1000 / median,
    fpsOnePercentLow: 1000 / lowMean,
    frameMsMedian: median,
    frameMsP95: at(0.95),
    frameMsMax: clean[clean.length - 1]!,
    jankFraction: clean.filter((v) => v > JANK_MS).length / clean.length,
  };
}

interface MemoryCapablePerformance extends Performance {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
}

export class PerfMonitor {
  private readonly t0: number;
  private readonly frameMs: number[] = [];
  private lastFrameAt: number | undefined;
  private firstPaint: number | undefined;
  private interactive: number | undefined;
  private interactivePending = false;
  private fullyLoadedPending = false;
  /** Bytes per asset, from the decoder's own progress events. See below. */
  private readonly assetBytes = new Map<string, number>();
  private fullyLoaded: number | undefined;
  private bytes = 0;
  private splats = 0;
  private renderInfo: { calls: number; geometries: number; textures: number } | undefined;
  /** Rolling window: a viewer left open for an hour must not grow unbounded. */
  private readonly maxSamples = 4000;

  constructor(private readonly now: () => number = defaultNow) {
    this.t0 = this.now();
  }

  frame(): void {
    const t = this.now();
    if (this.firstPaint === undefined) this.firstPaint = t - this.t0;
    // "Interactive" cannot precede the first frame: a visitor who can move but
    // cannot yet see anything is not interacting with a property. The viewer
    // signals readiness the moment the constraint solver is live; the clock
    // stops on the next frame actually presented.
    if (this.interactivePending) {
      this.interactive = t - this.t0;
      this.interactivePending = false;
    }
    if (this.fullyLoadedPending) {
      this.fullyLoaded = t - this.t0;
      this.fullyLoadedPending = false;
    }
    if (this.lastFrameAt !== undefined) {
      this.frameMs.push(t - this.lastFrameAt);
      if (this.frameMs.length > this.maxSamples) this.frameMs.splice(0, this.frameMs.length - this.maxSamples);
    }
    this.lastFrameAt = t;
  }

  markInteractive(): void {
    if (this.interactive === undefined) this.interactivePending = true;
  }

  markFullyLoaded(): void {
    if (this.fullyLoaded === undefined) this.fullyLoadedPending = true;
  }

  /**
   * Bytes for one asset, taken from the loader's progress events.
   *
   * This is not redundant with Resource Timing: Spark fetches and decodes a
   * splat file inside a Web Worker, and a worker's resource entries live in
   * the worker's own performance timeline, which the page cannot read. Without
   * this the largest download in the whole session would be reported as zero,
   * which is worse than not reporting it at all.
   */
  setAssetBytes(id: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.assetBytes.set(id, Math.max(this.assetBytes.get(id) ?? 0, bytes));
  }

  addBytes(n: number): void {
    if (Number.isFinite(n) && n > 0) this.bytes += n;
  }

  setSplatsResident(n: number): void {
    this.splats = n;
  }

  setRenderInfo(info: { calls: number; geometries: number; textures: number }): void {
    this.renderInfo = info;
  }

  /**
   * Bytes that actually crossed the network for the URLs we fetched. Reading
   * Resource Timing is more honest than summing Content-Length: it counts
   * headers, it is zero for a cache hit, and it is the figure a bandwidth
   * budget is written against.
   */
  collectTransferSizes(urls: readonly string[]): void {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return;
    // Resource Timing reports absolute URLs; an asset resolver quite reasonably
    // hands back a relative one. Compare on the absolute form of both or the
    // byte count silently reads zero, which is worse than not reporting it.
    const absolute = (u: string): string => {
      try {
        return typeof location === 'undefined' ? u : new URL(u, location.href).href;
      } catch {
        return u;
      }
    };
    const wanted = new Set(urls.map(absolute));
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      if (!wanted.has(e.name)) continue;
      this.addBytes(e.transferSize || e.encodedBodySize || 0);
      wanted.delete(e.name);
    }
  }

  /** Everything the page itself fetched: document, scripts, styles, images. */
  collectPageBytes(): void {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return;
    let total = 0;
    for (const e of performance.getEntriesByType('navigation') as PerformanceResourceTiming[]) {
      total += e.transferSize || e.encodedBodySize || 0;
    }
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      total += e.transferSize || e.encodedBodySize || 0;
    }
    this.pageBytes = total;
  }

  private pageBytes = 0;

  report(deviceProfile: string): PerfReport {
    const perf = typeof performance === 'undefined'
      ? undefined
      : (performance as MemoryCapablePerformance).memory;
    return {
      ...(this.firstPaint !== undefined ? { firstPaintMs: this.firstPaint } : {}),
      ...(this.interactive !== undefined ? { timeToInteractiveMs: this.interactive } : {}),
      ...(this.fullyLoaded !== undefined ? { fullyLoadedMs: this.fullyLoaded } : {}),
      frames: summariseFrames(this.frameMs),
      bytesTransferred: this.bytes + this.pageBytes
        + [...this.assetBytes.values()].reduce((a, b) => a + b, 0),
      splatsResident: this.splats,
      ...(perf ? {
        jsHeapUsedMb: perf.usedJSHeapSize / (1024 * 1024),
        jsHeapLimitMb: perf.jsHeapSizeLimit / (1024 * 1024),
      } : {}),
      ...(this.renderInfo ? {
        drawCalls: this.renderInfo.calls,
        geometries: this.renderInfo.geometries,
        textures: this.renderInfo.textures,
      } : {}),
      deviceProfile,
    };
  }

  reset(): void {
    this.frameMs.length = 0;
    this.lastFrameAt = undefined;
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * A coarse device class, used to pick a splat budget before anything is
 * fetched. Deliberately pessimistic: guessing low costs a little sharpness,
 * guessing high costs a swap-thrashing phone.
 */
export function deviceProfile(): { name: string; splatBudget: number } {
  if (typeof navigator === 'undefined') return { name: 'unknown', splatBudget: 1_000_000 };
  const ua = navigator.userAgent ?? '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? (mobile ? 4 : 8);

  if (!mobile && cores >= 8 && memory >= 8) return { name: 'desktop-high', splatBudget: 3_000_000 };
  if (!mobile) return { name: 'desktop', splatBudget: 2_000_000 };
  if (memory >= 6 && cores >= 8) return { name: 'mobile-high', splatBudget: 1_800_000 };
  if (memory >= 4) return { name: 'mobile-mid', splatBudget: 1_400_000 };
  return { name: 'mobile-low', splatBudget: 800_000 };
}
