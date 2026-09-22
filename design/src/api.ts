/**
 * EVERY call the creator studio makes to the server goes through this file.
 *
 * The website never holds a Supabase access token, a refresh token or an
 * account password (POSTER §2.5). All it ever has is a scoped session id and
 * a one-off browser secret, which the phone granted by scanning a code, and
 * which only reaches the `design-session` edge function.
 *
 * The edge function is written by another agent. Field names are read
 * tolerantly here — `expires` / `expires_at` / `session_expires_at` all land
 * in the same place — so that when the two sides meet, the fix is one edit in
 * this file and nothing else in the studio moves.
 */

export const SUPABASE_URL = 'https://cwjspmhgspiavyzrtosl.supabase.co';

/**
 * The CallMe project's public (anon) key. It is a publishable key: on its own
 * it can call the `design-session` function, which refuses everything until a
 * phone has paired a session. No table is readable with it.
 */
const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3anNwbWhnc3BpYXZ5enJ0b3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTI5NTQsImV4cCI6MjA5OTA4ODk1NH0.jhS5adiCcZFbfq5zRXQdRLN1k1hCOQ-Ft5ZhcLJO1zc';

const FN = SUPABASE_URL + '/functions/v1/design-session';

/** The public art bucket poster-publish writes into. */
export function artUrl(publicPath: string): string {
  return SUPABASE_URL + '/storage/v1/object/public/posters/' + publicPath;
}

export type Session = { id: string; secret: string; scope: 'creator' | 'poster' };

export class ApiError extends Error {
  reason: string;
  status: number;
  constructor(reason: string, status: number, message?: string) {
    super(message || reason);
    this.reason = reason;
    this.status = status;
  }
}

type Json = Record<string, unknown>;

function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** A timestamp from the server, as milliseconds since the epoch, or 0. */
function ms(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * One POST, one shape. Anything that is not a 2xx with a body becomes an
 * ApiError carrying the server's own word for what went wrong, so the studio
 * can say it in plain English without knowing the transport.
 */
export async function call<T = Json>(
  action: string,
  body?: Json,
  session?: Session | null,
): Promise<T> {
  const payload: Json = { action, ...(body || {}) };
  if (session) {
    payload.id = session.id;
    payload.secret = session.secret;
  }
  let res: Response;
  try {
    res = await fetch(FN, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: 'Bearer ' + ANON,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError('offline', 0, 'The studio could not reach the server.');
  }
  let data: Json = {};
  try {
    data = (await res.json()) as Json;
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new ApiError(str(pick(data, 'reason', 'status', 'error')) || 'try_again', res.status);
  }
  // The database helpers answer {status:'ok'} or {status:'<why>'}; the RPCs in
  // 0094/0095 answer {ok:false, reason:'<why>'}. Both mean the same thing here.
  const status = str(data.status);
  if (data.ok === false || (status && status !== 'ok')) {
    throw new ApiError(str(pick(data, 'reason', 'status')) || 'try_again', res.status);
  }
  return data as T;
}

/* ── Pairing ───────────────────────────────────────────────────────── */

export type OpenResult = {
  id: string;
  secret: string;
  code: string;
  matchCode: string;
  /** When the printed code dies. */
  codeExpiresAt: number;
  /** When the unpaired session itself gives up. */
  sessionExpiresAt: number;
};

/** A short, honest label for the letter on the phone: "Chrome on Windows". */
export function browserLabel(): string {
  const ua = navigator.userAgent || '';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : 'A browser';
  const os =
    /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'a Mac'
        : /Android/.test(ua) ? 'Android'
          : /(iPhone|iPad|iPod)/.test(ua) ? 'an iPhone'
            : /Linux/.test(ua) ? 'Linux'
              : 'a computer';
  return (browser + ' on ' + os).slice(0, 40);
}

function readOpen(d: Json): OpenResult {
  return {
    id: str(pick(d, 'id', 'session', 'session_id')),
    secret: str(pick(d, 'secret', 'session_secret')),
    code: str(pick(d, 'code', 'token')).toUpperCase(),
    matchCode: str(pick(d, 'match_code', 'match', 'matchCode')),
    codeExpiresAt: ms(pick(d, 'expires', 'expires_at', 'code_expires_at')),
    sessionExpiresAt: ms(pick(d, 'session_expires_at', 'session_expires')),
  };
}

export async function open(scope: 'creator' | 'poster' = 'creator'): Promise<OpenResult> {
  // No `browser` field: the label printed in the phone's letter is read off the
  // User-Agent header by the edge function and a body field is ignored on
  // purpose, so that a page pretending to be this one cannot write its own
  // sentence into a security letter. `browserLabel()` stays for the studio's
  // own words about the computer it is running on.
  const d = await call<Json>('open', { scope });
  return readOpen(d);
}

/**
 * A fresh printed code for a session that is still waiting (a code lives five
 * minutes, the session fifteen). `_design_token_issue` is the database side.
 *
 * COORDINATION: the edge function's action list did not name this one. If it
 * answers "unknown action", the studio falls back to opening a whole new
 * session, which looks the same to the person; the only cost is that the
 * session's own clock restarts. Ask the edge agent for `code`.
 */
export async function newCode(session: Session): Promise<OpenResult> {
  try {
    const d = await call<Json>('code', {}, session);
    const r = readOpen(d);
    return { ...r, id: r.id || session.id, secret: r.secret || session.secret };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 404 || e.reason === 'bad_request' || e.reason === 'unknown_action')) {
      return open(session.scope);
    }
    throw e;
  }
}

