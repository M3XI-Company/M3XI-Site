/**
 * Runtime configuration.
 *
 * Read from a global the host page may set, falling back to Vite's build-time
 * env — the same shape as the console's `config.ts`, so an agency deploying
 * both configures them the same way.
 *
 * Nothing secret is here. The anon key is a public identifier; RLS and the
 * `wv-captures` bucket policy are what actually decide whether this operator
 * may write to this world, and both are enforced on the server.
 *
 * THERE IS NO FIXTURE BACKEND. The console has one, because a console with no
 * project configured can still usefully show a portfolio of made-up
 * properties. This app cannot: every screen it has leads to a 3 GB upload into
 * a real bucket and a row in a real table, and a fixture would mean an
 * operator could walk a property, see a green tick, and have uploaded nothing
 * anywhere. When there is no Supabase project, the app says so on the first
 * screen and refuses to start.
 */

export interface CaptureConfig {
  readonly supabaseUrl: string | null;
  readonly supabaseAnonKey: string | null;
  /**
   * The resumable upload endpoint.
   *
   * Supabase's own documentation recommends the DIRECT storage hostname —
   * `https://<ref>.storage.supabase.co` rather than `https://<ref>.supabase.co`
   * — for large uploads, because it skips the API gateway and is measurably
   * faster for multi-gigabyte objects. It is derived here when the project URL
   * has the standard shape and left as the project URL when it does not, so a
   * custom domain or a self-hosted instance still works. Either host accepts
   * the same protocol; only the throughput differs.
   */
  readonly uploadEndpoint: string | null;
}

interface ConfigGlobal {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  uploadEndpoint?: string;
}

declare global {
  interface Window { __M3XI_CAPTURE__?: ConfigGlobal }
}

/**
 * Build-time env, read STATICALLY.
 *
 * `import.meta.env[someVariable]` is the obvious way to write this and it does
 * not work in a production build. Vite substitutes `import.meta.env.VITE_NAME`
 * at compile time by textual replacement; a dynamic subscript is not a text it
 * can match, so the expression survives into the bundle, evaluates against
 * whatever `import.meta.env` happens to be in the browser, and yields
 * undefined. It works perfectly in `vite dev`, where `import.meta.env` is a
 * real object — which is exactly what makes the failure expensive: it appears
 * only in the deployed build, as an app that says it is not configured.
 *
 * I checked this rather than assuming it: built the app with the variables set
 * and grepped the emitted chunk. The names were still there as literal
 * property lookups and the values were nowhere in the file.
 *
 * So each variable is spelled out. The cost is that adding one means editing
 * this object; the benefit is that a deployment either has it or does not, and
 * finds out at build time.
 */
const ENV: Readonly<Record<string, string | undefined>> = {
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  VITE_SUPABASE_UPLOAD_ENDPOINT: import.meta.env.VITE_SUPABASE_UPLOAD_ENDPOINT as string | undefined,
};

function env(key: keyof typeof ENV): string | undefined {
  return ENV[key];
}

/** `https://ref.supabase.co` -> `https://ref.storage.supabase.co`, or null. */
export function storageHostFor(projectUrl: string): string | null {
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i.exec(projectUrl.trim());
  return match ? `https://${match[1]}.storage.supabase.co` : null;
}

export function readConfig(): CaptureConfig {
  const g = typeof window !== 'undefined' ? window.__M3XI_CAPTURE__ ?? {} : {};
  const rawUrl = g.supabaseUrl ?? env('VITE_SUPABASE_URL') ?? null;
  const url = rawUrl && rawUrl.length > 0 ? rawUrl.replace(/\/+$/, '') : null;
  const key = g.supabaseAnonKey ?? env('VITE_SUPABASE_ANON_KEY') ?? null;
  const override = g.uploadEndpoint ?? env('VITE_SUPABASE_UPLOAD_ENDPOINT') ?? null;

  const base = url === null ? null : (storageHostFor(url) ?? url);
  return {
    supabaseUrl: url,
    supabaseAnonKey: key && key.length > 0 ? key : null,
    uploadEndpoint: override && override.length > 0
      ? override.replace(/\/+$/, '')
      : base === null ? null : `${base}/storage/v1/upload/resumable`,
  };
}

export function isConfigured(config: CaptureConfig): config is CaptureConfig & {
  supabaseUrl: string; supabaseAnonKey: string; uploadEndpoint: string;
} {
  return config.supabaseUrl !== null && config.supabaseAnonKey !== null
    && config.uploadEndpoint !== null;
}

/** The bucket the walkthrough goes into. Named once. */
export const CAPTURE_BUCKET = 'wv-captures';
