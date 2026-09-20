/**
 * THE CORRECTION RECEIPT SURVIVES THE RENDERING.
 *
 * `world.json` is a rendering of the rows, and until today it rendered a
 * corrected fact and a pipeline-written fact identically. An operator could
 * rename a room, move a sofa, redraw a wall -- and the document that the
 * viewer, the agent and the export bundle all read would say only
 * `reconstructed, 0.9`, with nothing anywhere in it to say that the 0.9 was a
 * person's judgement rather than a reconstruction's. The receipt existed for
 * dimensions alone, in `wv_measurement.basis`, because that was the only table
 * with somewhere to put it.
 *
 * `correction_sources text[]` on wv_room, wv_entity, wv_surface and wv_opening
 * is the somewhere. These tests pin the two halves of using it:
 *
 *   1. it is SELECTED and RENDERED, for all four kinds of object, so that
 *      `isHumanCorrected()` can answer "did a person touch this fact" from a
 *      rendered document and not only from the database; and
 *
 *   2. it does not damage what `sources` already carried. `wv_entity` has real
 *      camera ids in there, `cameraSourcesOf()` reads them by prefix, and a
 *      receipt appended to the wrong end of that list -- or in place of it --
 *      would either lose the cameras or turn a correction id into one.
 *
 * The assertions are made with the REAL helpers from
 * spatial/packages/review/src/model/provenance.ts rather than with a string
 * comparison written here. A test that checked for the literal 'correction:'
 * would keep passing if the prefix constant moved, which is precisely the
 * failure it is supposed to catch: these two files agree on a token format or
 * the receipt is invisible.
 */

import { describe, expect, it } from 'vitest';
import type { Grounding } from '@m3xi/world-core';

import { buildWorldDocument } from '../worldDocument.ts';
import { makeTestDeps, seedTenant, type TestDeps } from './fakes.ts';

/**
 * Imported from the review package's SOURCE, by path, on purpose.
 *
 * `@m3xi/review` resolves through its package entry at `dist/index.js`, which
 * only exists after `tsc -b` has run there; seam.test.ts in console-ui skips
 * itself when that build is missing, and a skip is exactly what this file must
 * not do -- "the receipt is readable" is the whole claim being made. The source
 * module needs no build, and its own imports (`@m3xi/world-core`,
 * `@m3xi/spatial-engine`) resolve from the workspace as they do for every other
 * test in this suite.
 */
import {
  CORRECTION_SOURCE_PREFIX, cameraSourcesOf, correctionIdsOf, correctionSource,
  isHumanCorrected, operatorSource, operatorsOf,
} from '../../../../spatial/packages/review/src/model/provenance.ts';

const NOW = '2026-09-20T12:00:00.000Z';

interface Rig {
  readonly deps: TestDeps;
  readonly worldId: string;
  /** Renamed by a person: kind and name corrected, geometry untouched. */
  readonly correctedRoom: string;
  /** Nobody has ever touched it. The control case for every assertion. */
  readonly pipelineRoom: string;
  /** Moved by a person, and observed by two cameras before that. */
  readonly correctedSofa: string;
  /** Observed by one camera and never corrected. */
  readonly pipelineTv: string;
  readonly correctedWall: string;
  readonly correctedDoorway: string;
  readonly cameraA: string;
  readonly cameraB: string;
  readonly cameraC: string;
  readonly nameFix: string;
  readonly moveFix: string;
  readonly wallFix: string;
  readonly doorFix: string;
  readonly operator: string;
}

/**
 * One world with a corrected and an uncorrected example of each kind.
 *
 * The receipts are seeded in the shape `correctGrounding()` writes them --
 * `correction:<record id>` then `operator:<who>` -- because this rig is
 * standing in for wv-worlds, and a rig that wrote a shape the handler does not
 * write would prove the renderer handles something nothing produces.
 */
