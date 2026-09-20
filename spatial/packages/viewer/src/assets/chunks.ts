import type { Asset, WorldDocument } from '@m3xi/world-core';

/**
 * WHAT TO DOWNLOAD, AND WHEN
 * ==========================
 *
 * Real numbers drive this file. A 2-4M-Gaussian flat is 36-90 MB delivered and
 * 3-8 s of first load on good 4G. Nobody waits 8 s on a property listing, so a
 * world above the chunk threshold is never fetched as one file: the room the
 * visitor is standing in loads first, its neighbours load next, and the rest
 * arrives while they look around.
 *
 * Ordering is by *reachability*, not by distance. The room you can walk into
 * through a door is the room you will walk into, even if a different room is
 * closer in metres through a wall. `Asset.chunkKey` is matched against room
 * ids, so the pipeline decides the granularity and this only decides the order.
 *
 * The splat budget is the other half. ~1-1.5M Gaussians is what a mid-range
 * Android renders smoothly, so on that class of device a world with more than
 * that gets coarser LoDs for the rooms the visitor is not in, and the finest
 * LoD only where they are standing.
 */

export type LoadPhase = 'immediate' | 'next' | 'background';

export interface PlannedAsset {
  readonly asset: Asset;
  readonly phase: LoadPhase;
  /** Lower loads first within a phase. */
  readonly order: number;
  readonly roomId?: string;
  /** Why this asset is in this phase; shown in operator diagnostics. */
  readonly reason: string;
}

export interface ChunkPlan {
  /**
   * `proxy-only`   no splat assets at all: the operator-review shell.
   * `whole`        one splat for the property, small enough to fetch at once.
   * `chunked`      room-by-room, progressive.
   */
  readonly strategy: 'proxy-only' | 'whole' | 'chunked';
  readonly assets: readonly PlannedAsset[];
  readonly totalBytes: number;
  readonly immediateBytes: number;
  readonly totalSplats: number;
  readonly immediateSplats: number;
  readonly reason: string;
}

export interface ChunkPlanOptions {
  /** Room the camera is in, or about to be in. */
  readonly currentRoomId?: string;
  /**
   * Above this, chunk. 40 MB is roughly where a single fetch stops being
   * recoverable on a flaky mobile connection.
   */
  readonly chunkThresholdBytes?: number;
  /** Gaussians this device should hold. Defaults to the mid-range Android figure. */
  readonly splatBudget?: number;
  /** Already-resident chunk keys, so a re-plan does not refetch them. */
  readonly loaded?: readonly string[];
}

export const DEFAULT_CHUNK_THRESHOLD_BYTES = 40 * 1024 * 1024;
export const DEFAULT_SPLAT_BUDGET = 1_400_000;

export function planChunks(doc: WorldDocument, opts: ChunkPlanOptions = {}): ChunkPlan {
  const threshold = opts.chunkThresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES;
  const budget = opts.splatBudget ?? DEFAULT_SPLAT_BUDGET;
  const loaded = new Set(opts.loaded ?? []);

  const splatAssets = doc.assets.filter((a) => a.role === 'splat' || a.role === 'splat_chunk');
  if (splatAssets.length === 0) {
    return {
      strategy: 'proxy-only',
      assets: [],
      totalBytes: 0,
      immediateBytes: 0,
      totalSplats: 0,
      immediateSplats: 0,
      reason: 'the world has no splat asset yet; the proxy geometry is all there is to show',
    };
  }

  const chunked = splatAssets.filter((a) => a.chunkKey !== undefined);
  const whole = splatAssets.filter((a) => a.chunkKey === undefined);
  const totalBytes = splatAssets.reduce((s, a) => s + (a.bytes ?? 0), 0);

  // A single asset under the threshold is simply fetched. Splitting it would
  // trade one connection for several and win nothing.
  if (chunked.length === 0 || (whole.length > 0 && totalBytes <= threshold && chunked.length === 0)) {
    const picked = pickLod(whole.length > 0 ? whole : chunked, budget);
    return {
      strategy: 'whole',
      assets: picked.map((asset, i) => ({
        asset, phase: 'immediate' as const, order: i,
        reason: 'the whole property is one asset',
      })),
      totalBytes,
      immediateBytes: picked.reduce((s, a) => s + (a.bytes ?? 0), 0),
      totalSplats: picked.reduce((s, a) => s + (a.splatCount ?? 0), 0),
      immediateSplats: picked.reduce((s, a) => s + (a.splatCount ?? 0), 0),
      reason: totalBytes <= threshold
        ? `${mb(totalBytes)} in one asset, under the ${mb(threshold)} chunking threshold`
        : `${mb(totalBytes)} but the pipeline published no room chunks to split it into`,
    };
  }

  const order = roomOrder(doc, opts.currentRoomId);
  const byKey = groupBy(chunked, (a) => a.chunkKey!);

  const planned: PlannedAsset[] = [];
  let splatsSoFar = 0;
  let i = 0;

  for (const key of orderKeys([...byKey.keys()], order)) {
    const candidates = byKey.get(key)!;
    const distanceRank = order.get(key) ?? Number.MAX_SAFE_INTEGER;
    const phase: LoadPhase = distanceRank === 0 ? 'immediate' : distanceRank === 1 ? 'next' : 'background';
    // The room you are in gets the finest LoD that the remaining budget allows;
    // everything else is allowed to be coarse until you walk towards it.
    const remaining = Math.max(0, budget - splatsSoFar);
    const picked = pickLod(candidates, phase === 'immediate' ? budget : remaining);
    for (const asset of picked) {
      splatsSoFar += asset.splatCount ?? 0;
      planned.push({
        asset,
        phase: loaded.has(key) ? 'background' : phase,
        order: i++,
        roomId: key,
        reason: loaded.has(key)
          ? 'already resident'
          : phase === 'immediate'
            ? 'the room the visitor is standing in'
            : phase === 'next'
              ? 'reachable through one doorway'
              : `${distanceRank} doorways away`,
      });
    }
  }

  // A whole-property asset alongside chunks is the fallback for a client that
  // cannot stream; it is planned last and only fetched if a chunk fails.
  for (const asset of whole) {
    planned.push({
      asset, phase: 'background', order: i++,
      reason: 'whole-property fallback, fetched only if a chunk fails',
    });
  }

  const immediate = planned.filter((p) => p.phase === 'immediate');
  return {
    strategy: 'chunked',
    assets: planned,
    totalBytes,
    immediateBytes: immediate.reduce((s, p) => s + (p.asset.bytes ?? 0), 0),
    totalSplats: planned.reduce((s, p) => s + (p.asset.splatCount ?? 0), 0),
    immediateSplats: immediate.reduce((s, p) => s + (p.asset.splatCount ?? 0), 0),
    reason: `${mb(totalBytes)} across ${byKey.size} room chunks; loading the visitor's room first`,
  };
}

