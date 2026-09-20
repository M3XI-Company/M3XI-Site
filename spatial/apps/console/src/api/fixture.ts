/**
 * THE DECLARED FIXTURE BACKEND.
 *
 * Everything this module returns is synthetic and generated here, from a fixed
 * seed. It exists so the console can be run, reviewed and driven end to end
 * without a Supabase project, and so the states that are hard to produce on
 * demand — a build that failed halfway, a world at the monthly cap, a quality
 * report that says `fail` — can be looked at rather than described.
 *
 * It is not a mock in the testing sense and it is never silently substituted:
 * `isFixture` is true, the shell prints a banner, and every page that shows
 * money or leads says where the numbers came from. An operator must never be
 * unsure whether what they are looking at is their own portfolio.
 *
 * The world document it serves is `FLAT` from
 * `@m3xi/spatial-engine/fixtures/flat` — the same two-bedroom flat every other
 * package in this system tests against, so the numbers here mean the same
 * thing as the numbers there.
 */

import type {
  ApiClient, CaptureRow, Correction, ExportResult, ExportRow, LeadRow, MemberRow, Membership,
  PropertyRow, Session, SessionRow, WorldDetail, WorldSummary,
} from '@m3xi/console-ui';
import {
  ApiError, clampPage, type AiTurnRow, type BuildJobRow, type DataProblem, type EventRow,
  type JobRow, type MemberRole, type Page, type PortfolioQuery,
} from '@m3xi/console-ui';
import type { WorldDocument } from '@m3xi/world-core';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';

/** Fixed seed: the same portfolio every time the page is opened. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREETS = [
  'Ash Grove', 'Beechwood Road', 'Cavendish Street', 'Dover Terrace', 'Elm Court',
  'Fairfield Rise', 'Gladstone Avenue', 'Hazel Lane', 'Iverson Road', 'Juniper Way',
  'Kingsbury Close', 'Lindley Street', 'Marlborough Road', 'Northcote Avenue',
  'Orchard Mews', 'Pembroke Gardens', 'Quarry Hill', 'Rosebery Road', 'Stanhope Street',
  'Thornbury Walk', 'Ullswater Close', 'Verney Road', 'Westbourne Park', 'Yardley Lane',
];
const KINDS = ['Flat', 'Maisonette', 'Terraced house', 'Semi-detached house', 'Studio'];
const POSTCODES = ['SW19 3', 'SE15 4', 'N4 2', 'E8 1', 'BS6 7', 'M20 2', 'LS6 3', 'NE2 1'];

const STATUSES: readonly WorldSummary['status'][] = [
  'published', 'published', 'published', 'review', 'processing', 'draft', 'failed',
];

const MONTH_START = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const DEMO_ACCOUNTS: Readonly<Record<string, { role: MemberRole; userId: string; name: string }>> = {
  'owner@ashworth.example': { role: 'owner', userId: 'u_owner', name: 'Ashworth owner' },
  'admin@ashworth.example': { role: 'admin', userId: 'u_admin', name: 'Ashworth admin' },
  'operator@ashworth.example': { role: 'operator', userId: 'u_operator', name: 'Ashworth operator' },
  'viewer@ashworth.example': { role: 'viewer', userId: 'u_viewer', name: 'Ashworth viewer' },
};

export const FIXTURE_ACCOUNTS = Object.keys(DEMO_ACCOUNTS);
/** Any password is accepted; the fixture has no credential to check. */
export const FIXTURE_PASSWORD_NOTE =
  'This build has no Supabase project configured, so it is running on the declared fixture portfolio. Sign in with one of the demo addresses and any password to see the console as that role.';

const ORG = {
  id: 'org_fixture',
  slug: 'ashworth-demo',
  name: 'Ashworth & Co (fixture)',
  ai_month_cap_gbp: 25,
  build_month_cap: 50,
  ai_turns_per_session: 25,
  created_at: '2026-01-04T09:00:00.000Z',
};

const PROPERTY_COUNT = 137;

/**
 * The fixture's own rows are mutable — publishing a world here actually
 * changes it, so the demo behaves like the product rather than like a
 * screenshot. `WorldSummary` and `PropertyRow` are deeply readonly because
 * that is right for rows that came from a server; these are not those.
 */
