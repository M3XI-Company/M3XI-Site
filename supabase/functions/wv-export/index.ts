import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { makeBaseDeps, serveHandler } from '../_wv_shared/serve.ts';
import { readWorldDocument } from '../_wv_shared/worldDocument.ts';
import { handleExport, type ExportDeps } from './handler.ts';

declare const Deno: { serve(h: (req: Request) => Promise<Response>): void };

const base = makeBaseDeps();
const deps: ExportDeps = {
  ...base,
  /**
   * The cached document, not a fresh render.
   *
   * `buildWorldDocument` reassembles a world from thirteen selects. Doing that
   * on every export made each one pay for a rendering of rows that had not
   * changed since the last export, or since the world was published.
   * `readWorldDocument` serves the stored object and re-renders only when the
   * cache is absent, marked stale by a correction, or unreadable -- the three
   * cases where the cache cannot be trusted, as opposed to merely being old.
   *
   * The handler is unchanged: it asked for a document and it still gets one.
   * See the header of _wv_shared/worldDocument.ts, which names this wiring.
   */
  buildWorldDocument: (worldId: string) => readWorldDocument(base, worldId).then((r) => r.document),
};

Deno.serve(serveHandler('wv-export', deps, handleExport));
