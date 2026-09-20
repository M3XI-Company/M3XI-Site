/**
 * The one place that talks to a model provider.
 *
 * Implements the agent's `ModelClient` interface against the Anthropic
 * Messages API. Two things here are load-bearing rather than incidental:
 *
 * 1. CACHE CONTROL. The system prompt and the scene-graph context are sent as
 *    two system blocks, the second marked `cache_control: ephemeral`. That
 *    single marker is worth roughly a third of the conversation bill, and it
 *    only works if both strings are byte-identical between turns -- which is
 *    why the agent builds them once and never formats them per turn.
 *
 * 2. USAGE NORMALISATION. Anthropic reports `input_tokens`,
 *    `cache_read_input_tokens` and `cache_creation_input_tokens` as three
 *    DISJOINT counts. The agent's cost model expects cached and written
 *    tokens to be subsets of a single total, so they are summed here. Getting
 *    this wrong under-reports a cached turn by about 90% of its prefix, which
 *    would make the spend cap fire far too late.
 *
 * This file is the one path in the system that cannot be exercised without a
 * live API key. Everything that consumes it is tested against the fake.
 */

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly version?: string;
  readonly timeoutMs?: number;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function makeAnthropicClient(opts: AnthropicOptions) {
  const version = opts.version ?? '2023-06-01';
  const timeoutMs = opts.timeoutMs ?? 20_000;

  return {
    async complete(reqUnknown: unknown): Promise<unknown> {
      const req = reqUnknown as {
        model: string; system: string; context: string;
        messages: { role: string; content: string }[];
        toolResults: { tool: string; json: string }[];
        maxOutputTokens: number;
      };

      if (!opts.apiKey) {
        // No key configured is a refusal, not a crash: the agent turns a
        // refusal into an honest "the assistant is unavailable".
        return { text: '', usage: { inTokens: 0, outTokens: 0 }, stopReason: 'refusal' };
      }

      const evidence = req.toolResults
        .map((t) => `<tool name="${t.tool}">${t.json}</tool>`)
        .join('\n');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${opts.baseUrl}/v1/messages`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': version,
          },
          body: JSON.stringify({
            model: mapModelId(req.model),
            max_tokens: req.maxOutputTokens,
            system: [
              { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
              { type: 'text', text: req.context, cache_control: { type: 'ephemeral' } },
            ],
            messages: [
              ...req.messages.map((m) => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
              })),
              {
                role: 'user',
                content: `Tool results for this turn. Every statement you make must come from these.\n${evidence}`,
              },
            ],
          }),
        });

        if (!res.ok) {
          return { text: '', usage: { inTokens: 0, outTokens: 0 }, stopReason: 'refusal' };
        }
        const body = await res.json() as {
          content?: { type?: string; text?: string }[];
          usage?: AnthropicUsage;
          stop_reason?: string;
        };
        const text = (body.content ?? [])
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('')
          .trim();

        const u = body.usage ?? {};
        const fresh = n(u.input_tokens);
        const cached = n(u.cache_read_input_tokens);
        const written = n(u.cache_creation_input_tokens);
        return {
          text,
          usage: {
            // Disjoint counts summed into the single total the cost model wants.
            inTokens: fresh + cached + written,
            cachedTokens: cached,
            cacheWriteTokens: written,
            outTokens: n(u.output_tokens),
          },
          stopReason: body.stop_reason === 'max_tokens' ? 'length' : 'end',
        };
      } catch {
        return { text: '', usage: { inTokens: 0, outTokens: 0 }, stopReason: 'refusal' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * The agent's catalogue keys are our own, not the provider's. Mapping here
 * keeps the routing table readable and lets the provider rename a snapshot
 * without touching the router.
 */
const MODEL_IDS: Readonly<Record<string, string>> = {
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-opus-5': 'claude-opus-5',
};

export function mapModelId(id: string): string {
  return MODEL_IDS[id] ?? id;
}
