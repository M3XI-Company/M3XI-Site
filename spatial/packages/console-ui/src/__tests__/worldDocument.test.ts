/**
 * Assembling a world document from member-readable rows.
 *
 * The rule under test is the contract's: a dimension without a declared
 * standard and tolerance must not leave the system. A world where nothing
 * declares one produces no document at all, and a single room missing one is
 * reported by id rather than quietly given a default.
 */

import { describe, expect, it } from 'vitest';
import { assembleWorldDocument, hasBlocker, type WorldRows } from '../logic/worldDocument.js';

const WORLD = {
  id: '11111111-1111-4111-8111-111111111111',
  property_id: '22222222-2222-4222-8222-222222222222',
  version: 3,
  status: 'review',
  slug: 'two-bed-flat',
  created_at: '2026-09-01T09:00:00.000Z',
  published_at: null,
  scale_source: 'ARKit depth + door-leaf prior (2 estimators)',
  scale_agreement: 0.981,
};

const PROPERTY = { id: WORLD.property_id, label: '14 Ash Grove', postcode: 'SW19 3AB' };

function rows(overrides: Partial<WorldRows> = {}): WorldRows {
  return {
    world: WORLD,
    property: PROPERTY,
    floors: [{ id: 'f1', level: 0, name: 'Ground floor', elevation_m: 0, provenance: 'reconstructed', confidence: 0.95 }],
    rooms: [{
      id: 'r1', stable_key: 'kitchen-diner', floor_id: 'f1', name: 'Kitchen/diner', kind: 'kitchen',
      polygon: [[0.25, 0.25], [4.35, 0.25], [4.35, 3.95], [0.25, 3.95]],
      floor_z: 0, ceiling_z: 2.4, area_m2: 15.17,
      area_standard: 'RICS-COMP-GIA', area_tol_pct: 2.5, wall_tol_mm: 20,
      provenance: 'reconstructed', confidence: 0.95,
    }],
    surfaces: [],
    openings: [],
    entities: [],
    relationships: [],
    navNodes: [],
    navEdges: [],
    regions: [],
    cameras: [],
    assets: [],
    quality: {
      checks: [{ name: 'scale_agreement', value: 0.981, threshold: 0.95, higherIsBetter: true, pass: true }],
      score: 0.91, verdict: 'review', created_at: '2026-09-01T10:58:00.000Z',
    },
    ...overrides,
  };
}

describe('a well-formed world', () => {
  const { doc, problems } = assembleWorldDocument(rows());

  it('produces a format-version-1 document', () => {
    expect(doc?.formatVersion).toBe(1);
    expect(doc?.id).toBe(WORLD.id);
    expect(doc?.label).toBe('14 Ash Grove');
    expect(doc?.version).toBe(3);
    expect(doc?.units).toEqual({ length: 'm', angle: 'rad' });
    expect(doc?.upAxis).toBe('Y');
  });

  it('carries the standard and tolerance on every area', () => {
    const area = doc!.rooms[0]!.area;
    expect(area.standard).toBe('RICS-COMP-GIA');
    expect(area.tolerance).toBe(2.5);
    expect(area.toleranceUnit).toBe('pct');
    expect(area.unit).toBe('m2');
    expect(area.grounding.provenance).toBe('reconstructed');
  });

  it('declares one measurement policy for the world', () => {
    expect(doc?.measurementPolicy).toEqual({
      areaStandard: 'RICS-COMP-GIA', areaTolerancePct: 2.5, wallToleranceMm: 20,
    });
  });

  it('has no problems to report', () => {
    expect(problems).toEqual([]);
    expect(hasBlocker(problems)).toBe(false);
  });

  it('carries the quality verdict through untouched', () => {
    expect(doc?.quality.verdict).toBe('review');
  });
});

