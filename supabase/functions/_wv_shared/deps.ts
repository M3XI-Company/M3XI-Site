/**
 * Everything a handler needs from the outside world, as one injectable object.
 *
 * The shape is deliberately narrow. A handler cannot open a socket, read an
 * environment variable or call Date.now(); it asks `deps` and gets whatever the
 * caller decided to give it. Under vitest that is an in-memory fixture; in
 * production it is PostgREST over the service role.
 */

export interface DbFilter {
  readonly [column: string]: string | number | boolean | null | readonly string[];
}

export interface SelectOptions {
  readonly columns?: readonly string[];
  readonly eq?: DbFilter;
  readonly in?: Readonly<Record<string, readonly string[]>>;
  readonly order?: { readonly column: string; readonly ascending: boolean };
  readonly limit?: number;
}

export type Row = Record<string, unknown>;

/**
 * The service-role database handle.
 *
 * Every wv-* function runs as the service role, because RLS denies anon
 * everything and the public viewer still has to work. That makes COLUMN
 * FILTERING the only thing standing between a viewer and an operator's data,
 * so `select` takes an explicit column list and the handlers never pass '*'
 * on a table the public can reach.
 */
export interface UpsertOptions {
  /**
   * Columns forming the conflict target. Omitted means the primary key.
   *
   * Name a UNIQUE constraint's columns, never an arbitrary set: Postgres
   * resolves `on conflict` against an index, and a target that has no index
   * behind it is an error at run time rather than a slower query.
   */
  readonly onConflict?: readonly string[];
}

export interface Db {
  select(table: string, opts: SelectOptions): Promise<Row[]>;
  insert(table: string, values: Row | Row[]): Promise<Row[]>;
  /**
   * Insert, or update the row already occupying the conflict target.
   *
   * This is what makes the pipeline's hand-off to the database resumable. A
   * GPU pod that dies half way through delivering a world has its job
   * reclaimed and starts the hand-off again; every row it sends carries a key
   * derived from (world id, section, the document's own id), so the second
   * pass lands on the first pass's rows instead of doubling every surface,
   * every camera and every nav node in the property.
   */
  upsert(table: string, values: Row | Row[], opts?: UpsertOptions): Promise<Row[]>;
  update(table: string, values: Row, where: DbFilter): Promise<Row[]>;
  /** Postgres function call. The helper RPCs live here. */
  rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface Storage {
  /**
   * A time-limited URL for a private object. Assets are never public: a
   * splat of somebody's home is personal data, and an unguessable path is not
   * an access control.
   */
  signUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
  /**
   * A time-limited URL a caller may PUT bytes to, for one object, once.
   *
   * This is what lets a rented GPU box deliver a 40 MB splat without holding a
   * storage credential. The worker gets a URL scoped to one path with a short
   * expiry; it cannot list the bucket, cannot read anything, and cannot write
   * anywhere the issuing handler did not name. A service-role key on
   * third-party hardware can do all three.
   */
  signUploadUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
  download(bucket: string, path: string): Promise<Uint8Array>;
  upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Env {
  get(name: string): string | undefined;
}

export interface BaseDeps {
  readonly db: Db;
  readonly storage: Storage;
  readonly clock: Clock;
  readonly env: Env;
  /** Resolves the signed-in user from an Authorization header, or null. */
  readonly authUser: (authorization: string | undefined) => Promise<{ id: string } | null>;
  readonly randomId: () => string;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}