/**
 * Hop distance from the current room through doorways. Rank 0 is the room
 * itself, 1 is through one door, and so on. Rooms with no connection at all
 * sort last, in document order, so the plan is deterministic.
 */
export function roomOrder(doc: WorldDocument, currentRoomId?: string): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  const touch = (id: string): Set<string> => {
    let s = adjacency.get(id);
    if (!s) { s = new Set(); adjacency.set(id, s); }
    return s;
  };
  for (const r of doc.rooms) touch(r.id);
  for (const o of doc.openings) {
    if (!o.roomA || !o.roomB) continue;
    touch(o.roomA).add(o.roomB);
    touch(o.roomB).add(o.roomA);
  }
  // Nav edges through a door connect rooms too, and a pipeline may publish one
  // without a matching Opening.roomB (an archway between two spaces, say).
  const nodeRoom = new Map(doc.nav.nodes.map((n) => [n.id, n.roomId]));
  for (const e of doc.nav.edges) {
    const a = nodeRoom.get(e.a);
    const b = nodeRoom.get(e.b);
    if (a && b && a !== b) { touch(a).add(b); touch(b).add(a); }
  }

  const start = currentRoomId && adjacency.has(currentRoomId)
    ? currentRoomId
    : doc.nav.nodes.find((n) => n.isEntrance)?.roomId ?? doc.rooms[0]?.id;

  const out = new Map<string, number>();
  if (!start) return out;

  const queue: Array<[string, number]> = [[start, 0]];
  out.set(start, 0);
  while (queue.length > 0) {
    const [id, d] = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (out.has(next)) continue;
      out.set(next, d + 1);
      queue.push([next, d + 1]);
    }
  }
  let unreached = Math.max(0, ...out.values()) + 1;
  for (const r of doc.rooms) if (!out.has(r.id)) out.set(r.id, unreached++);
  return out;
}

/**
 * Pick one LoD per chunk. Convention, matching the pipeline: lod 0 is the
 * finest. The finest that fits the remaining budget wins; if none fits, the
 * coarsest available is used rather than nothing, because a coarse room is a
 * room and an absent room is a hole in the property.
 */
export function pickLod(candidates: readonly Asset[], splatBudget: number): Asset[] {
  if (candidates.length === 0) return [];
  const withLod = [...candidates].sort((a, b) => (a.lod ?? 0) - (b.lod ?? 0));
  if (withLod.length === 1) return [withLod[0]!];
  for (const a of withLod) {
    if ((a.splatCount ?? 0) <= splatBudget) return [a];
  }
  return [withLod[withLod.length - 1]!];
}

function orderKeys(keys: readonly string[], order: ReadonlyMap<string, number>): string[] {
  return [...keys].sort((a, b) => {
    const ra = order.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = order.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.localeCompare(b);
  });
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    let list = out.get(k);
    if (!list) { list = []; out.set(k, list); }
    list.push(it);
  }
  return out;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