describe('missing measurement standards', () => {
  it('refuses to build a document when no room declares one', () => {
    const { doc, problems } = assembleWorldDocument(rows({
      rooms: [{ ...rows().rooms[0]!, area_standard: null }],
    }));
    expect(doc).toBeNull();
    expect(hasBlocker(problems)).toBe(true);
    expect(problems[0]?.code).toBe('no_measurement_standard');
  });

  it('lets one room borrow the world policy but names it as a problem', () => {
    const base = rows().rooms[0]!;
    const { doc, problems } = assembleWorldDocument(rows({
      rooms: [base, { ...base, id: 'r2', stable_key: 'bath', area_standard: null, area_m2: 3.5 }],
    }));
    expect(doc).not.toBeNull();
    expect(doc!.rooms[1]!.area.standard).toBe('RICS-COMP-GIA');
    const borrowed = problems.find((p) => p.code === 'borrowed_standard');
    expect(borrowed?.ref).toBe('r2');
    expect(borrowed?.level).toBe('warning');
  });

  it('takes the worst declared tolerance, never the best', () => {
    const base = rows().rooms[0]!;
    const { doc } = assembleWorldDocument(rows({
      rooms: [
        { ...base, area_tol_pct: 2.5, wall_tol_mm: 20 },
        { ...base, id: 'r2', stable_key: 'b', area_tol_pct: 6, wall_tol_mm: 45 },
      ],
    }));
    expect(doc?.measurementPolicy.areaTolerancePct).toBe(6);
    expect(doc?.measurementPolicy.wallToleranceMm).toBe(45);
  });
});

describe('malformed geometry', () => {
  it('blocks a world with no rooms at all', () => {
    const { doc, problems } = assembleWorldDocument(rows({ rooms: [] }));
    expect(doc).toBeNull();
    expect(problems.some((p) => p.code === 'no_rooms')).toBe(true);
  });

  it('drops a room whose outline is not a ring and says which', () => {
    const base = rows().rooms[0]!;
    const { doc, problems } = assembleWorldDocument(rows({
      rooms: [base, { ...base, id: 'r_bad', stable_key: 'bad', polygon: 'not a ring' }],
    }));
    expect(doc?.rooms).toHaveLength(1);
    expect(problems.find((p) => p.code === 'bad_polygon')?.ref).toBe('r_bad');
  });

  it('drops an entity with no bounding box', () => {
    const { doc, problems } = assembleWorldDocument(rows({
      entities: [{ id: 'e1', stable_key: 'sofa', label: 'sofa', category: 'furniture', centroid: [1, 0.4, 1], aabb: null }],
    }));
    expect(doc?.entities).toEqual([]);
    expect(problems.some((p) => p.code === 'bad_entity')).toBe(true);
  });
});

describe('provenance and grounding', () => {
  it('does not treat a missing confidence as certainty', () => {
    const base = rows().rooms[0]!;
    const { doc } = assembleWorldDocument(rows({ rooms: [{ ...base, confidence: null }] }));
    expect(doc?.rooms[0]?.grounding.confidence).toBe(0.5);
  });

  it('never lets a region claim it was reconstructed', () => {
    const { doc } = assembleWorldDocument(rows({
      regions: [{
        id: 'rg1', provenance: 'reconstructed',
        volume: { min: [0, 0, 0], max: [1, 1, 1] }, reason: 'x', confidence: 0.2,
      }],
    }));
    expect(doc?.regions[0]?.provenance).toBe('inferred');
  });

  it('falls back to a safe provenance for an unknown value', () => {
    const base = rows().rooms[0]!;
    const { doc } = assembleWorldDocument(rows({ rooms: [{ ...base, provenance: 'vibes' }] }));
    expect(doc?.rooms[0]?.grounding.provenance).toBe('reconstructed');
  });
});

