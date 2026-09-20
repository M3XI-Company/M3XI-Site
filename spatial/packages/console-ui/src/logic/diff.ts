/**
 * What changed between two world versions.
 *
 * A rescan makes a new version and never destroys the old one, which is the
 * right behaviour and also a problem: an operator looking at v3 has no way to
 * know whether it is better than v2 without walking both. This computes the
 * difference the way the contract intends it to be computed — by `stableKey`,
 * which exists precisely so one room is one room across a rescan.
 *
 * Areas are compared as percentages of the older value and only reported when
 * the change exceeds the declared tolerance of the measurements involved. A
 * kitchen that moved by 0.4% inside a 2.5% tolerance has not changed; saying
 * it has would train an operator to ignore this page.
 */

import type { Room, WorldDocument } from '@m3xi/world-core';

export interface RoomChange {
  readonly stableKey: string;
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** (to - from) / from, signed. */
  readonly deltaFraction: number;
  /** The tolerance that had to be exceeded for this to count, in percent. */
  readonly tolerancePct: number;
}

export interface RenameChange {
  readonly stableKey: string;
  readonly from: string;
  readonly to: string;
}

export interface WorldDiff {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly rooms: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly renamed: readonly RenameChange[];
    readonly kindChanged: readonly RenameChange[];
    readonly resized: readonly RoomChange[];
    readonly unchanged: number;
  };
  readonly entities: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly relabelled: readonly RenameChange[];
  };
  readonly quality: {
    readonly fromVerdict: string;
    readonly toVerdict: string;
    readonly fromScore: number;
    readonly toScore: number;
    /** Checks that flipped, either way. */
    readonly flipped: readonly { readonly name: string; readonly from: boolean; readonly to: boolean }[];
  };
  readonly coverage: {
    readonly fromCameras: number;
    readonly toCameras: number;
    readonly fromUnobservedRegions: number;
    readonly toUnobservedRegions: number;
  };
  /** True when nothing worth an operator's attention moved. */
  readonly identical: boolean;
}

function roomLabel(room: Room): string {
  return room.name ?? room.kind;
}

export function diffWorlds(from: WorldDocument, to: WorldDocument): WorldDiff {
  const before = new Map(from.rooms.map((r) => [r.stableKey, r]));
  const after = new Map(to.rooms.map((r) => [r.stableKey, r]));

  const added: string[] = [];
  const removed: string[] = [];
  const renamed: RenameChange[] = [];
  const kindChanged: RenameChange[] = [];
  const resized: RoomChange[] = [];
  let unchanged = 0;

  for (const [key, room] of after) {
    const old = before.get(key);
    if (!old) { added.push(roomLabel(room)); continue; }

    let touched = false;
    if (roomLabel(old) !== roomLabel(room)) {
      renamed.push({ stableKey: key, from: roomLabel(old), to: roomLabel(room) });
      touched = true;
    }
    if (old.kind !== room.kind) {
      kindChanged.push({ stableKey: key, from: old.kind, to: room.kind });
      touched = true;
    }

    // Only a change larger than the looser of the two declared tolerances is
    // a change. Inside tolerance, the two numbers are the same measurement.
    const tolerance = Math.max(old.area.tolerance, room.area.tolerance);
    const delta = old.area.value === 0 ? 0 : (room.area.value - old.area.value) / old.area.value;
    if (Math.abs(delta) * 100 > tolerance) {
      resized.push({
        stableKey: key,
        name: roomLabel(room),
        from: old.area.value,
        to: room.area.value,
        deltaFraction: delta,
        tolerancePct: tolerance,
      });
      touched = true;
    }
    if (!touched) unchanged += 1;
  }

  for (const [key, room] of before) {
    if (!after.has(key)) removed.push(roomLabel(room));
  }

  const entityBefore = new Map(from.entities.map((e) => [e.stableKey, e]));
  const entityAfter = new Map(to.entities.map((e) => [e.stableKey, e]));
  const entitiesAdded: string[] = [];
  const entitiesRemoved: string[] = [];
  const relabelled: RenameChange[] = [];
  for (const [key, entity] of entityAfter) {
    const old = entityBefore.get(key);
    if (!old) entitiesAdded.push(entity.label);
    else if (old.label !== entity.label) relabelled.push({ stableKey: key, from: old.label, to: entity.label });
  }
  for (const [key, entity] of entityBefore) {
    if (!entityAfter.has(key)) entitiesRemoved.push(entity.label);
  }

  const checkBefore = new Map(from.quality.checks.map((c) => [c.name, c.pass]));
  const flipped: { name: string; from: boolean; to: boolean }[] = [];
  for (const check of to.quality.checks) {
    const was = checkBefore.get(check.name);
    if (was !== undefined && was !== check.pass) flipped.push({ name: check.name, from: was, to: check.pass });
  }

  const identical = added.length === 0 && removed.length === 0 && renamed.length === 0
    && kindChanged.length === 0 && resized.length === 0
    && entitiesAdded.length === 0 && entitiesRemoved.length === 0 && relabelled.length === 0
    && flipped.length === 0;

  return {
    fromVersion: from.version,
    toVersion: to.version,
    rooms: { added, removed, renamed, kindChanged, resized, unchanged },
    entities: { added: entitiesAdded, removed: entitiesRemoved, relabelled },
    quality: {
      fromVerdict: from.quality.verdict,
      toVerdict: to.quality.verdict,
      fromScore: from.quality.score,
      toScore: to.quality.score,
      flipped,
    },
    coverage: {
      fromCameras: from.cameras.length,
      toCameras: to.cameras.length,
      fromUnobservedRegions: from.regions.filter((r) => r.provenance !== 'observed').length,
      toUnobservedRegions: to.regions.filter((r) => r.provenance !== 'observed').length,
    },
    identical,
  };
}