function rig(): Rig {
  const deps = makeTestDeps({ now: NOW });
  const db = deps.db;
  const tenant = seedTenant(db, { status: 'published' });

  const cameraA = db.nextId();
  const cameraB = db.nextId();
  const cameraC = db.nextId();
  const operator = db.nextId();
  const nameFix = db.nextId();
  const moveFix = db.nextId();
  const wallFix = db.nextId();
  const doorFix = db.nextId();

  const correctedRoom = db.nextId();
  const pipelineRoom = db.nextId();
  const correctedSofa = db.nextId();
  const pipelineTv = db.nextId();
  const correctedWall = db.nextId();
  const correctedDoorway = db.nextId();

  db.seed('wv_room', [
    {
      id: correctedRoom, world_id: tenant.worldId, stable_key: 'living', name: 'Sitting room',
      kind: 'living', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], floor_z: 0, ceiling_z: 2.4,
      area_m2: 12, area_standard: 'RICS-COMP-GIA', area_tol_pct: 2.5, wall_tol_mm: 20,
      // A semantic correction leaves provenance alone (rule 2): the polygon is
      // exactly as reconstructed as it was before somebody renamed the room.
      provenance: 'reconstructed', confidence: 0.9,
      correction_sources: [correctionSource(nameFix), operatorSource(operator)],
    },
    {
      id: pipelineRoom, world_id: tenant.worldId, stable_key: 'kitchen', name: 'Kitchen',
      kind: 'kitchen', polygon: [[4, 0], [7, 0], [7, 3], [4, 3]], floor_z: 0, ceiling_z: 2.4,
      area_m2: 9, area_standard: 'RICS-COMP-GIA', area_tol_pct: 2.5, wall_tol_mm: 20,
      provenance: 'reconstructed', confidence: 0.93,
      correction_sources: [],
    },
  ]);

  db.seed('wv_entity', [
    {
      id: correctedSofa, world_id: tenant.worldId, stable_key: 'sofa', label: 'Sofa',
      category: 'seating', room_id: correctedRoom, centroid: [1, 0.4, 1],
      aabb: { min: [0, 0, 0], max: [2, 0.8, 1] }, obb: null,
      observed_in: [cameraA, cameraB],
      // Rule 3: a person dragged it, so the geometry is inferred now.
      provenance: 'inferred', confidence: 0.9, attributes: {},
      correction_sources: [correctionSource(moveFix), operatorSource(operator)],
    },
    {
      id: pipelineTv, world_id: tenant.worldId, stable_key: 'tv', label: 'Television',
      category: 'electronics', room_id: correctedRoom, centroid: [3, 1, 0.2],
      aabb: { min: [2.5, 0.6, 0], max: [3.5, 1.4, 0.2] }, obb: null,
      observed_in: [cameraC],
      provenance: 'observed', confidence: 0.88, attributes: {},
      correction_sources: [],
    },
  ]);

  db.seed('wv_surface', [{
    id: correctedWall, world_id: tenant.worldId, room_id: correctedRoom, kind: 'wall',
    plane: { n: [1, 0, 0], d: 0 }, polygon: [[0, 0, 0], [0, 2.4, 0], [0, 2.4, 3], [0, 0, 3]],
    area_m2: 7.2, is_reflective: false, is_glazed: false,
    provenance: 'inferred', confidence: 0.9,
    correction_sources: [correctionSource(wallFix), operatorSource(operator)],
  }]);

  db.seed('wv_opening', [{
    id: correctedDoorway, world_id: tenant.worldId, kind: 'door', surface_id: correctedWall,
    room_a: correctedRoom, room_b: pipelineRoom, centre: [4, 1, 1.5], normal: [1, 0, 0],
    width_m: 0.82, height_m: 2.04, sill_m: 0,
    provenance: 'inferred', confidence: 0.9,
    correction_sources: [correctionSource(doorFix), operatorSource(operator)],
  }]);

  return {
    deps, worldId: tenant.worldId,
    correctedRoom, pipelineRoom, correctedSofa, pipelineTv, correctedWall, correctedDoorway,
    cameraA, cameraB, cameraC, nameFix, moveFix, wallFix, doorFix, operator,
  };
}

type Rendered = Record<string, unknown>;

function objectsIn(doc: Rendered, collection: string): Rendered[] {
  const list = doc[collection];
  if (!Array.isArray(list)) throw new Error(`rendered document has no ${collection}`);
  return list as Rendered[];
}

function find(doc: Rendered, collection: string, id: string): Rendered {
  const hit = objectsIn(doc, collection).find((o) => o['id'] === id);
  if (!hit) throw new Error(`no ${collection} '${id}' in the rendered document`);
  return hit;
}

function groundingOf(doc: Rendered, collection: string, id: string): Grounding {
  return find(doc, collection, id)['grounding'] as Grounding;
}

async function render(r: Rig): Promise<Rendered> {
  return buildWorldDocument(r.deps.db, r.worldId);
}

// ---------------------------------------------------------------------------

