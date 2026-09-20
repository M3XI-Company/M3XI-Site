import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { makeBaseDeps, serveHandler } from '../_wv_shared/serve.ts';
import { handleAsk, type AskDeps } from './handler.ts';
import { makeAgentRunner, type AgentModule } from './runner.ts';
import { makeAnthropicClient } from './anthropic.ts';
// Resolved through supabase/functions/deno.json to the BUILT package. Run
// `npm run build` in spatial/ before deploying; the map points at dist/,
// where the package's internal ".js" specifiers are real files.
import * as agentModule from '@m3xi/agent';

declare const Deno: {
  serve(h: (req: Request) => Promise<Response>): void;
  env: { get(k: string): string | undefined };
};

const base = makeBaseDeps();

const deps: AskDeps = {
  ...base,
  agent: makeAgentRunner({
    db: base.db,
    agentModule: agentModule as unknown as AgentModule,
    modelClient: makeAnthropicClient({
      apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
      baseUrl: Deno.env.get('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com',
    }),
    routing: {
      // Model choice is configuration, never a constant at a call site.
      ...(Deno.env.get('WV_MODEL_SMALL') ? { small: Deno.env.get('WV_MODEL_SMALL') } : {}),
      ...(Deno.env.get('WV_MODEL_LARGE') ? { large: Deno.env.get('WV_MODEL_LARGE') } : {}),
      ...(Deno.env.get('WV_SESSION_COST_CAP_USD')
        ? { sessionCostCapUsd: Number(Deno.env.get('WV_SESSION_COST_CAP_USD')) } : {}),
    },
  }),
};

Deno.serve(serveHandler('wv-ask', deps, handleAsk));