describe('cameras and assets', () => {
  it('accepts both the schema’s w/h and the contract’s width/height', () => {
    const camera = {
      id: 'c1', px: 1, py: 1.6, pz: 2, qx: 0, qy: 0, qz: 0, qw: 1,
      intrinsics: { fx: 900, fy: 900, cx: 640, cy: 360, w: 1280, h: 720 },
      pose_confidence: 0.9, sharpness: 120,
    };
    const { doc } = assembleWorldDocument(rows({ cameras: [camera] }));
    expect(doc?.cameras[0]?.intrinsics.width).toBe(1280);
    expect(doc?.cameras[0]?.intrinsics.height).toBe(720);
  });

  it('drops a camera whose intrinsics are unusable rather than shipping a 0x0 one', () => {
    const { doc } = assembleWorldDocument(rows({
      cameras: [{ id: 'c1', px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, intrinsics: {} }],
    }));
    expect(doc?.cameras).toEqual([]);
  });

  it('leaves an asset URL unfetchable unless a resolver is given', () => {
    const asset = { id: 'a1', role: 'splat', format: 'spz', storage_path: 'w/1/splat.spz', bytes: 1000 };
    const plain = assembleWorldDocument(rows({ assets: [asset] }));
    expect(plain.doc?.assets[0]?.url).toBe('asset://w/1/splat.spz');

    const signed = assembleWorldDocument(rows({ assets: [asset] }), {
      resolveAssetUrl: (p) => `https://cdn.example/${p}?token=abc`,
    });
    expect(signed.doc?.assets[0]?.url).toBe('https://cdn.example/w/1/splat.spz?token=abc');
  });
});

describe('metric scale', () => {
  it('never claims a metre was observed, and degrades to inferred when unrecorded', () => {
    // No camera measures a metre; a model estimates one. An unrecorded
    // provenance has to become the WEAKER claim, not the stronger one.
    const { doc } = assembleWorldDocument(rows());
    expect(doc?.scale.grounding.provenance).toBe('inferred');

    const claimed = assembleWorldDocument(rows({
      world: { ...WORLD, scale_provenance: 'observed' },
    }));
    expect(claimed.doc?.scale.grounding.provenance).toBe('inferred');
  });

  it('uses the recorded provenance and confidence when the pipeline set them', () => {
    const { doc } = assembleWorldDocument(rows({
      world: { ...WORLD, scale_provenance: 'reconstructed', scale_confidence: 0.62 },
    }));
    expect(doc?.scale.grounding.provenance).toBe('reconstructed');
    // Agreement is 0.981; confidence is 0.62. They are different things and
    // the confidence is the one that must survive.
    expect(doc?.scale.grounding.confidence).toBe(0.62);
    expect(doc?.scale.agreement).toBeCloseTo(0.981, 6);
  });

  it('falls back to agreement only when no confidence was recorded', () => {
    const { doc } = assembleWorldDocument(rows());
    expect(doc?.scale.grounding.confidence).toBeCloseTo(0.981, 6);
  });
});

describe('reserved assets', () => {
  it('leaves the rendered document out of the document’s own asset list', () => {
    const { doc } = assembleWorldDocument(rows({
      assets: [
        { id: 'a1', role: 'proxy_mesh', format: 'glb', storage_path: 'w/1/proxy.glb' },
        { id: 'a2', role: 'export_bundle', format: 'json', storage_path: 'w/1/world.json', chunk_key: 'world-document' },
        { id: 'a3', role: 'export_bundle', format: 'json', storage_path: 'w/1/world.raw.json', chunk_key: 'world-raw' },
      ],
    }));
    expect(doc?.assets.map((a) => a.id)).toEqual(['a1']);
  });
});

describe('a world with no quality report', () => {
  it('is assembled with a failing placeholder verdict so nothing reads it as passed', () => {
    const { doc, problems } = assembleWorldDocument(rows({ quality: null }));
    expect(doc?.quality.verdict).toBe('fail');
    expect(problems.some((p) => p.code === 'no_quality')).toBe(true);
  });
});