describe('a human correction is legible in the rendered document', () => {
  it('renders the receipt for all four kinds of correctable object', async () => {
    const r = rig();
    const doc = await render(r);

    const cases: ReadonlyArray<[string, string, string, string]> = [
      ['rooms', r.correctedRoom, r.nameFix, 'a renamed room'],
      ['entities', r.correctedSofa, r.moveFix, 'a moved object'],
      ['surfaces', r.correctedWall, r.wallFix, 'a redrawn wall'],
      ['openings', r.correctedDoorway, r.doorFix, 'a resized doorway'],
    ];

    for (const [collection, id, recordId, what] of cases) {
      const g = groundingOf(doc, collection, id);
      expect(isHumanCorrected(g), what).toBe(true);
      expect(correctionIdsOf(g), what).toEqual([recordId]);
      expect(operatorsOf(g), what).toEqual([r.operator]);
    }
  });

  it('answers isHumanCorrected false for a fact the pipeline wrote alone', async () => {
    const r = rig();
    const doc = await render(r);

    expect(isHumanCorrected(groundingOf(doc, 'rooms', r.pipelineRoom))).toBe(false);
    expect(isHumanCorrected(groundingOf(doc, 'entities', r.pipelineTv))).toBe(false);
  });

  it('leaves an uncorrected row rendered exactly as it was before the column existed', async () => {
    const r = rig();
    const doc = await render(r);

    // No empty array, no key at all: `grounding()` omits `sources` when there
    // is nothing to say, and a world nobody has corrected must render
    // byte-identically to the way it rendered yesterday, or every cached
    // document in the system is needlessly stale.
    const room = groundingOf(doc, 'rooms', r.pipelineRoom) as unknown as Record<string, unknown>;
    expect('sources' in room).toBe(false);
    expect(room).toEqual({ provenance: 'reconstructed', confidence: 0.93 });

    // The uncorrected entity keeps the camera list it always had, unchanged.
    const tv = groundingOf(doc, 'entities', r.pipelineTv);
    expect(tv.sources).toEqual([r.cameraC]);
    expect(cameraSourcesOf(tv)).toEqual([r.cameraC]);
  });
});

describe('the receipt does not displace the cameras', () => {
  it('keeps camera ids first and the receipt after them', async () => {
    const r = rig();
    const doc = await render(r);
    const g = groundingOf(doc, 'entities', r.correctedSofa);

    expect(g.sources).toEqual([
      r.cameraA, r.cameraB, correctionSource(r.moveFix), operatorSource(r.operator),
    ]);
  });

  it('still reads as a camera list to cameraSourcesOf', async () => {
    const r = rig();
    const doc = await render(r);
    const g = groundingOf(doc, 'entities', r.correctedSofa);

    // The one that would break silently: a correction token counted as a
    // camera would inflate "observed by N cameras" on the coverage panel and
    // make a hand-placed object look better observed than one nobody touched.
    expect(cameraSourcesOf(g)).toEqual([r.cameraA, r.cameraB]);
    expect(correctionIdsOf(g)).toEqual([r.moveFix]);
  });

  it('keeps observedIn itself a pure camera list', async () => {
    const r = rig();
    const doc = await render(r);
    const sofa = find(doc, 'entities', r.correctedSofa);

    // `observedIn` is rendered from `observed_in uuid[]`, which the receipt
    // must never reach: it is the one field in the document that genuinely
    // means "a camera saw this", and wv_entity.observed_in cannot hold a
    // `correction:` token in any case.
    expect(sofa['observedIn']).toEqual([r.cameraA, r.cameraB]);
    expect(String(sofa['observedIn'])).not.toContain(CORRECTION_SOURCE_PREFIX);
  });

  it('renders a token that was stored twice exactly once', async () => {
    const r = rig();
    const room = r.deps.db.rows('wv_room').find((x) => x['id'] === r.correctedRoom)!;
    // A double-appended receipt is a write-side bug; rendering it twice would
    // make correctionIdsOf() report one correction as two, which is the number
    // a certificate prints.
    room['correction_sources'] = [
      correctionSource(r.nameFix), operatorSource(r.operator), correctionSource(r.nameFix),
    ];

    const g = groundingOf(await render(r), 'rooms', r.correctedRoom);
    expect(g.sources).toEqual([correctionSource(r.nameFix), operatorSource(r.operator)]);
    expect(correctionIdsOf(g)).toEqual([r.nameFix]);
  });

  it('ignores a receipt column holding anything that is not a token', async () => {
    const r = rig();
    const room = r.deps.db.rows('wv_room').find((x) => x['id'] === r.correctedRoom)!;
    // Not reachable through wv-worlds, which builds the tokens itself. It is
    // asserted because the renderer reads a column, not a validated object, and
    // a null in a text[] must not become the string "null" in a public
    // document.
    room['correction_sources'] = [null, '', correctionSource(r.nameFix), 42];

    const g = groundingOf(await render(r), 'rooms', r.correctedRoom);
    expect(g.sources).toEqual([correctionSource(r.nameFix)]);
  });
});

describe('a receipt is about the row, not about every number on it', () => {
  it('does not claim a person measured the area of a room they renamed', async () => {
    const r = rig();
    const doc = await render(r);
    const room = find(doc, 'rooms', r.correctedRoom);
    const area = room['area'] as { grounding: Grounding; value: number };

    // The room carries the receipt; the AREA does not, because nobody measured
    // it -- they typed a name. Stamping the row's receipt onto every quantity
    // on it would make a measurement certificate print "declared by an
    // operator" for a figure the pipeline computed, which is the same
    // collapse of provenance as the one this column exists to prevent, facing
    // the other way.
    expect(isHumanCorrected(groundingOf(doc, 'rooms', r.correctedRoom))).toBe(true);
    expect(isHumanCorrected(area.grounding)).toBe(false);
    expect(area.value).toBe(12);
  });
});