export type SessionState = 'open' | 'claimed' | 'confirmed' | 'ended';

export type StatusResult = {
  state: SessionState;
  scope: 'creator' | 'poster';
  name: string;
  photo: string;
  keep: boolean;
  matchCode: string;
  endedWhy: string;
  expiresAt: number;
  maxUntil: number;
};

export async function status(session: Session): Promise<StatusResult> {
  const d = await call<Json>('status', {}, session);
  const state = str(pick(d, 'state', 'session_state')) as SessionState;
  return {
    state: state === 'open' || state === 'claimed' || state === 'confirmed' ? state : 'ended',
    scope: (str(pick(d, 'scope')) === 'poster' ? 'poster' : 'creator'),
    name: str(pick(d, 'first_name', 'name')),
    photo: str(pick(d, 'photo', 'photo_url')),
    keep: !!pick(d, 'keep'),
    matchCode: str(pick(d, 'match_code', 'match')),
    endedWhy: str(pick(d, 'ended_why', 'why')),
    expiresAt: ms(pick(d, 'expires_at', 'expires')),
    maxUntil: ms(pick(d, 'max_until')),
  };
}

export async function confirm(session: Session): Promise<void> {
  await call('confirm', {}, session);
}

export async function notMe(session: Session): Promise<void> {
  await call('not_me', {}, session);
}

export async function done(session: Session): Promise<void> {
  await call('done', {}, session);
}

/* ── Designs ───────────────────────────────────────────────────────── */

export type DesignState =
  | 'draft' | 'checking' | 'awaiting_review' | 'refused' | 'ready' | 'live' | 'retired' | 'removed';

export type DesignCounts = {
  given: number;
  givenWaiting: number;
  earned: number;
  earnedWaiting: number;
  leftForGifts: number;
  leftForAwards: number;
  editionMax: number;
  awardQuota: number;
  issued: number;
};

export type Design = {
  id: string;
  kind: string;
  title: string;
  line: string;
  state: DesignState;
  review: 'none' | 'queued' | 'passed' | 'failed';
  doc: Record<string, unknown> | null;
  layers: Record<string, unknown> | null;
  art: string;
  win: number[];
  band: 'top' | 'bottom';
  intent: string[];
  editionMax: number;
  awardQuota: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  counts: DesignCounts | null;
  hasLayers: boolean;
};

function readCounts(v: unknown): DesignCounts | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Json;
  const n = (k: string): number => Number(c[k]) || 0;
  return {
    given: n('given'),
    givenWaiting: n('given_waiting'),
    earned: n('earned'),
    earnedWaiting: n('earned_waiting'),
    leftForGifts: n('left_for_gifts'),
    leftForAwards: n('left_for_awards'),
    editionMax: n('edition_max'),
    awardQuota: n('award_quota'),
    issued: n('issued'),
  };
}