interface FixtureWorld {
  id: string;
  property_id: string;
  version: number;
  status: string;
  published_at: string | null;
  quality_score: number | null;
  slug: string | null;
  created_at: string;
  supersedes_id: string | null;
  scale_source: string | null;
  scale_agreement: number | null;
  jobs: JobRow[];
  quality: Record<string, unknown> | null;
  qualityHistory: Record<string, unknown>[];
  /**
   * The newest `updated_at` across this world's correctable rows, which is
   * what `get_world` returns. Null until something is corrected, and set by
   * `applyCorrections` exactly as the database's touch trigger would — so the
   * publish gate's `stale` verdict is reachable in the demo: correct a world
   * that already passed, and publish closes until quality is re-run.
   */
  lastCorrectionAt: string | null;
}

interface FixtureProperty {
  id: string;
  ref: string | null;
  label: string;
  postcode: string | null;
  address: Record<string, unknown>;
  created_at: string;
  archived_at: string | null;
  worlds: FixtureWorld[];
}

/**
 * The pipeline as `BUILD_STAGE_DEPS` in supabase/functions/wv-worlds/handler.ts
 * declares it: thirteen stages and the real edges between them, not a chain.
 * `semantics` waits for two stages and `quality` for five, and the fixture
 * carries those edges so the build screen's blocked-stage logic is exercised
 * by the demo rather than only by the tests.
 */
const STAGE_DEPS: Readonly<Record<string, readonly string[]>> = {
  ingest: [],
  frames: ['ingest'],
  redact: ['frames'],
  pose: ['redact'],
  scale: ['pose'],
  splat: ['scale'],
  mesh: ['splat'],
  layout: ['mesh'],
  semantics: ['splat', 'layout'],
  graph: ['layout', 'semantics'],
  regions: ['mesh', 'graph'],
  package: ['splat', 'mesh', 'layout', 'regions'],
  quality: ['package', 'graph', 'scale', 'redact', 'frames'],
};

/** Insertion order, which is a topological order of STAGE_DEPS. */
const PIPELINE: readonly string[] = [
  'ingest', 'frames', 'redact', 'pose', 'scale', 'splat', 'mesh',
  'layout', 'semantics', 'graph', 'regions', 'package', 'quality',
];

const STAGE_GPU: Readonly<Record<string, number>> = {
  ingest: 14, frames: 22, redact: 140, pose: 310, scale: 46, splat: 1840, mesh: 260,
  layout: 95, semantics: 180, graph: 12, regions: 31, package: 24, quality: 5,
};
/**
 * How long each stage takes on the wall clock, which is not its GPU time: a
 * stage waits for a pod, uploads its outputs and writes its rows. The gap
 * between the two columns on the build screen is the point of showing both,
 * so the fixture has to have one.
 */
const STAGE_WALL_S: Readonly<Record<string, number>> = {
  ingest: 31, frames: 96, redact: 220, pose: 505, scale: 88, splat: 2040, mesh: 380,
  layout: 150, semantics: 260, graph: 40, regions: 62, package: 71, quality: 18,
};
/** RunPod A40 pricing at the time of writing, in USD per GPU-second. */
const USD_PER_GPU_SECOND = 0.00012;

function jobsFor(worldId: string, outcome: 'done' | 'running' | 'failed' | 'none', startedAt: Date): JobRow[] {
  if (outcome === 'none') return [];
  const failAt = PIPELINE.indexOf('splat');
  const runningAt = PIPELINE.indexOf('mesh');
  const jobId = (stage: string): string => `${worldId}_j${PIPELINE.indexOf(stage)}`;

  // Stages run one after another here, so each one starts when the previous
  // finished. Real stages on a busy queue do not, which is exactly why the
  // console reads started_at and finished_at rather than assuming this.
  let clock = startedAt.getTime() + 20_000;

  return PIPELINE.map((stage, i) => {
    const queuedAt = new Date(startedAt.getTime() + i * 1000).toISOString();
    let status = 'succeeded';
    let error: string | null = null;
    let attempt = 1;
    if (outcome === 'failed') {
      if (i === failAt) {
        status = 'failed';
        attempt = 2;
        error = 'CUDA out of memory. Tried to allocate 17.84 GiB (GPU 0; 44.35 GiB total capacity; 41.02 GiB already allocated). Reduce --splat-budget or use a larger GPU.';
      } else if (i > failAt) { status = 'queued'; attempt = 0; }
    } else if (outcome === 'running') {
      if (i === runningAt) { status = 'running'; }
      else if (i > runningAt) { status = 'queued'; attempt = 0; }
    }
    const ran = status === 'succeeded' || status === 'failed' || status === 'running';
    const gpu = ran ? STAGE_GPU[stage] ?? 10 : null;

    const startedIso = ran ? new Date(clock).toISOString() : null;
    if (ran) clock += (STAGE_WALL_S[stage] ?? 30) * 1000;
    // A stage still running has no finish, and a failed one finished when it
    // gave up — the console times both from started_at, so both are honest.
    const finishedIso = status === 'succeeded' || status === 'failed'
      ? new Date(clock).toISOString()
      : null;

    return {
      id: jobId(stage),
      stage,
      status,
      attempt,
      error,
      gpu_seconds: gpu,
      cost_usd: gpu === null ? null : Number((gpu * USD_PER_GPU_SECOND).toFixed(5)),
      queued_at: queuedAt,
      depends_on: (STAGE_DEPS[stage] ?? []).map(jobId),
      started_at: startedIso,
      finished_at: finishedIso,
    };
  });
}

