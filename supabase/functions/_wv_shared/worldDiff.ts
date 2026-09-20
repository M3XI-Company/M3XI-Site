/**
 * Does the world in the database say the same thing as the world the pipeline
 * built?
 *
 * The pipeline assembles a WorldDocument from its stage artefacts and hands it
 * to `ingest-world`, which writes it into rows. The rows are then the world,
 * and every reader renders a document back out of them. If those two documents
 * disagree, something was dropped, coerced or mis-keyed on the way in, and the
 * world that gets published is not the world that was reconstructed. That is a
 * bug, and this file is how it is caught at the moment it happens rather than
 * by a customer noticing their third bedroom is missing.
 *
 * The hard part is not comparing; it is deciding what counts.
 *
 * COSMETIC, and must never fail a build:
 *   - the order of anything. Rows come back in whatever order the index
 *     produced; the pipeline emits them in stage order. Neither is meaningful.
 *   - identifiers. The pipeline names a room `rm_000`; the database names it a
 *     uuid derived from (world id, section, stable key). The mapping between
 *     them is deterministic, so the comparison rewrites the database's ids
 *     back through it -- which also means a mis-keyed row shows up as a
 *     MISSING one rather than slipping past as a rename.
 *   - timestamps, the slug and the human label, which publication and the
 *     property record own rather than the build.
 *   - the last digit of a number. Every column has a declared scale
 *     (`numeric(10,5)` for a position, `numeric(4,3)` for a confidence), so a
 *     round trip is lossy in the last place by construction. Tolerances below
 *     are set from those scales, not guessed.
 *
 * MATERIAL, and must fail the job loudly:
 *   - anything present on one side and absent on the other. A missing room, a
 *     dropped surface, a nav edge that did not survive, an entity that
 *     appeared from nowhere.
 *   - any fact about a thing that survived: its kind, its geometry, its
 *     measurements, its provenance, what it connects to.
 *   - the scale block, the measurement policy and the quality verdict, because
 *     those decide what may be quoted and whether the world may publish at all.
 *
 * NOT COMPARED, and named here so the omission is a decision rather than an
 * oversight: `grounding.sources` and `Quantity.basis`. The pipeline records
 * which cameras established a room and what geometry produced an area; the
 * schema has no column for either, so they live in the build artefact and not
 * in the rows. Comparing them would fail every world. Adding them would be a
 * schema change, and it is the one thing the rendered document is knowingly
 * poorer at than the assembled one.
 */

export interface WorldDifference {
  /** missing: in the build, not in the database. extra: the other way round. */
  readonly kind: 'missing' | 'extra' | 'changed';
  readonly section: string;
  readonly key: string;
  readonly field?: string;
  readonly assembled?: unknown;
  readonly rendered?: unknown;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'object' && x !== null) as Obj[] : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ---------------------------------------------------------------------------
// Tolerances, derived from the column scales in the core migration
// ---------------------------------------------------------------------------

/**
 * Keyed by the LEAF name of a flattened path, so `polygon.3.1` takes the
 * default and `area.grounding.confidence` takes the confidence tolerance.
 *
 * The default of 1e-4 covers every position (`numeric(10,5)`, half-ulp 5e-6),
 * every length (`numeric(7,4)`) and every area (`numeric(10,4)`). Confidences
 * are `numeric(4,3)`, so they need 1e-3, and a wall tolerance is quoted in
 * millimetres at `numeric(7,2)`, so it needs 1e-2.
 */
const EPSILON_BY_LEAF: Readonly<Record<string, number>> = {
  confidence: 1e-3,
  clearance: 1e-3,
  poseConfidence: 1e-3,
  sharpness: 1e-3,
  score: 1e-3,
  tolerance: 1e-2,
  areaTolerancePct: 1e-3,
  wallToleranceMm: 1e-2,
};

const DEFAULT_EPSILON = 1e-4;

function epsilonFor(path: string): number {
  const leaf = path.slice(path.lastIndexOf('.') + 1);
  return EPSILON_BY_LEAF[leaf] ?? DEFAULT_EPSILON;
}

function sameLeaf(a: unknown, b: unknown, eps: number): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return Math.abs(x - y) <= eps;
  }
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  return a === b;
}

