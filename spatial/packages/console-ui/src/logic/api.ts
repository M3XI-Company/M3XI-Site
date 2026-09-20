/**
 * The client interface the console is written against, and the one the
 * correction editor and compliance centre are handed.
 *
 * It is an interface rather than a class so that the fixture backend, the real
 * Supabase backend and a test double are interchangeable, and so the review
 * builder can depend on a type rather than on my implementation.
 *
 * Everything here maps onto something that exists:
 *   - reads go to PostgREST as the signed-in member, under RLS;
 *   - `requestBuild`, `publish`, `unpublish`, `applyCorrections`, `createWorld`
 *     and `createProperty` go to the `wv-worlds` edge function;
 *   - `createExport` goes to `wv-export`.
 * Where something does not exist yet it is marked, so nobody mistakes an
 * aspiration for an endpoint.
 */

import type { WorldDocument } from '@m3xi/world-core';
import type { MemberRole } from './roles.js';
import type { Page, PortfolioQuery } from './paging.js';
import type { EventRow } from './analytics.js';
import type { AiTurnRow, BuildJobRow, OrgCaps } from './spend.js';
import type { JobRow } from './jobs.js';
import type { DataProblem } from './worldDocument.js';

export interface Session {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

export interface Org extends OrgCaps {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly created_at?: string | null;
}

export interface Membership {
  readonly org: Org;
  readonly role: MemberRole;
}

export interface MemberRow {
  readonly user_id: string;
  /**
   * `wv_member.email`, denormalised from `auth.users` by trigger so a member
   * list needs no access to it. Still nullable: it is filled from the account
   * that owns `user_id`, and an account with no address on it has none to
   * copy. `user_id` remains the identity; this is only how a person is shown.
   */
  readonly email: string | null;
  readonly role: MemberRole;
  readonly created_at: string;
}

export interface WorldSummary {
  readonly id: string;
  readonly property_id: string;
  readonly version: number;
  readonly status: string;
  readonly published_at: string | null;
  readonly quality_score: number | null;
  readonly slug: string | null;
  readonly created_at: string;
  readonly supersedes_id: string | null;
  readonly scale_source?: string | null;
  readonly scale_agreement?: number | null;
}

export interface PropertyRow {
  readonly id: string;
  readonly ref: string | null;
  readonly label: string;
  readonly postcode: string | null;
  readonly address: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly archived_at: string | null;
  /** Newest version first. */
  readonly worlds: readonly WorldSummary[];
}

export interface WorldDetail {
  readonly world: WorldSummary;
  readonly jobs: readonly JobRow[];
  readonly quality: Readonly<Record<string, unknown>> | null;
  /** All quality reports, newest first, so the history is visible. */
  readonly qualityHistory: readonly Readonly<Record<string, unknown>>[];
  readonly assetCount: number;
  readonly assetBytes: number;
  readonly roomCount: number;
  readonly captures: readonly CaptureRow[];
  /**
   * The newest `updated_at` across the four correctable tables — rooms,
   * entities, openings and surfaces — as `get_world` computes it, or null when
   * nothing in this world has ever been edited.
   *
   * The publish gate's `stale` state is decided by this against the quality
   * report's `created_at`, so a null here is not a convenience: it means "no
   * correction", and anything that guesses it turns the gate off.
   */
  readonly lastCorrectionAt: string | null;
}

export interface CaptureRow {
  readonly id: string;
  readonly kind: string;
  readonly bytes: number | null;
  readonly duration_s: number | null;
  readonly frame_count: number | null;
  readonly captured_at: string | null;
  readonly created_at: string;
  readonly coverage: Readonly<Record<string, unknown>>;
}

export interface LeadRow {
  readonly id: string;
  readonly world_id: string;
  readonly session_id: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly message: string | null;
  readonly created_at: string;
}

export interface SessionRow {
  readonly id: string;
  readonly world_id: string;
  readonly device: Readonly<Record<string, unknown>>;
  readonly referrer: string | null;
  readonly ai_turns: number;
  readonly ai_cost_usd: number;
  readonly started_at: string;
  readonly ended_at: string | null;
}

export interface ExportRow {
  readonly id: string;
  readonly world_id: string;
  readonly formats: readonly string[];
  readonly bytes: number | null;
  readonly checksum: string | null;
  readonly created_at: string;
  readonly downloaded_at: string | null;
}

/** One field on one row, as `wv-worlds` `approve_corrections` accepts it. */
export interface Correction {
  readonly target: 'room' | 'entity';
  readonly id: string;
  readonly field: string;
  readonly value: string;
}

/**
 * An asset that is not inside the zip, exactly as `wv-export` reports it.
 *
 * This mirrors `OmittedAsset` in supabase/functions/wv-export/bundle.ts, which
 * is also what is written into manifest.json and assets/DOWNLOAD.md, so the
 * console shows the customer the same record the bundle carries.
 *
 * `role`, `bytes` and `reason` are what tells somebody a file is missing. The
 * rest is what lets them do something about it: the format, so they know what
 * they are about to download; the checksum, so a file fetched separately can
 * be verified to the same standard as everything in CHECKSUMS.sha256; and a
 * signed URL with the moment it stops working.
 *
 * Those four are optional AND nullable, and both mean the same thing here: no
 * checksum was recorded, or no link could be issued for this object. A missing
 * `url` is not an inconvenience to paper over — it is the one case on this
 * screen that needs a human, so the renderer says so rather than printing a
 * link that was never valid.
 */
export interface OmittedAsset {
  readonly role: string;
  readonly bytes: number;
  readonly reason: string;
  readonly format?: string | null;
  readonly checksum?: string | null;
  readonly url?: string | null;
  /** ISO-8601. When `url` stops working; null whenever there is no `url`. */
  readonly expiresAt?: string | null;
}

export interface ExportResult {
  /**
   * Always false from a current `wv-export`: it builds the bundle and returns
   * it, and there is no background packaging to wait for. Kept on the type
   * because the field is still on the wire, and because a deployment running
   * the old function would return true — which the console treats as a fault
   * to report, not as a bundle on its way. See `pages/exports.ts`.
   */
  readonly queued: boolean;
  readonly url?: string;
  readonly bytes?: number;
  readonly checksum?: string;
  readonly files?: readonly { readonly path: string; readonly bytes: number }[];
  readonly omittedAssets?: readonly OmittedAsset[];
  readonly reason?: string;
  readonly jobId?: string | null;
  /** The life of every signed link in this response, in seconds. */
  readonly expiresInSeconds?: number;
}

/**
 * A refusal from the server, carrying the sentence the server wrote.
 *
 * There is deliberately no "the deployment cannot do this" flag on it. Every
 * action the console offers exists on `wv-worlds`, so a failure is a refusal
 * with a reason — the cap is spent, a worker holds the lease, the quality gate
 * said no — and the reason is what the operator needs to see.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiClient {
  /** Null until sign-in completes. */
  readonly session: Session | null;
  readonly membership: Membership | null;
  /** True when this client is reading declared fixtures, not a real database. */
  readonly isFixture: boolean;