function qualityFor(verdict: 'pass' | 'review' | 'fail', createdAt: string): Record<string, unknown> {
  const checks = verdict === 'pass'
    ? [
      { name: 'scale_agreement', value: 0.981, threshold: 0.95, higherIsBetter: true, pass: true },
      { name: 'pose_coverage', value: 0.962, threshold: 0.85, higherIsBetter: true, pass: true },
      { name: 'unobserved_volume_fraction', value: 0.031, threshold: 0.08, higherIsBetter: false, pass: true },
      { name: 'ceiling_observed_fraction', value: 0.91, threshold: 0.85, higherIsBetter: true, pass: true },
      { name: 'blur_rejected_fraction', value: 0.07, threshold: 0.25, higherIsBetter: false, pass: true },
      { name: 'room_closure', value: 1, threshold: 0.95, higherIsBetter: true, pass: true },
      { name: 'redaction_reviewed', value: 1, threshold: 1, higherIsBetter: true, pass: true },
    ]
    : verdict === 'review'
      ? [
        { name: 'scale_agreement', value: 0.981, threshold: 0.95, higherIsBetter: true, pass: true },
        { name: 'pose_coverage', value: 0.93, threshold: 0.85, higherIsBetter: true, pass: true },
        { name: 'unobserved_volume_fraction', value: 0.041, threshold: 0.08, higherIsBetter: false, pass: true },
        {
          name: 'ceiling_observed_fraction', value: 0.79, threshold: 0.85, higherIsBetter: true, pass: false,
          detail: 'bathroom ceiling never in view',
        },
        { name: 'blur_rejected_fraction', value: 0.11, threshold: 0.25, higherIsBetter: false, pass: true },
        { name: 'room_closure', value: 0.96, threshold: 0.95, higherIsBetter: true, pass: true },
        {
          name: 'redaction_reviewed', value: 0.6, threshold: 1, higherIsBetter: true, pass: false,
          detail: '2 of 5 detections still awaiting an operator',
        },
      ]
      : [
        {
          name: 'scale_agreement', value: 0.72, threshold: 0.95, higherIsBetter: true, pass: false,
          detail: 'the two estimators disagree by 28%; metres cannot be trusted',
        },
        {
          name: 'pose_coverage', value: 0.54, threshold: 0.85, higherIsBetter: true, pass: false,
          detail: '46% of frames could not be posed; the capture moved too fast',
        },
        { name: 'unobserved_volume_fraction', value: 0.22, threshold: 0.08, higherIsBetter: false, pass: false },
        { name: 'ceiling_observed_fraction', value: 0.41, threshold: 0.85, higherIsBetter: true, pass: false },
        { name: 'blur_rejected_fraction', value: 0.38, threshold: 0.25, higherIsBetter: false, pass: false },
        { name: 'room_closure', value: 0.62, threshold: 0.95, higherIsBetter: true, pass: false },
        { name: 'redaction_reviewed', value: 0, threshold: 1, higherIsBetter: true, pass: false },
      ];
  const score = verdict === 'pass' ? 0.964 : verdict === 'review' ? 0.91 : 0.48;
  return { checks, score, verdict, created_at: createdAt };
}