/**
 * Flatten to leaf paths. Arrays become numeric segments, so a polygon that
 * lost a vertex reports the exact vertex rather than "polygon differs".
 */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) flatten(value[i], `${prefix}.${i}`, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Obj)) {
      if (v === undefined) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (value === undefined) return;
  out.set(prefix, value);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

type NodeKind = 'floor' | 'room' | 'surface' | 'opening' | 'entity' | 'camera'
  | 'navnode' | 'region';

/**
 * A canonical name for one object, the same on both sides.
 *
 * Rooms and entities are named by their stable key, which is the key that
 * survives a rescan and the key the unique index is on. Everything else is
 * named by the local id the pipeline used, recovered on the database side
 * through the deterministic id map.
 */
class Canon {
  private readonly byRawId = new Map<string, string>();

  constructor(doc: Obj, private readonly toLocal: (id: string) => string) {
    for (const f of list(doc['floors'])) {
      this.put('floor', f['id'], `floor:${Number(f['level'] ?? 0)}`);
    }
    for (const r of list(doc['rooms'])) {
      this.put('room', r['id'], `room:${String(r['stableKey'] ?? r['id'])}`);
    }
    for (const e of list(doc['entities'])) {
      this.put('entity', e['id'], `entity:${String(e['stableKey'] ?? e['id'])}`);
    }
    for (const s of list(doc['surfaces'])) this.putLocal('surface', s['id']);
    for (const o of list(doc['openings'])) this.putLocal('opening', o['id']);
    for (const c of list(doc['cameras'])) this.putLocal('camera', c['id']);
    for (const n of list(obj(doc['nav'])['nodes'])) this.putLocal('navnode', n['id']);
    for (const g of list(doc['regions'])) this.putLocal('region', g['id']);
  }

  private put(kind: NodeKind, rawId: unknown, key: string): void {
    const id = str(rawId);
    if (id) this.byRawId.set(`${kind}\u0000${id}`, key);
  }

  private putLocal(kind: NodeKind, rawId: unknown): void {
    const id = str(rawId);
    if (id) this.byRawId.set(`${kind}\u0000${id}`, `${kind}:${this.toLocal(id)}`);
  }

  /** The canonical name of `rawId`, or a marker naming the unresolvable id. */
  ref(kind: NodeKind, rawId: unknown): string | undefined {
    const id = str(rawId);
    if (!id) return undefined;
    return this.byRawId.get(`${kind}\u0000${id}`) ?? `${kind}:<unknown ${this.toLocal(id)}>`;
  }

  key(kind: NodeKind, row: Obj): string {
    return this.ref(kind, row['id']) ?? `${kind}:<anonymous>`;
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Section {
  readonly name: string;
  readonly rows: (doc: Obj) => Obj[];
  readonly key: (row: Obj, c: Canon) => string;
  readonly facts: (row: Obj, c: Canon) => Obj;
}

/** The provenance and confidence of a fact, without its camera receipts. */
function ground(row: unknown): Obj {
  const g = obj(row);
  return { provenance: g['provenance'], confidence: g['confidence'] };
}

/** A Quantity, without its `basis` (which the schema does not store). */
function quantity(q: unknown): Obj | undefined {
  if (typeof q !== 'object' || q === null) return undefined;
  const v = q as Obj;
  return {
    value: v['value'], unit: v['unit'], standard: v['standard'],
    tolerance: v['tolerance'], toleranceUnit: v['toleranceUnit'],
    grounding: ground(v['grounding']),
  };
}

const SECTIONS: readonly Section[] = [
  {
    name: 'floors',
    rows: (d) => list(d['floors']),
    key: (r, c) => c.key('floor', r),
    facts: (r) => ({
      level: r['level'], name: r['name'], elevation: r['elevation'],
      grounding: ground(r['grounding']),
    }),
  },
  {
    name: 'rooms',
    rows: (d) => list(d['rooms']),
    key: (r, c) => c.key('room', r),
    facts: (r, c) => ({
      kind: r['kind'], floorZ: r['floorZ'], ceilingZ: r['ceilingZ'],
      polygon: r['polygon'], area: quantity(r['area']),
      floorId: c.ref('floor', r['floorId']),
      grounding: ground(r['grounding']),
    }),
  },
  {
    name: 'surfaces',
    rows: (d) => list(d['surfaces']),
    key: (r, c) => c.key('surface', r),
    facts: (r, c) => ({
      kind: r['kind'], plane: r['plane'], polygon: r['polygon'],
      isReflective: r['isReflective'], isGlazed: r['isGlazed'],
      roomId: c.ref('room', r['roomId']), area: quantity(r['area']),
      grounding: ground(r['grounding']),
    }),
  },
  {
    name: 'openings',
    rows: (d) => list(d['openings']),
    key: (r, c) => c.key('opening', r),
    facts: (r, c) => ({
      kind: r['kind'], centre: r['centre'], normal: r['normal'],
      roomA: c.ref('room', r['roomA']), roomB: c.ref('room', r['roomB']),
      surfaceId: c.ref('surface', r['surfaceId']),
      width: quantity(r['width']), height: quantity(r['height']), sill: quantity(r['sill']),
      grounding: ground(r['grounding']),
    }),
  },
  {
    name: 'cameras',
    rows: (d) => list(d['cameras']),
    key: (r, c) => c.key('camera', r),
    facts: (r, c) => ({
      position: r['position'], orientation: r['orientation'],
      intrinsics: r['intrinsics'], frameIndex: r['frameIndex'], tMs: r['tMs'],
      poseConfidence: r['poseConfidence'], sharpness: r['sharpness'],
      roomId: c.ref('room', r['roomId']),
    }),
  },
  {
    name: 'entities',
    rows: (d) => list(d['entities']),
    key: (r, c) => c.key('entity', r),
    facts: (r, c) => ({
      label: r['label'], category: r['category'], centroid: r['centroid'],
      aabb: r['aabb'], obb: r['obb'], roomId: c.ref('room', r['roomId']),
      // A set, sorted: which cameras saw it is material, the order is not.
      observedIn: (Array.isArray(r['observedIn']) ? r['observedIn'] : [])
        .map((id) => c.ref('camera', id) ?? '')
        .sort(),
      attributes: r['attributes'],
      grounding: ground(r['grounding']),
    }),
  },
  {
    name: 'nav.nodes',
    rows: (d) => list(obj(d['nav'])['nodes']),
    key: (r, c) => c.key('navnode', r),
    facts: (r, c) => ({
      position: r['position'], clearance: r['clearance'],
      isEntrance: r['isEntrance'], isViewpoint: r['isViewpoint'],
      roomId: c.ref('room', r['roomId']),
    }),
  },
  {
    name: 'nav.edges',
    rows: (d) => list(obj(d['nav'])['edges']),
    // An edge has no id of its own; its endpoints are its identity.
    key: (r, c) => `edge:${c.ref('navnode', r['a'])}->${c.ref('navnode', r['b'])}`,
    facts: (r, c) => ({
      cost: r['cost'], width: r['width'], kind: r['kind'],
      openingId: c.ref('opening', r['openingId']),
    }),
  },
  {
    name: 'regions',
    rows: (d) => list(d['regions']),
    key: (r, c) => c.key('region', r),
    facts: (r, c) => ({
      provenance: r['provenance'], volume: r['volume'],
      roomId: c.ref('room', r['roomId']), reason: r['reason'],
      confidence: r['confidence'],
    }),
  },
  {
    name: 'relationships',
    rows: (d) => list(d['relationships']),
    key: (r, c) => {
      const s = c.ref(r['subjectType'] as NodeKind, r['subjectId']) ?? '?';
      const o = c.ref(r['objectType'] as NodeKind, r['objectId']) ?? '?';
      return `${s} ${String(r['predicate'])} ${o}`;
    },
    facts: (r) => ({ value: r['value'], grounding: ground(r['grounding']) }),
  },
  {
    name: 'assets',
    rows: (d) => list(d['assets']),
    // Content-addressed: the checksum is the identity, because the row id is a
    // uuid on one side and a stage-local name on the other.
    key: (r) => `asset:${String(r['role'])}:${String(r['chunkKey'] ?? '')}:`
      + `${r['lod'] ?? ''}:${String(r['checksum'] ?? r['url'] ?? '')}`,
    facts: (r) => ({
      role: r['role'], format: r['format'], url: r['url'], bytes: r['bytes'],
      lod: r['lod'], chunkKey: r['chunkKey'], splatCount: r['splatCount'],
    }),
  },
];

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * Facts about the world itself: the ones that decide what may be quoted and
 * whether it may be published. Ids, timestamps, the slug and the label are
 * deliberately absent -- see the header.
 */
function worldFacts(doc: Obj): Obj {
  const q = obj(doc['quality']);
  return {
    formatVersion: doc['formatVersion'],
    propertyId: doc['propertyId'],
    version: doc['version'],
    units: doc['units'],
    upAxis: doc['upAxis'],
    handedness: doc['handedness'],
    scale: {
      source: obj(doc['scale'])['source'],
      agreement: obj(doc['scale'])['agreement'],
      grounding: ground(obj(doc['scale'])['grounding']),
    },
    measurementPolicy: doc['measurementPolicy'],
    quality: {
      verdict: q['verdict'],
      score: q['score'],
      // Names and outcomes, sorted. The gate's reasons are material; the order
      // the checks happened to run in is not.
      checks: list(q['checks'])
        .map((c) => `${String(c['name'])}=${c['pass'] === true ? 'pass' : 'fail'}`)
        .sort(),
    },
  };
}

function diffFacts(
  section: string, key: string, a: Obj, b: Obj, out: WorldDifference[],
): void {
  const left = new Map<string, unknown>();
  const right = new Map<string, unknown>();
  flatten(a, '', left);
  flatten(b, '', right);
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(path);
    const y = right.get(path);
    if (!sameLeaf(x, y, epsilonFor(path))) {
      out.push({ kind: 'changed', section, key, field: path, assembled: x, rendered: y });
    }
  }
}

/**
 * Compare the document the pipeline assembled against the document rendered
 * from the rows it was ingested into.
 *
 * `localIdByUuid` maps each database uuid back to the local id the pipeline
 * used, so the two sides can be named alike. Build it with
 * `worldObjectIds()` in worldIngest.ts, from the assembled document -- which
 * means an id the ingest failed to derive correctly resolves to nothing and
 * the object it names is reported missing, rather than quietly matching.
 *
 * Returns every difference found, capped, so a wholesale mismatch produces a
 * usable error rather than a megabyte of JSON.
 */
export function compareWorldDocuments(
  assembled: Record<string, unknown>,
  rendered: Record<string, unknown>,
  localIdByUuid: ReadonlyMap<string, string>,
  limit = 50,
): WorldDifference[] {
  const out: WorldDifference[] = [];
  const identity = (id: string): string => id;
  const fromUuid = (id: string): string => localIdByUuid.get(id) ?? id;

  const canonA = new Canon(assembled, identity);
  const canonB = new Canon(rendered, fromUuid);

  diffFacts('world', 'world', worldFacts(assembled), worldFacts(rendered), out);

  for (const section of SECTIONS) {
    const a = new Map<string, Obj>();
    const b = new Map<string, Obj>();
    for (const row of section.rows(assembled)) a.set(section.key(row, canonA), row);
    for (const row of section.rows(rendered)) b.set(section.key(row, canonB), row);

    for (const [key, row] of a) {
      const other = b.get(key);
      if (!other) {
        out.push({ kind: 'missing', section: section.name, key });
        continue;
      }
      diffFacts(section.name, key, section.facts(row, canonA),
                section.facts(other, canonB), out);
    }
    for (const key of b.keys()) {
      if (!a.has(key)) out.push({ kind: 'extra', section: section.name, key });
    }
  }
  return out.slice(0, limit);
}

/** A one-line human summary of a set of differences, for a log or an error. */
export function summariseDifferences(diffs: readonly WorldDifference[]): string {
  if (diffs.length === 0) return 'no differences';
  const counts = new Map<string, number>();
  for (const d of diffs) {
    const k = `${d.kind} ${d.section}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const head = diffs[0]!;
  const where = head.field ? `${head.key}.${head.field}` : head.key;
  return `${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}; first: ${head.kind} ${where}`;
}