export function readDesign(v: unknown): Design {
  const d = (v || {}) as Json;
  const win = Array.isArray(d.win) ? (d.win as unknown[]).map((n) => Number(n) || 0) : [];
  return {
    id: str(d.id),
    kind: str(d.kind) || 'card',
    title: str(d.title),
    line: str(d.line),
    state: (str(d.state) || 'draft') as DesignState,
    review: (str(d.review) || 'none') as Design['review'],
    doc: (d.doc && typeof d.doc === 'object' ? (d.doc as Json) : null),
    layers: (d.layers && typeof d.layers === 'object' ? (d.layers as Json) : null),
    art: str(pick(d, 'art', 'public_path')),
    win,
    band: str(d.band) === 'top' ? 'top' : 'bottom',
    intent: Array.isArray(d.intent) ? (d.intent as unknown[]).map(str) : [],
    editionMax: Number(d.edition_max) || 0,
    awardQuota: Number(d.award_quota) || 0,
    paused: !!d.paused,
    createdAt: ms(d.created_at),
    updatedAt: ms(d.updated_at),
    counts: readCounts(d.counts),
    hasLayers: !!pick(d, 'has_layers', 'hasLayers') || !!d.layers,
  };
}

function rows(d: Json): unknown[] {
  const v = pick(d, 'designs', 'rows', 'list', 'data');
  if (Array.isArray(v)) return v;
  if (Array.isArray(d)) return d as unknown[];
  return [];
}

export async function designsList(session: Session): Promise<Design[]> {
  const d = await call<Json>('designs-list', {}, session);
  return rows(d).map(readDesign);
}

export type SaveFields = {
  design?: string | null;
  kind?: 'card';
  title?: string;
  line?: string;
  doc?: Record<string, unknown>;
  layers?: Record<string, unknown>;
  edition_max?: number;
  intent?: string[];
};

export async function designSave(session: Session, fields: SaveFields): Promise<Design> {
  const { design, ...rest } = fields;
  const d = await call<Json>('design-save', { design: design || null, fields: rest, ...rest }, session);
  return readDesign(pick(d, 'design') || d);
}

export async function designSubmit(session: Session, design: string): Promise<Design> {
  const d = await call<Json>('design-submit', { design }, session);
  // The server answers { ok, design: <uuid>, state: 'checking' } — `design` is
  // the id, NOT a row. Reading that string as a row gave back an empty design
  // whose state fell back to 'draft', and the editor then stayed unfrozen on
  // the one screen where it matters. Anything richer is read as a row.
  const row = pick(d, 'design');
  if (row && typeof row === 'object') return readDesign(row);
  return readDesign({ id: str(row) || design, state: str(d.state) || 'checking' });
}

export async function designDelete(session: Session, design: string): Promise<void> {
  await call('design-delete', { design }, session);
}

export async function designDuplicate(session: Session, design: string): Promise<Design> {
  const d = await call<Json>('design-dup', { design }, session);
  return readDesign(pick(d, 'design') || d);
}

export type Stats = {
  /** How many designs there are, all states counted. */
  designs: number;
  /** Copies given, copies earned, letters still waiting to be kept, serials left. */
  given: number;
  earned: number;
  waiting: number;
  left: number;
  /** Uploads left in THIS session (twelve per session). */
  uploadsLeft: number;
};

/**
 * Counts only, never a name. The server sends them nested —
 * { designs: {draft,…,total}, copies: {given,earned,waiting,left},
 *   uploads: {used,left} } — so they are flattened here.
 */
