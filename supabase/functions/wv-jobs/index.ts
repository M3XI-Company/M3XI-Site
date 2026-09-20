import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { makeBaseDeps, serveHandler } from '../_wv_shared/serve.ts';
import { handleJobs } from './handler.ts';

declare const Deno: { serve(h: (req: Request) => Promise<Response>): void };

Deno.serve(serveHandler('wv-jobs', makeBaseDeps(), handleJobs));
