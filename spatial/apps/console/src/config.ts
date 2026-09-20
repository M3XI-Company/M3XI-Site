/**
 * Runtime configuration.
 *
 * Read from a global the host page sets, falling back to Vite's build-time
 * env. Nothing secret lives here: the anon key is a public identifier and RLS
 * is what actually protects the data, which is why `wv-view` exists as the
 * only endpoint anonymous traffic touches.
 *
 * When no Supabase project is configured the console runs against the declared
 * fixture backend in `api/fixture.ts` and says so, loudly, in the header. An
 * operator must never be unsure whether the numbers in front of them are real.
 */

export interface ConsoleConfig {
  readonly supabaseUrl: string | null;
  readonly supabaseAnonKey: string | null;
  /**
   * Where the published viewer page is deployed. The repo builds
   * `spatial/apps/view/index.html`, which Vite emits at that same path, so
   * that is the default. An agency on a custom domain overrides it.
   */
  readonly viewerBaseUrl: string;
}

interface ConfigGlobal {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  viewerBaseUrl?: string;
}

declare global {
  interface Window { __M3XI_CONSOLE__?: ConfigGlobal }
}

function env(key: string): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return meta.env?.[key];
}

export function readConfig(): ConsoleConfig {
  const g = typeof window !== 'undefined' ? window.__M3XI_CONSOLE__ ?? {} : {};
  const url = g.supabaseUrl ?? env('VITE_SUPABASE_URL') ?? null;
  const key = g.supabaseAnonKey ?? env('VITE_SUPABASE_ANON_KEY') ?? null;
  const viewer = g.viewerBaseUrl ?? env('VITE_VIEWER_BASE_URL')
    ?? (typeof window !== 'undefined'
      ? new URL('/spatial/apps/view/', window.location.origin).toString()
      : 'https://m3xi.com/spatial/apps/view/');
  return {
    supabaseUrl: url && url.length > 0 ? url : null,
    supabaseAnonKey: key && key.length > 0 ? key : null,
    viewerBaseUrl: viewer,
  };
}

export function isConfigured(config: ConsoleConfig): boolean {
  return config.supabaseUrl !== null && config.supabaseAnonKey !== null;
}