export async function stats(session: Session): Promise<Stats> {
  const d = await call<Json>('stats', {}, session);
  const group = (k: string): Json => {
    const v = d[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
  };
  const designs = group('designs');
  const copies = group('copies');
  const uploads = group('uploads');
  return {
    designs: Number(pick(designs, 'total')) || 0,
    given: Number(copies.given) || 0,
    earned: Number(copies.earned) || 0,
    waiting: Number(copies.waiting) || 0,
    left: Number(copies.left) || 0,
    uploadsLeft: Number(pick(uploads, 'left')) || 0,
  };
}

/* ── Art ───────────────────────────────────────────────────────────── */

export type UploadTicket = {
  asset: string;
  /** The object's path inside the private inbox bucket: '<owner>/<asset>.<ext>'. */
  path: string;
  url: string;
  method: string;
  headers: Record<string, string>;
};

/**
 * A signed place to put the bytes, in the creator's own inbox folder.
 *
 * The server names the file from `ext`, so the extension has to be the one the
 * bytes really are: the browser re-encodes to PNG or JPEG and says which.
 */
export async function uploadUrl(
  session: Session,
  meta: { kind: 'card_art'; bytes: number; mime: string; sha256: string; w: number; h: number },
): Promise<UploadTicket> {
  const ext = meta.mime === 'image/png' ? 'png' : 'jpg';
  const d = await call<Json>('upload-url', { ...meta, ext }, session);
  const headers = (d.headers && typeof d.headers === 'object' ? d.headers : {}) as Record<string, string>;
  return {
    asset: str(pick(d, 'asset', 'asset_id', 'id')),
    path: str(pick(d, 'path', 'inbox_path')),
    url: str(pick(d, 'url', 'signed_url', 'upload_url')),
    method: (str(pick(d, 'method')) || 'PUT').toUpperCase(),
    headers,
  };
}

/** Send the bytes straight to storage with the ticket the server handed out. */
export async function putBytes(ticket: UploadTicket, blob: Blob): Promise<void> {
  const res = await fetch(ticket.url, {
    method: ticket.method,
    headers: { 'Content-Type': blob.type, ...ticket.headers },
    body: blob,
  });
  if (!res.ok) throw new ApiError('upload_failed', res.status, 'The picture did not finish uploading.');
}

export type AssetState = {
  state: 'pending' | 'checking' | 'ok' | 'refused' | 'removed';
  reason: string;
  w: number;
  h: number;
  /**
   * A short-lived signed look at the creator's own file in the private inbox.
   * Card art is never public before review, so this is the ONLY way to redraw
   * a draft's picture after a reload.
   */
  preview: string;
};

function readAsset(d: Json): AssetState {
  const s = str(pick(d, 'state', 'asset_state'));
  return {
    state: (s || 'pending') as AssetState['state'],
    reason: str(pick(d, 'reason', 'why')),
    w: Number(d.w) || 0,
    h: Number(d.h) || 0,
    preview: str(pick(d, 'preview', 'preview_url')),
  };
}

/**
 * The bytes are up: register them and start their checks.
 *
 * It takes the ticket's PATH, not its asset id. Nothing exists in the database
 * until this call, and the server derives the asset id from the path; asking
 * by id alone is how you ask again about a row that is already there, and on a
 * first upload it simply answers 'not_found'. THIS is the call that spends the
 * day's check allowance — poll `assetState`, not this.
 */
export async function assetDone(session: Session, ticket: UploadTicket): Promise<AssetState> {
  const body: Json = ticket.path ? { path: ticket.path } : { asset: ticket.asset };
  return readAsset(await call<Json>('asset-done', { ...body, kind: 'card_art' }, session));
}

export async function assetState(session: Session, asset: string): Promise<AssetState> {
  return readAsset(await call<Json>('asset-state', { asset }, session));
}

/* ── Saying it in plain English ────────────────────────────────────── */

const WORDS: Record<string, string> = {
  offline: 'The studio could not reach the server. Check your connection and try again.',
  slow_down: 'That was a lot of tries at once. Wait a minute and start again.',
  // Neither of these means "you are not Premium" — the studio needs Premium,
  // an age check, the creator terms and an identity key, and the server does
  // not say which one is missing. The phone does, so it is sent there. (The
  // app had exactly this bug and was fixed; see creatorBlockReason.)
  needs_premium: 'We can’t open the studio for this account. Your phone can tell you why — open CallMe and look under Settings, Creator studio.',
  not_creator: 'We can’t open the studio for this account. Your phone can tell you why — open CallMe and look under Settings, Creator studio.',
  bad_scope: 'That code was for something else. Start again from this page.',
  unknown: 'This session is over. Scan a fresh code to sign in again.',
  closed: 'This session is over. Scan a fresh code to sign in again.',
  not_claimed: 'Nobody has scanned this code yet.',
  no_design: 'That design is not here any more.',
  frozen: 'This one has been sent for checking, so it cannot be changed. Make a copy instead.',
  not_draft: 'This one has already been sent for checking.',
  not_yet: 'That is not open yet.',
  incomplete: 'Something is missing. Check the art, the title and the photo window.',
  bad_art: 'The art is not ready yet. Wait for the paper clip to come off it.',
  too_big: 'That is too much for one design. Take something out.',
  too_many: 'You have a lot of designs. Delete one you are not using.',
  too_many_drafts: 'You have a lot of unfinished designs. Send one for checking, or throw one away, and try again.',
  bad_request: 'The studio sent something the server did not understand. Please tell us.',
  upload_failed: 'The picture did not finish uploading. Try it again.',
  try_again: 'Something went wrong. Try that again.',
};

export function say(e: unknown): string {
  if (e instanceof ApiError) return WORDS[e.reason] || WORDS.try_again;
  return WORDS.try_again;
}