function buildPortfolio(): FixtureProperty[] {
  const rnd = mulberry32(20260919);
  const out: FixtureProperty[] = [];
  const now = Date.now();

  for (let i = 0; i < PROPERTY_COUNT; i += 1) {
    const street = STREETS[Math.floor(rnd() * STREETS.length)]!;
    const number = 1 + Math.floor(rnd() * 180);
    const kind = KINDS[Math.floor(rnd() * KINDS.length)]!;
    const beds = 1 + Math.floor(rnd() * 4);
    const postcode = `${POSTCODES[Math.floor(rnd() * POSTCODES.length)]}${1 + Math.floor(rnd() * 9)}${String.fromCharCode(65 + Math.floor(rnd() * 26))}${String.fromCharCode(65 + Math.floor(rnd() * 26))}`;
    const createdAt = new Date(now - Math.floor(rnd() * 240) * 86_400_000);

    const status = i === 0 ? 'review' : i === 1 ? 'failed' : i === 2 ? 'processing'
      : STATUSES[Math.floor(rnd() * STATUSES.length)]!;
    const versions = 1 + Math.floor(rnd() * 3);

    const worlds: FixtureWorld[] = [];
    for (let v = 1; v <= versions; v += 1) {
      const isLatest = v === versions;
      const worldStatus = isLatest ? status : 'archived';
      const worldCreated = new Date(createdAt.getTime() + (v - 1) * 26 * 86_400_000);
      const verdict = worldStatus === 'failed' ? 'fail'
        : worldStatus === 'review' ? 'review'
          : worldStatus === 'published' ? 'pass' : null;
      const outcome = worldStatus === 'failed' ? 'failed'
        : worldStatus === 'processing' ? 'running'
          : worldStatus === 'draft' ? 'none' : 'done';

      const quality = verdict ? qualityFor(verdict, new Date(worldCreated.getTime() + 3_600_000).toISOString()) : null;
      const history = quality
        ? (verdict === 'pass' && v > 1
          ? [quality, qualityFor('review', new Date(worldCreated.getTime() + 1_800_000).toISOString())]
          : [quality])
        : [];

      const id = `w_${i}_${v}`;
      worlds.push({
        id,
        property_id: `p_${i}`,
        version: v,
        status: worldStatus,
        published_at: worldStatus === 'published' ? new Date(worldCreated.getTime() + 7_200_000).toISOString() : null,
        quality_score: quality ? Number(quality['score']) : null,
        slug: worldStatus === 'published'
          ? `${number}-${street.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v${v}`
          : null,
        created_at: worldCreated.toISOString(),
        supersedes_id: v > 1 ? `w_${i}_${v - 1}` : null,
        scale_source: 'ARKit depth + door-leaf prior (2 estimators)',
        scale_agreement: 0.981,
        jobs: jobsFor(id, outcome, worldCreated),
        quality,
        qualityHistory: history,
        lastCorrectionAt: null,
      });
    }

    out.push({
      id: `p_${i}`,
      ref: `AW-${String(1000 + i)}`,
      label: `${number} ${street}`,
      postcode,
      address: { line1: `${number} ${street}`, town: 'London', kind, bedrooms: beds },
      created_at: createdAt.toISOString(),
      archived_at: i % 37 === 0 ? new Date(now - 5 * 86_400_000).toISOString() : null,
      worlds: worlds.sort((a, b) => b.version - a.version),
    });
  }
  return out;
}

function buildEvents(worlds: readonly FixtureWorld[]): EventRow[] {
  const rnd = mulberry32(760215);
  const rooms = FLAT.rooms.map((r) => r.id);
  const events: EventRow[] = [];
  const published = worlds.filter((w) => w.status === 'published').slice(0, 24);
  const now = Date.now();

  for (const world of published) {
    const sessions = 3 + Math.floor(rnd() * 40);
    for (let s = 0; s < sessions; s += 1) {
      const sessionId = `${world.id}_s${s}`;
      const start = now - Math.floor(rnd() * 28) * 86_400_000 - Math.floor(rnd() * 86_400_000);
      let t = start;
      events.push({ session_id: sessionId, kind: 'enter', at: new Date(t).toISOString(), room_id: null, payload: {} });

      const visits = 2 + Math.floor(rnd() * 7);
      let lastRoom = rooms[0]!;
      for (let v = 0; v < visits; v += 1) {
        // The kitchen is deliberately over-represented and revisited: it is the
        // room this product's analytics exist to make visible.
        const roomId = rnd() < 0.42 ? 'r_kitchen' : rooms[Math.floor(rnd() * rooms.length)]!;
        events.push({ session_id: sessionId, kind: 'room', at: new Date(t).toISOString(), room_id: roomId, payload: {} });
        t += Math.floor(8_000 + rnd() * 160_000);
        lastRoom = roomId;
      }
      if (rnd() < 0.35) events.push({ session_id: sessionId, kind: 'measure', at: new Date(t).toISOString(), room_id: lastRoom, payload: {} });
      if (rnd() < 0.44) events.push({ session_id: sessionId, kind: 'ask', at: new Date(t).toISOString(), room_id: lastRoom, payload: {} });
      if (rnd() < 0.09) events.push({ session_id: sessionId, kind: 'lead', at: new Date(t).toISOString(), room_id: lastRoom, payload: {} });
      if (rnd() < 0.8) events.push({ session_id: sessionId, kind: 'exit', at: new Date(t).toISOString(), room_id: lastRoom, payload: {} });
    }
  }
  return events;
}