  signIn(email: string, password: string): Promise<Session>;
  signOut(): Promise<void>;
  restore(): Promise<Session | null>;
  memberships(): Promise<readonly Membership[]>;
  useOrg(orgId: string): Promise<Membership>;

  listMembers(): Promise<readonly MemberRow[]>;

  listProperties(query: PortfolioQuery): Promise<Page<PropertyRow>>;
  getProperty(propertyId: string): Promise<PropertyRow>;
  createProperty(input: {
    label: string; ref?: string; postcode?: string; address?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  archiveProperties(ids: readonly string[]): Promise<void>;

  createWorld(propertyId: string): Promise<{ id: string; version: number }>;
  getWorld(worldId: string): Promise<WorldDetail>;
  /** Assembled from the member-readable rows; see `worldDocument.ts`. */
  getWorldDocument(worldId: string): Promise<{
    doc: WorldDocument | null; problems: readonly DataProblem[];
  }>;

  requestBuild(worldId: string): Promise<void>;
  /**
   * Resume a failed build from the stage that failed.
   *
   * `wv-worlds` `resume_build` requeues the failed rows themselves, which is
   * the only way this can work: `wv_job` grants no UPDATE to `authenticated`,
   * so a browser cannot put a job back on the queue directly. It refuses a
   * stage that has burned its three attempts and refuses while a worker still
   * holds a lease, and says which, so an `ApiError` from here carries a
   * sentence worth showing.
   */
  resumeBuild(worldId: string): Promise<void>;

  applyCorrections(worldId: string, corrections: readonly Correction[]): Promise<{
    applied: number; rejected: readonly string[];
  }>;

  publish(worldId: string, slug?: string): Promise<{ publishedAt: string; slug: string | null }>;
  unpublish(worldId: string): Promise<void>;

  createExport(worldId: string): Promise<ExportResult>;
  listExports(): Promise<readonly ExportRow[]>;
  signExportUrl(exportId: string): Promise<string>;

  listLeads(limit?: number): Promise<readonly LeadRow[]>;
  getSession(sessionId: string): Promise<SessionRow | null>;

  listEvents(input: { worldId?: string; since?: string; limit?: number }): Promise<readonly EventRow[]>;
  roomNames(worldId: string): Promise<Readonly<Record<string, string>>>;

  listAiTurns(since: string): Promise<readonly AiTurnRow[]>;
  listJobsForOrg(since: string): Promise<readonly BuildJobRow[]>;
  /** worldId -> propertyId, for attributing spend. */
  worldPropertyMap(): Promise<Readonly<Record<string, string>>>;
}