const LEAD_NAMES = [
  'R. Mensah', 'J. Whitfield', 'A. Okonkwo', 'S. Petrova', 'D. Hargreaves',
  'L. Ferreira', 'K. Nakamura', 'M. O’Donnell', 'T. Adeyemi', 'C. Lindqvist',
];

function buildLeads(worlds: readonly FixtureWorld[]): LeadRow[] {
  const rnd = mulberry32(31337);
  const published = worlds.filter((w) => w.status === 'published').slice(0, 24);
  const out: LeadRow[] = [];
  const now = Date.now();
  published.forEach((world, i) => {
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k += 1) {
      const name = LEAD_NAMES[Math.floor(rnd() * LEAD_NAMES.length)]!;
      out.push({
        id: `lead_${i}_${k}`,
        world_id: world.id,
        session_id: `${world.id}_s${Math.floor(rnd() * 5)}`,
        name,
        email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@example.com`,
        phone: rnd() < 0.5 ? '07700 900' + String(100 + Math.floor(rnd() * 899)) : null,
        message: rnd() < 0.6
          ? 'Is the second bedroom big enough for a double bed and a desk?'
          : 'Could I arrange a viewing this weekend?',
        created_at: new Date(now - Math.floor(rnd() * 30) * 86_400_000).toISOString(),
      });
    }
  });
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export class FixtureApiClient implements ApiClient {
  readonly isFixture = true;
  private properties = buildPortfolio();
  private currentSession: Session | null = null;
  private currentMembership: Membership | null = null;
  private events: EventRow[] = [];
  private leads: LeadRow[] = [];
  private exports: ExportRow[] = [];
  private resumed = new Set<string>();

  constructor() {
    const worlds = this.properties.flatMap((p) => p.worlds);
    this.events = buildEvents(worlds);
    this.leads = buildLeads(worlds);
    this.exports = worlds
      .filter((w) => w.status === 'published')
      .slice(0, 6)
      .map((w, i) => ({
        id: `x_${i}`,
        world_id: w.id,
        formats: ['html', 'json', 'svg', 'spz', 'glb', 'sha256'],
        bytes: 24_500_000 + i * 3_100_000,
        checksum: `f${i}a3c9b2e7d41c6a8093bb5417de2c9f0a1b8c7d6e5f40312a9b8c7d6e5f4031${i}`,
        created_at: new Date(Date.now() - (i + 1) * 4 * 86_400_000).toISOString(),
        downloaded_at: i % 2 === 0 ? new Date(Date.now() - i * 86_400_000).toISOString() : null,
      }));
  }

  get session(): Session | null { return this.currentSession; }
  get membership(): Membership | null { return this.currentMembership; }

  async signIn(email: string): Promise<Session> {
    const account = DEMO_ACCOUNTS[email.trim().toLowerCase()];
    if (!account) {
      throw new ApiError(400, `This fixture knows four addresses: ${FIXTURE_ACCOUNTS.join(', ')}.`);
    }
    this.currentSession = {
      userId: account.userId,
      email: email.trim().toLowerCase(),
      accessToken: 'fixture',
      expiresAt: Date.now() + 86_400_000,
    };
    this.currentMembership = { org: ORG, role: account.role };
    try { localStorage.setItem('m3xi.console.fixture', this.currentSession.email); } catch { /* ignore */ }
    return this.currentSession;
  }

  async signOut(): Promise<void> {
    this.currentSession = null;
    this.currentMembership = null;
    try { localStorage.removeItem('m3xi.console.fixture'); } catch { /* ignore */ }
  }

  async restore(): Promise<Session | null> {
    try {
      const email = localStorage.getItem('m3xi.console.fixture');
      if (email && DEMO_ACCOUNTS[email]) return await this.signIn(email);
    } catch { /* ignore */ }
    return null;
  }

  async memberships(): Promise<readonly Membership[]> {
    return this.currentMembership ? [this.currentMembership] : [];
  }

  async useOrg(): Promise<Membership> {
    if (!this.currentMembership) throw new ApiError(401, 'Sign in first.');
    return this.currentMembership;
  }

  async listMembers(): Promise<readonly MemberRow[]> {
    return Object.entries(DEMO_ACCOUNTS).map(([email, a], i) => ({
      user_id: a.userId,
      email,
      role: a.role,
      created_at: new Date(Date.UTC(2026, 0, 4 + i)).toISOString(),
    }));
  }

  async listProperties(query: PortfolioQuery): Promise<Page<PropertyRow>> {
    const search = query.search.trim().toLowerCase();
    let rows = this.properties.filter((p) => {
      if (!query.includeArchived && p.archived_at) return false;
      if (query.status !== 'any') {
        const latest = p.worlds[0];
        if (!latest || latest.status !== query.status) return false;
      }
      if (search.length > 0) {
        const hay = `${p.label} ${p.ref ?? ''} ${p.postcode ?? ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const key = query.sort;
    rows = [...rows].sort((a, b) => {
      const av = String(a[key as keyof FixtureProperty] ?? '');
      const bv = String(b[key as keyof FixtureProperty] ?? '');
      return query.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    const total = rows.length;
    const clamped = clampPage(query, total);
    const from = (clamped.page - 1) * clamped.pageSize;
    return {
      rows: rows.slice(from, from + clamped.pageSize).map(stripJobs),
      total,
      page: clamped.page,
      pageSize: clamped.pageSize,
    };
  }

  async getProperty(propertyId: string): Promise<PropertyRow> {
    const found = this.properties.find((p) => p.id === propertyId);
    if (!found) throw new ApiError(404, 'No such property in this fixture.');
    return stripJobs(found);
  }

  async createProperty(input: { label: string; ref?: string; postcode?: string }): Promise<{ id: string }> {
    const id = `p_new_${this.properties.length}`;
    this.properties.unshift({
      id,
      ref: input.ref ?? null,
      label: input.label,
      postcode: input.postcode ?? null,
      address: {},
      created_at: new Date().toISOString(),
      archived_at: null,
      worlds: [],
    });
    return { id };
  }

  async archiveProperties(ids: readonly string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const p of this.properties) if (ids.includes(p.id)) p.archived_at = now;
  }

  async createWorld(propertyId: string): Promise<{ id: string; version: number }> {
    const property = this.find(propertyId);
    const version = (property.worlds[0]?.version ?? 0) + 1;
    const id = `${propertyId}_v${version}`;
    property.worlds.unshift({
      id,
      property_id: propertyId,
      version,
      status: 'draft',
      published_at: null,
      quality_score: null,
      slug: null,
      created_at: new Date().toISOString(),
      supersedes_id: property.worlds[0]?.id ?? null,
      scale_source: null,
      scale_agreement: null,
      jobs: [],
      quality: null,
      qualityHistory: [],
      lastCorrectionAt: null,
    });
    return { id, version };
  }

  async getWorld(worldId: string): Promise<WorldDetail> {
    const world = this.world(worldId);
    const bytes = world.status === 'draft' ? 0 : 19_212_644;
    const captures: CaptureRow[] = world.status === 'draft' ? [] : [{
      id: `${worldId}_c0`,
      kind: 'video',
      bytes: 412_884_221,
      duration_s: 184.4,
      frame_count: 5532,
      captured_at: world.created_at,
      created_at: world.created_at,
      coverage: { walkedRooms: 5, blurRejected: 0.11, reflectiveSurfaces: 2 },
    }];
    return {
      world: stripWorld(world),
      jobs: world.jobs,
      quality: world.quality,
      qualityHistory: world.qualityHistory,
      assetCount: world.status === 'draft' ? 0 : 8,
      assetBytes: bytes,
      roomCount: world.status === 'draft' ? 0 : FLAT.rooms.length,
      captures,
      lastCorrectionAt: world.lastCorrectionAt,
    };
  }

  async getWorldDocument(worldId: string): Promise<{ doc: WorldDocument | null; problems: readonly DataProblem[] }> {
    const world = this.world(worldId);
    if (world.jobs.length === 0) {
      return {
        doc: null,
        problems: [{
          level: 'blocker', code: 'no_rooms',
          message: 'This world has not been built yet, so there is nothing to walk.',
        }],
      };
    }
    // The same flat every package in this system tests against, relabelled to
    // this property so the review screen is not confusingly generic.
    const property = this.properties.find((p) => p.worlds.some((w) => w.id === worldId))!;
    return {
      doc: {
        ...FLAT,
        id: world.id,
        propertyId: property.id,
        version: world.version,
        label: property.label,
        ...(world.slug ? { slug: world.slug } : {}),
        // The world document's own quality block tracks this world's verdict.
        quality: (world.quality
          ? {
            checks: world.quality['checks'] as WorldDocument['quality']['checks'],
            score: Number(world.quality['score']),
            verdict: world.quality['verdict'] as WorldDocument['quality']['verdict'],
            createdAt: String(world.quality['created_at']),
          }
          : FLAT.quality),
        // No splat file is served by the fixture, so the assets are removed
        // rather than left pointing at nothing. Proxy-only is a real product
        // state and it is the one an operator reviews.
        assets: FLAT.assets.filter((a) => a.role === 'proxy_mesh'),
      },
      problems: [],
    };
  }

  async requestBuild(worldId: string): Promise<void> {
    const world = this.world(worldId);
    if (world.jobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'leased')) {
      throw new ApiError(409, 'A build is already running for this world.');
    }
    world.jobs = jobsFor(world.id, 'running', new Date());
    world.status = 'processing';
  }

  /**
   * Resume, with the same rules `resume_build` in wv-worlds/handler.ts
   * applies: the failed row goes back on the queue, its attempt counter is
   * kept rather than reset, and `started_at`/`finished_at` are cleared so the
   * next attempt times itself honestly instead of reporting a span that
   * includes the failure and the hours before anybody noticed it.
   *
   * Stages that already succeeded are untouched, including any that succeeded
   * on a branch the failure does not feed.
   */
  async resumeBuild(worldId: string): Promise<void> {
    const world = this.world(worldId);
    const failed = world.jobs.find((j) => j.status === 'failed');
    if (!failed) throw new ApiError(409, 'Nothing in this build has failed.');
    if ((failed.attempt ?? 0) >= 3) {
      throw new ApiError(409,
        `${failed.stage} has used all 3 attempts. The queue will not hand it out again; `
        + 'the capture itself needs looking at.');
    }
    world.jobs = world.jobs.map((j) => (j.id === failed.id
      ? { ...j, status: 'running', error: null, attempt: (j.attempt ?? 0) + 1, started_at: null, finished_at: null }
      : j));
    world.status = 'processing';
    this.resumed.add(worldId);
  }

  async applyCorrections(worldId: string, corrections: readonly Correction[]): Promise<{
    applied: number; rejected: readonly string[];
  }> {
    const world = this.world(worldId);
    const allowed = new Set(['name', 'kind', 'label', 'category', 'room_id']);
    const rejected = corrections.filter((c) => !allowed.has(c.field)).map((c) => `${c.target}.${c.field}`);
    const applied = corrections.length - rejected.length;
    // A correction touches a row, a row's `updated_at` moves, and `get_world`
    // reports the newest one. Recording it here is what makes the publish
    // gate go stale in the demo, which is the state an operator most needs to
    // have seen before they meet it on a real world.
    if (applied > 0) world.lastCorrectionAt = new Date().toISOString();
    return { applied, rejected };
  }

  async publish(worldId: string, slug?: string): Promise<{ publishedAt: string; slug: string | null }> {
    const world = this.world(worldId);
    const verdict = world.quality?.['verdict'];
    // The fixture enforces the same gate the edge function does, so the demo
    // cannot demonstrate something the real system would refuse.
    if (verdict !== 'pass') {
      throw new ApiError(409, verdict
        ? `Quality verdict is "${String(verdict)}", so this world cannot be published.`
        : 'This world has not been through the quality gate yet.');
    }
    const publishedAt = new Date().toISOString();
    world.status = 'published';
    world.published_at = publishedAt;
    if (slug) world.slug = slug;
    return { publishedAt, slug: world.slug };
  }

  async unpublish(worldId: string): Promise<void> {
    const world = this.world(worldId);
    world.status = 'review';
    world.published_at = null;
  }

  async createExport(worldId: string): Promise<ExportResult> {
    const world = this.world(worldId);
    const id = `x_new_${this.exports.length}`;
    const bytes = 26_114_880;
    this.exports.unshift({
      id,
      world_id: world.id,
      formats: ['html', 'json', 'svg', 'glb', 'sha256', 'txt'],
      bytes,
      checksum: 'b7e1a0c4d9f2381056ac7bd4e9f10236a8c5d7e0f1234567890abcdef1234567',
      created_at: new Date().toISOString(),
      downloaded_at: null,
    });
    return {
      queued: false,
      url: 'about:blank#fixture-bundle',
      bytes,
      checksum: 'b7e1a0c4d9f2381056ac7bd4e9f10236a8c5d7e0f1234567890abcdef1234567',
      files: [
        { path: 'viewer.html', bytes: 402_118 },
        { path: 'world.json', bytes: 1_842_006 },
        { path: 'floorplan.svg', bytes: 22_470 },
        { path: 'README.txt', bytes: 3_902 },
        { path: 'manifest.json', bytes: 5_118 },
        { path: 'CHECKSUMS.sha256', bytes: 812 },
        { path: 'assets/proxy_mesh.glb', bytes: 812_444 },
        { path: 'assets/splat_chunk-r_kitchen.spz', bytes: 18_220_100 },
      ],
      omittedAssets: [],
    };
  }

  async listExports(): Promise<readonly ExportRow[]> { return this.exports; }

  async signExportUrl(): Promise<string> {
    throw new ApiError(501, 'The fixture backend has no file to hand you. Connect a Supabase project to download a real bundle.');
  }

  async listLeads(limit = 500): Promise<readonly LeadRow[]> { return this.leads.slice(0, limit); }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const worldId = sessionId.split('_s')[0] ?? '';
    const events = this.events.filter((e) => e.session_id === sessionId);
    if (events.length === 0) return null;
    const first = events[0]!;
    const last = events[events.length - 1]!;
    return {
      id: sessionId,
      world_id: worldId,
      device: { platform: 'iOS 19.2', gpu: 'Apple A18', width: 393, height: 852 },
      referrer: 'https://www.rightmove.co.uk/',
      ai_turns: events.filter((e) => e.kind === 'ask').length,
      ai_cost_usd: events.filter((e) => e.kind === 'ask').length * 0.0042,
      started_at: first.at,
      ended_at: last.kind === 'exit' ? last.at : null,
    };
  }

  async listEvents(input: { worldId?: string; since?: string }): Promise<readonly EventRow[]> {
    const since = input.since ? Date.parse(input.since) : 0;
    return this.events.filter((e) => (
      (!input.worldId || e.session_id?.startsWith(input.worldId)) && Date.parse(e.at) >= since
    ));
  }

  async roomNames(): Promise<Readonly<Record<string, string>>> {
    const out: Record<string, string> = {};
    for (const room of FLAT.rooms) out[room.id] = room.name ?? room.kind;
    return out;
  }

  async listAiTurns(since: string): Promise<readonly AiTurnRow[]> {
    const start = Math.max(Date.parse(since), MONTH_START().getTime());
    const rnd = mulberry32(99001);
    const asks = this.events.filter((e) => e.kind === 'ask' && Date.parse(e.at) >= start);
    return asks.map((e) => ({
      at: e.at,
      cost_usd: 0.0021 + rnd() * 0.006,
      world_id: (e.session_id ?? '').split('_s')[0] ?? null,
      tier: rnd() < 0.7 ? 'small' : 'large',
    }));
  }

  async listJobsForOrg(since: string): Promise<readonly BuildJobRow[]> {
    const start = Date.parse(since);
    const out: BuildJobRow[] = [];
    for (const property of this.properties) {
      for (const world of property.worlds) {
        for (const job of world.jobs) {
          if (!job.queued_at || Date.parse(job.queued_at) < start) continue;
          out.push({
            stage: job.stage,
            queued_at: job.queued_at,
            world_id: world.id,
            cost_usd: job.cost_usd ?? 0,
            gpu_seconds: job.gpu_seconds ?? 0,
          });
        }
      }
    }
    return out;
  }

  async worldPropertyMap(): Promise<Readonly<Record<string, string>>> {
    const out: Record<string, string> = {};
    for (const p of this.properties) for (const w of p.worlds) out[w.id] = p.id;
    return out;
  }

  /** Labels for the spend table, which the real client reads from the same map. */
  propertyLabels(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of this.properties) out[p.id] = p.label;
    return out;
  }

  private find(propertyId: string): FixtureProperty {
    const found = this.properties.find((p) => p.id === propertyId);
    if (!found) throw new ApiError(404, 'No such property in this fixture.');
    return found;
  }

  private world(worldId: string): FixtureWorld {
    for (const p of this.properties) {
      const w = p.worlds.find((x) => x.id === worldId);
      if (w) return w;
    }
    throw new ApiError(404, 'No such world in this fixture.');
  }
}

function stripWorld(world: FixtureWorld): WorldSummary {
  const {
    jobs: _jobs, quality: _quality, qualityHistory: _history,
    lastCorrectionAt: _corrected, ...rest
  } = world;
  return rest;
}

function stripJobs(property: FixtureProperty): PropertyRow {
  return { ...property, worlds: property.worlds.map(stripWorld) };
}
