import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const DEFAULTS = {
  imgT2I: "fal-ai/flux/schnell",
  imgI2I: "fal-ai/flux/dev/image-to-image",
  vidT2V: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
  vidI2V: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
  asset: "fal-ai/hunyuan3d-v3/image-to-3d",
  llm: "fal-ai/any-llm",
  // Nano Banana 2: the UGC keyframe model (creator + product + scene in one edit).
  imgNB: "fal-ai/nano-banana-2",
  imgNBEdit: "fal-ai/nano-banana-2/edit",
};
/* The language model behind Research, Refine and the UGC script writer.
   Routed through fal any-llm so it bills to the same wallet as everything
   else — one key, one balance. */
const LLM_MODEL = Deno.env.get("M3IX_LLM") ?? "anthropic/claude-sonnet-4";

/* ---------------------------------------------------------------------------
   NO PAID PROVIDER BY DEFAULT.

   fal is OFF unless M3IX_PROVIDER_ENABLED=true is set as a secret. With it off,
   nothing in this function can create a bill: images and video go to the
   local render queue (worker/ in the repo, our own GPU), and the free tier at
   /studio/free.html runs in the visitor's browser. Flip the secret on the day
   there are paying customers and a reason to rent GPU time.
   --------------------------------------------------------------------------- */
const PROVIDER_ON = (Deno.env.get("M3IX_PROVIDER_ENABLED") ?? "false").toLowerCase() === "true";
const PROVIDER_OFF_MSG = "Cloud rendering is switched off to keep costs at zero. Free tier: /studio/free.html runs in your browser. Paid credits queue on our own render box instead.";
/* Free language model for Research/Refine: Groq's free tier, if a key is set.
   Costs nothing; quality is fine for prompt writing. */
const GROQ_MODEL = Deno.env.get("M3IX_GROQ_MODEL") ?? "llama-3.3-70b-versatile";
const WL = "https://api.worldlabs.ai/marble/v1";
const PART_LIMIT = 45 * 1024 * 1024;

const COST_IMAGE = Number(Deno.env.get("M3IX_COST_IMAGE") ?? 1);
const COST_VIDEO = Number(Deno.env.get("M3IX_COST_VIDEO") ?? 60);
const COST_ASSET = Number(Deno.env.get("M3IX_COST_ASSET") ?? 15);
const COST_REFINE = Number(Deno.env.get("M3IX_COST_REFINE") ?? 2);
const COST_WORLD = Number(Deno.env.get("M3IX_COST_WORLD") ?? 150);
const COST_WORLD_DRAFT = Number(Deno.env.get("M3IX_COST_WORLD_DRAFT") ?? 40);
// Nano Banana 2 costs us ~8¢ a frame, so it cannot sit on the 1-credit tier.
const COST_IMAGE_NB = Number(Deno.env.get("M3IX_COST_IMAGE_NB") ?? 4);
// A clip rendered on our own GPU box costs us electricity, not a provider fee.
const COST_VIDEO_LOCAL = Number(Deno.env.get("M3IX_COST_VIDEO_LOCAL") ?? 20);

/* ---------------------------------------------------------------------------
   THE WALLET.

   Every provider call is written down with what it cost US, in dollars, so
   the wallet panel can show credits sold against provider spend without
   anyone reading a fal invoice. Prices are list prices at the time of
   writing (Sept 2026) and are env-overridable; they only need to be roughly
   right — the panel is a dashboard, not the accounts.
   --------------------------------------------------------------------------- */
const USD = {
  imageSchnell: Number(Deno.env.get("M3IX_USD_IMAGE_SCHNELL") ?? 0.003),
  imageDev: Number(Deno.env.get("M3IX_USD_IMAGE_DEV") ?? 0.025),
  imageNB: Number(Deno.env.get("M3IX_USD_IMAGE_NB") ?? 0.08),
  videoPerSec: Number(Deno.env.get("M3IX_USD_VIDEO_PER_SEC") ?? 0.07),   // Kling 2.5 Turbo Pro
  asset: Number(Deno.env.get("M3IX_USD_ASSET") ?? 0.30),                  // Hunyuan3D v3
  refine: Number(Deno.env.get("M3IX_USD_REFINE") ?? 0.004),               // ~1.5k tokens of Sonnet
  world: Number(Deno.env.get("M3IX_USD_WORLD") ?? 1.00),                  // Marble 1.1
  worldDraft: Number(Deno.env.get("M3IX_USD_WORLD_DRAFT") ?? 0.30),
};
function usdImage(ep: string): number {
  if (ep.includes("nano-banana")) return USD.imageNB;
  if (ep.includes("schnell")) return USD.imageSchnell;
  return USD.imageDev;
}
async function recordSpend(uid: string | null, kind: string, model: string, credits: number, cost_usd: number, ok = true, provider = "fal"): Promise<void> {
  try {
    await fetch(`${BASE()}/rest/v1/m3ix_provider_spend`, {
      method: "POST",
      headers: { ...svcHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, kind, model, provider, credits, cost_usd, ok }),
    });
  } catch { /* the dashboard is best effort; the generation is not */ }
}

/* ---------------------------------------------------------------------------
   VIDEO SHAPE AND LENGTH.

   Kling 2.5 turbo accepts a 5s or a 10s clip and one of three frame shapes.
   Both were hard-coded — the UI could not ask for a vertical clip, so every
   video came back 1920x1080 and had to be cropped to 608 wide for a story,
   throwing away two thirds of every frame. These clamp rather than validate:
   an unknown value falls back to the old default instead of failing a
   generation the user has already been charged for.
   --------------------------------------------------------------------------- */
const VIDEO_DURATIONS = ["5", "10"] as const;
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"] as const;

function clampDuration(v: unknown): string {
  const s = String(v ?? "5");
  return (VIDEO_DURATIONS as readonly string[]).includes(s) ? s : "5";
}
function clampAspect(v: unknown): string {
  const s = String(v ?? "16:9");
  return (VIDEO_ASPECTS as readonly string[]).includes(s) ? s : "16:9";
}
/** The provider bills by the second, so we do too. */
function videoCost(duration: string): number {
  return duration === "10" ? COST_VIDEO * 2 : COST_VIDEO;
}

/* Who may approve a video for the public Library. Comma-separated emails in
   M3IX_ADMINS; falls back to the founder address so the queue is never
   unreviewable because a secret was missed. */
function adminEmails(): string[] {
  return (Deno.env.get("M3IX_ADMINS") ?? "admin@m3xi.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function falKey(): string {
  const k = Deno.env.get("FAL_KEY");
  if (!k) throw new Error("FAL_KEY secret is not set. Add it once: Supabase dashboard → Edge Functions → Secrets → FAL_KEY.");
  return k;
}
function wlHeaders() {
  const k = Deno.env.get("WORLDLABS_KEY");
  if (!k) throw new Error("WORLDLABS_KEY secret is not set. Get an API key at platform.worldlabs.ai, then add it: Supabase dashboard → Edge Functions → Secrets → WORLDLABS_KEY.");
  return { "WLT-Api-Key": k, "Content-Type": "application/json" };
}

function svcHeaders() {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };
}
const BASE = () => Deno.env.get("SUPABASE_URL") ?? "";
/* ---------------------------------------------------------------------------
   WHO IS ASKING, AND CAN THEY PAY.

   Generation used to fall back to a free daily allowance whenever no credit
   code was sent — 60 images, 8 videos, 3 assets and 2 worlds a day — and the
   site calls this function with the PUBLIC anon key, which is a valid JWT. So
   anyone could generate for free, indefinitely, without an account. That is the
   leak.

   Now: every generating action requires a signed-in user and a real balance.
   The charge happens through m3ix_spend, called with the USER's token rather
   than the service key, because that function reads auth.uid() to decide whose
   ledger to touch and to enforce the hourly and weekly caps. Calling it as the
   service role would have no user and would refuse.

   Refunds go the other way: a provider failing is not the customer's fault, so
   the credits go back through the service role, which is the only identity
   allowed to write to the ledger.
   --------------------------------------------------------------------------- */
const UUIDRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

/** The signed-in user, or null. The anon key is not a user. */
async function callerId(req: Request): Promise<string | null> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const token = bearer(req);
  if (!token || !BASE() || token === anon) return null;
  try {
    const r = await fetch(`${BASE()}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anon },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return UUIDRE.test(String(u?.id ?? "")) ? String(u.id) : null;
  } catch { return null; }
}

/** The signed-in user's id AND email — moderation needs to know who is asking. */
async function callerUser(req: Request): Promise<{ id: string; email: string } | null> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const token = bearer(req);
  if (!token || !BASE() || token === anon) return null;
  try {
    const r = await fetch(`${BASE()}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anon } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!UUIDRE.test(String(u?.id ?? ""))) return null;
    return { id: String(u.id), email: String(u?.email ?? "").toLowerCase() };
  } catch { return null; }
}

type Charge = { ok: true; balance: number } | { ok: false; status: number; error: string };

/** Charge the signed-in account. Enforces balance and both usage caps in one go. */
async function charge(req: Request, amount: number, reason: string, ref?: string): Promise<Charge> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const token = bearer(req);
  try {
    const r = await fetch(`${BASE()}/rest/v1/rpc/m3ix_spend`, {
      method: "POST",
      headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason, p_ref: ref ?? null }),
    });
    if (!r.ok) return { ok: false, status: 500, error: "Could not check your credit balance. Try again in a moment." };
    const j = await r.json();
    if (j?.ok === true) return { ok: true, balance: Number(j.balance ?? 0) };
    const code = String(j?.code ?? "");
    if (code === "insufficient")
      return { ok: false, status: 402, error: `Not enough credits — this costs ${amount}, and you have ${Number(j.balance ?? 0)}. Top up from Buy credits.` };
    if (code === "hour_cap")
      return { ok: false, status: 429, error: `You have hit your hourly limit (${j.used} of ${j.cap} credits). It frees up as the hour rolls on.` };
    if (code === "week_cap")
      return { ok: false, status: 429, error: `You have hit your weekly limit (${j.used} of ${j.cap} credits).` };
    if (code === "signed_out")
      return { ok: false, status: 401, error: "Sign in to generate." };
    return { ok: false, status: 402, error: "That could not be charged to your account." };
  } catch {
    return { ok: false, status: 500, error: "Could not reach the credit ledger." };
  }
}

/** Give it back when the provider fails — service role, the only ledger writer. */
async function refundUser(uid: string | null, amount: number, ref: string): Promise<void> {
  if (!uid || !(amount > 0)) return;
  try {
    await fetch(`${BASE()}/rest/v1/m3ix_credit_ledger`, {
      method: "POST",
      headers: { ...svcHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, delta: amount, reason: "refund", ref }),
    });
  } catch { /* best effort */ }
}

const SIGNUP_REQUIRED = {
  error: "Create a free account to generate — it takes one tap with Google, and it keeps everything you make in your own library.",
  code: "signup_required",
};

function randId(n: number): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += a[x % a.length];
  return s;
}
function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return (s || "world") + "-" + randId(4);
}

async function storeChunks(pathBase: string, bytes: Uint8Array): Promise<string[]> {
  const urls: string[] = [];
  const n = Math.max(1, Math.ceil(bytes.length / PART_LIMIT));
  for (let i = 0; i < n; i++) {
    const part = bytes.subarray(i * PART_LIMIT, Math.min(bytes.length, (i + 1) * PART_LIMIT));
    const path = n === 1 ? pathBase : `${pathBase}.part${i}`;
    const up = await fetch(`${BASE()}/storage/v1/object/worlds/${path}`, {
      method: "POST",
      headers: { ...svcHeaders(), "Content-Type": "application/octet-stream" },
      body: part,
    });
    if (!up.ok) throw new Error(`store part ${i + 1}/${n} failed (${up.status})`);
    urls.push(`${BASE()}/storage/v1/object/public/worlds/${path}`);
  }
  return urls;
}

async function logJob(kind: string, modelId: string, input: unknown, status: string, assets: unknown) {
  try {
    const url = BASE();
    if (!url) return;
    await fetch(`${url}/rest/v1/m3ix_gen_jobs`, {
      method: "POST",
      headers: { ...svcHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ kind, model_id: modelId, input, status, assets }),
    });
  } catch (_) { /* best-effort */ }
}

/* Put a job on our own render queue. Charges the local price, never a
   provider price. When no worker has checked in recently the job still
   queues — with the cloud provider off, waiting is the honest answer. */
async function queueLocal(req: Request, uid: string, kind: "image" | "video", body: Record<string, unknown>): Promise<Response> {
  const prompt = String(body.prompt ?? "").trim().slice(0, 1200);
  if (!prompt) return json({ error: "Missing prompt" }, 400);
  const dur = clampDuration(body.duration);
  const cost = kind === "video" ? (dur === "10" ? COST_VIDEO_LOCAL * 2 : COST_VIDEO_LOCAL) : COST_IMAGE;
  const ch = await charge(req, cost, kind, "local");
  if (!ch.ok) return json({ error: ch.error }, ch.status);
  const ref = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
  const multi = Array.isArray(body.image_urls) ? (body.image_urls as string[]).filter((u) => typeof u === "string" && u).slice(0, 6) : [];
  const input = { prompt, image_url: ref ?? multi[0] ?? null, image_urls: multi, duration: Number(dur), aspect: clampAspect(body.aspect), portrait: body.portrait === true };
  const ins = await fetch(`${BASE()}/rest/v1/m3ix_jobs`, {
    method: "POST", headers: { ...svcHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ user_id: uid, kind, input, credits: cost }),
  });
  if (!ins.ok) { await refundUser(uid, cost, "job_submit"); return json({ error: "Could not queue the job" }, 500); }
  const row = (await ins.json())?.[0];
  const online = await (await fetch(`${BASE()}/rest/v1/m3ix_workers?select=name&kinds=cs.{${kind}}&last_seen=gte.${encodeURIComponent(new Date(Date.now() - 5 * 60_000).toISOString())}&limit=1`, { headers: svcHeaders() })).json();
  const waiting = !(Array.isArray(online) && online.length);
  await recordSpend(uid, kind, "local/wan-2.2", cost, 0, true, "local");
  return json({
    job_id: row?.id, queued: true, local: true, charged: cost, credits_remaining: ch.balance,
    message: waiting ? "Queued on the M3XI render box. It is offline right now, so this will render when it comes back on — check the Library later." : "Rendering on the M3XI render box.",
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action ?? "");
  const code = typeof body.code === "string" && body.code.trim() ? body.code.trim().toUpperCase() : null;

  try {
    if (action === "balance") {
      if (!code) return json({ error: "No code supplied" }, 400);
      const rows = await (await fetch(`${BASE()}/rest/v1/m3ix_credit_codes?code=eq.${encodeURIComponent(code)}&select=credits_total,credits_used`, { headers: svcHeaders() })).json();
      if (!Array.isArray(rows) || !rows[0]) return json({ error: "Code not found" }, 404);
      return json({ total: rows[0].credits_total, used: rows[0].credits_used, remaining: rows[0].credits_total - rows[0].credits_used });
    }

    if (action === "fetch_asset") {
      const url = String(body.url ?? "");
      const ok = ["https://fal.media/", "https://v2.fal.media/", "https://v3.fal.media/", "https://v3b.fal.media/"].some((p) => url.startsWith(p));
      if (!ok) return json({ error: "url must be a fal.media asset" }, 400);
      const r = await fetch(url);
      if (!r.ok) return json({ error: `asset ${r.status}` }, 502);
      const ct = r.headers.get("content-type") ?? "image/jpeg";
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > 8_000_000) return json({ error: "asset too large for inline preview" }, 413);
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
      return json({ dataUri: `data:${ct};base64,${btoa(bin)}` });
    }

    /* ---------- read a listing page for the world builder ----------
       The browser cannot fetch another site (CORS); this can. Returns the
       page's photos (og:image + the big UK portals' CDN patterns) and its
       stripped text, so the client can distill a spatial build brief. Free:
       it spends nothing but a fetch. */
    if (action === "fetch_page") {
      const url = String(body.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return json({ error: "Give a full http(s) link." }, 400);
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      let pr: Response;
      try {
        pr = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
          },
          redirect: "follow",
        });
      } catch (_e) { return json({ error: "That page would not load." }, 502); }
      if (!pr.ok) return json({ error: `That page would not load (HTTP ${pr.status}).` }, 502);
      const html = (await pr.text()).slice(0, 500_000);
      const og = [...html.matchAll(/<meta[^>]+(?:property|name)=["']og:image[^"']*["'][^>]+content=["']([^"']+)["']/gi)].map((m) => m[1]);
      const rm = [...html.matchAll(/https:\/\/media\.rightmove\.co\.uk\/[^"'\s\\]+\.jpe?g/gi)].map((m) => m[0]);
      const zp = [...html.matchAll(/https:\/\/lc\.zoocdn\.com\/[^"'\s\\]+\.jpe?g/gi)].map((m) => m[0]);
      const images = [...new Set([...og, ...rm, ...zp])].slice(0, 8);
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").slice(0, 6000);
      return json({ images, text });
    }

    /* ---------- Marble world generation (World Labs World API) ---------- */
    if (action === "world_submit") {
      const model = String(body.model ?? "marble-1.1");
      if (!/^marble-1\.[01](-draft|-plus)?$/.test(model)) return json({ error: "Unknown Marble model — use marble-1.0-draft, marble-1.0, marble-1.1 or marble-1.1-plus" }, 400);
      let prompt = String(body.prompt ?? "").trim();
      // The scene director. Marble renders what the prompt asks for and stops
      // there; a game map needs asking for EVERYTHING. Appended to every
      // world prompt so completeness is the default, not prompt-craft.
      if (prompt && body.raw !== true) {
        prompt = prompt.slice(0, 1200) +
          " — a complete, coherent world in every direction: continuous ground with no missing patches or holes, " +
          "every building closed on all sides, consistent art direction and lighting throughout, " +
          "detail held from near to far, nothing floating or half-formed, game-environment completeness.";
      }
      const imgs = Array.isArray(body.image_urls) ? (body.image_urls as string[]).filter((u) => typeof u === "string" && u).slice(0, 4) : [];
      if (!prompt && !imgs.length) return json({ error: "Give the world a text prompt, photo attachments, or both." }, 400);
      const isDraft = model.includes("draft");
      const cost = isDraft ? COST_WORLD_DRAFT : COST_WORLD;
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      const ch = await charge(req, cost, "world");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      const toContent = (u: string) => u.startsWith("data:")
        ? { source: "data_base64", data_base64: u.slice(u.indexOf(",") + 1), mime_type: (u.match(/^data:([^;]+)/) || [])[1] || "image/jpeg" }
        : { source: "uri", uri: u };
      let world_prompt: Record<string, unknown>;
      if (!imgs.length) {
        world_prompt = { type: "text", text_prompt: prompt };
      } else if (imgs.length === 1) {
        world_prompt = { type: "image", image_prompt: toContent(imgs[0]), ...(prompt ? { text_prompt: prompt } : {}) };
      } else {
        const step = 360 / imgs.length;
        world_prompt = {
          type: "multi-image",
          multi_image_prompt: imgs.map((u, i) => ({ azimuth: Math.round(i * step), content: toContent(u) })),
          ...(prompt ? { text_prompt: prompt } : {}),
        };
      }
      const payload = { display_name: (prompt || "M3XI world").slice(0, 60), model, world_prompt };
      const r = await fetch(`${WL}/worlds:generate`, { method: "POST", headers: wlHeaders(), body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, cost, action); return json({ error: `worldlabs ${r.status}: ${text.slice(0, 300)}` }, 502); }
      const j = JSON.parse(text);
      await recordSpend(uid, "world", model, cost, isDraft ? USD.worldDraft : USD.world, true, "worldlabs");
      await logJob("world", model, { prompt: prompt.slice(0, 300), imgs: imgs.length }, "queued", { operation_id: j?.operation_id });
      return json({ operation_id: j?.operation_id, done: j?.done ?? false, credits_remaining: remaining ?? undefined });
    }

    if (action === "world_status") {
      const op = String(body.operation_id ?? "");
      if (!op) return json({ error: "Missing operation_id" }, 400);
      const r = await fetch(`${WL}/operations/${encodeURIComponent(op)}`, { headers: wlHeaders() });
      const text = await r.text();
      if (!r.ok) return json({ error: `worldlabs ${r.status}: ${text.slice(0, 300)}` }, 502);
      return new Response(text, { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (action === "world_import") {
      // Importing is free — the world was already paid for at submit — but it
      // still needs an owner, otherwise the maker's own library stays empty and
      // the Library cannot credit anyone for it.
      const importer = await callerId(req);
      if (!importer) return json(SIGNUP_REQUIRED, 401);
      const op = String(body.operation_id ?? "");
      if (!op) return json({ error: "Missing operation_id" }, 400);
      const r = await fetch(`${WL}/operations/${encodeURIComponent(op)}`, { headers: wlHeaders() });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return json({ error: `worldlabs ${r.status}` }, 502);
      if (!j.done) return json({ error: "World is still generating — try again in a moment." }, 409);
      if (j.error) return json({ error: "Generation failed: " + JSON.stringify(j.error).slice(0, 200) }, 502);
      const w = (j.response ?? {}) as Record<string, any>;
      const assets = (w.assets ?? {}) as Record<string, any>;
      const spzUrls = assets?.splats?.spz_urls ?? {};
      const spz = spzUrls.default ?? (Object.values(spzUrls)[0] as string | undefined);
      if (!spz) return json({ error: "No splat asset on this world (it may still be processing exports)" }, 502);
      const name = String(body.name ?? w.display_name ?? "Generated world").slice(0, 60);
      const slug = slugify(name);
      const edit_key = "wk_" + randId(20);
      const dl = await fetch(spz as string);
      if (!dl.ok) return json({ error: `Could not download the world asset (${dl.status})` }, 502);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      const urls = await storeChunks(`${slug}/world.spz`, bytes);
      const envObj: Record<string, unknown> = { type: "splat", src: urls[0] };
      if (urls.length > 1) { envObj.parts = urls; envObj.file = "world.spz"; }
      let cover: string | undefined;
      try {
        const t = assets?.thumbnail_url;
        if (t) {
          const tr = await fetch(t);
          if (tr.ok) {
            const tb = new Uint8Array(await tr.arrayBuffer());
            const tp = `${slug}/cover.jpg`;
            const tu = await fetch(`${BASE()}/storage/v1/object/worlds/${tp}`, { method: "POST", headers: { ...svcHeaders(), "Content-Type": "image/jpeg" }, body: tb });
            if (tu.ok) cover = `${BASE()}/storage/v1/object/public/worlds/${tp}`;
          }
        }
      } catch (_) { /* cover optional */ }
      const doc = {
        id: slug, name, published: true, unit: "m",
        environment: envObj,
        eye: 1.6, speed: 1.45, hotspots: [], assets: [],
        creator: { name: String(body.creator_name ?? "M3XI Studio").slice(0, 60), url: String(body.creator_url ?? "").slice(0, 200) },
        cover, marble_url: w.world_marble_url, generator: "marble",
        // SPZ arrives Y-down by convention; every import so far needed this
        // exact flip. Baked here so no fresh world can land upside down —
        // the viewer's Calibrate panel still overrides it per world.
        fix: { up: { axis: "y", sign: -1 } },
        // The prompt rides with the world so Refine can start from it later.
        prompt: String(body.prompt ?? "").slice(0, 1500),
        saved_at: new Date().toISOString(),
      };
      const ins = await fetch(`${BASE()}/rest/v1/m3ix_spaces`, {
        method: "POST",
        headers: { ...svcHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ title: name, kind: "other", status: "published", source: "marble", embed_slug: slug, edit_key, world: doc, owner_id: importer }),
      });
      if (!ins.ok) return json({ error: "Could not save the imported world" }, 500);
      await logJob("world", "import", { op }, "done", { slug, spz_mb: Math.round(bytes.length / 1048576), parts: urls.length });
      return json({ slug, edit_key, name, cover, marble_url: w.world_marble_url, size_mb: Math.round(bytes.length / 1048576) });
    }

    // fal's key is only read when the provider is switched on; with it off the
    // function must keep working without the secret existing at all.
    const auth = { Authorization: `Key ${PROVIDER_ON ? falKey() : "off"}`, "Content-Type": "application/json" };

    if (action === "refine") {
      // Refine takes the user's words as written. The world "scene director"
      // paragraph that used to be appended here belongs to world_submit only.
      const prompt = String(body.prompt ?? "").trim().slice(0, 4000);
      if (!prompt) return json({ error: "Missing prompt" }, 400);
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      const ch = await charge(req, COST_REFINE, "refine");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      const system = String(body.system ?? "You are a film director's assistant. Refine the user's idea into vivid, concrete visual prompts.");
      const groq = Deno.env.get("GROQ_API_KEY");
      if (groq) {
        // Free tier. One request, no bill.
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST", headers: { Authorization: `Bearer ${groq}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.7, max_tokens: 1200 }),
        });
        const text = await r.text();
        if (!r.ok) { await refundUser(uid, COST_REFINE, action); return json({ error: `groq ${r.status}: ${text.slice(0, 240)}` }, 502); }
        const out = JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
        if (!out) { await refundUser(uid, COST_REFINE, action); return json({ error: "No output from the language model" }, 502); }
        await recordSpend(uid, "refine", GROQ_MODEL, COST_REFINE, 0, true, "groq");
        return json({ output: out, credits_remaining: remaining ?? undefined });
      }
      if (!PROVIDER_ON) { await refundUser(uid, COST_REFINE, action); return json({ error: "No language model is configured. Add a free GROQ_API_KEY secret (console.groq.com) — it costs nothing." }, 503); }
      const model = String(body.llm ?? LLM_MODEL);
      const r = await fetch(`https://fal.run/${DEFAULTS.llm}`, { method: "POST", headers: auth, body: JSON.stringify({ model, system_prompt: system, prompt }) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, COST_REFINE, action); await recordSpend(uid, "refine", model, 0, 0, false); return json({ error: `fal ${r.status}: ${text.slice(0, 240)}` }, 502); }
      const j = JSON.parse(text);
      const out = j?.output ?? j?.text ?? "";
      if (!out) { await refundUser(uid, COST_REFINE, action); return json({ error: "No output from the language model" }, 502); }
      await recordSpend(uid, "refine", model, COST_REFINE, USD.refine);
      return json({ output: out, credits_remaining: remaining ?? undefined });
    }

    if (action === "image") {
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      if (!PROVIDER_ON) {
        // Same request, routed to our own render box. It waits in the queue if
        // the box is off; nothing is billed to us either way.
        return await queueLocal(req, uid, "image", body);
      }
      /* NOTE: this used to append the world "scene director" paragraph to
         every image prompt — copied from world_submit by mistake, the same
         bug video_submit had. Image prompts now go through untouched. */
      const prompt = String(body.prompt ?? "").trim().slice(0, 1500);
      if (!prompt) return json({ error: "Missing prompt" }, 400);
      const multi = Array.isArray(body.image_urls) ? (body.image_urls as string[]).filter((u) => typeof u === "string" && u).slice(0, 6) : null;
      const ref = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
      const wantNB = body.quality === "nb" || body.quality === "keyframe";
      const ep = String(body.endpoint ?? (
        wantNB ? (multi && multi.length ? DEFAULTS.imgNBEdit : ref ? DEFAULTS.imgNBEdit : DEFAULTS.imgNB)
               : (multi && multi.length ? "fal-ai/nano-banana/edit" : ref ? DEFAULTS.imgI2I : DEFAULTS.imgT2I)));
      if (!ep.startsWith("fal-ai/")) return json({ error: "Endpoint must start with fal-ai/" }, 400);
      // Charge by what the frame costs us, after we know which model it is.
      const cost = ep.includes("nano-banana") ? COST_IMAGE_NB : COST_IMAGE;
      const ch = await charge(req, cost, "image");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      const nbEdit = ep.includes("nano-banana");
      const payload = multi && multi.length
        ? { prompt, image_urls: multi, num_images: 1 }
        : ref
        ? (nbEdit ? { prompt, image_urls: [ref], num_images: 1 } : { prompt, image_url: ref, strength: typeof body.strength === "number" ? body.strength : 0.82 })
        : nbEdit
        ? { prompt, aspect_ratio: body.portrait === true ? "9:16" : "16:9", num_images: 1 }
        : { prompt, image_size: body.portrait === true ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }, num_images: 1 };
      const r = await fetch(`https://fal.run/${ep}`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, cost, action); await recordSpend(uid, "image", ep, 0, 0, false); return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502); }
      const j = JSON.parse(text);
      const url = j?.images?.[0]?.url ?? j?.image?.url;
      if (!url) { await refundUser(uid, cost, action); return json({ error: "No image in provider response" }, 502); }
      await recordSpend(uid, "image", ep, cost, usdImage(ep));
      await logJob("image", ep, { prompt: prompt.slice(0, 500), ref: !!ref || !!(multi && multi.length) }, "done", { url });
      return json({ url, charged: cost, credits_remaining: remaining ?? undefined });
    }

    if (action === "asset_submit") {
      const img = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
      if (!img) return json({ error: "3D assets are built from an image — attach one or generate one first." }, 400);
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      if (!PROVIDER_ON) return json({ error: "3D assets need cloud rendering, which is switched off to keep costs at zero." , code: "provider_off" }, 503);
      const ch = await charge(req, COST_ASSET, "asset");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      let ep = String(body.endpoint ?? DEFAULTS.asset);
      if (!ep.startsWith("fal-ai/")) { await refundUser(uid, COST_ASSET, action); return json({ error: "Endpoint must start with fal-ai/" }, 400); }
      const payload = { input_image_url: img, enable_pbr: true };
      const r = await fetch(`https://queue.fal.run/${ep}`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, COST_ASSET, action); return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502); }
      const j = JSON.parse(text);
      await recordSpend(uid, "asset", ep, COST_ASSET, USD.asset);
      await logJob("asset", ep, { ref: true }, "queued", { request_id: j?.request_id });
      return json({ request_id: j?.request_id, status_url: j?.status_url, response_url: j?.response_url, credits_remaining: remaining ?? undefined });
    }

    if (action === "video_submit") {
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      if (!PROVIDER_ON) {
        // Same request, routed to our own render box. It waits in the queue if
        // the box is off; nothing is billed to us either way.
        return await queueLocal(req, uid, "video", body);
      }

      /* Length is a real choice now, not a hard-coded 5. Kling bills by the
         second, so the charge has to follow it — a 10s clip that cost the same
         as a 5s one would be a straight loss on every long generation. */
      const dur = clampDuration(body.duration);
      const cost = videoCost(dur);
      const ch = await charge(req, cost, "video");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;

      /* NOTE: this used to append the world "scene director" paragraph — the
         one about continuous ground and buildings closed on all sides — to
         every VIDEO prompt. It belongs to world_submit and was copied here by
         mistake, so every clip generated in the Studio was quietly asking for
         game-environment completeness. Video prompts now go through untouched. */
      const prompt = String(body.prompt ?? "").trim().slice(0, 1200);
      if (!prompt) { await refundUser(uid, cost, action); return json({ error: "Missing prompt" }, 400); }

      const ref = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
      let ep = String(body.endpoint ?? (ref ? DEFAULTS.vidI2V : DEFAULTS.vidT2V));
      if (!ep.startsWith("fal-ai/")) { await refundUser(uid, cost, action); return json({ error: "Endpoint must start with fal-ai/" }, 400); }

      /* image-to-video takes its frame shape from the reference image, so
         aspect_ratio is only meaningful on the text path — sending it with an
         image_url is at best ignored and at worst a 422. */
      const payload: Record<string, unknown> = ref
        ? { prompt, image_url: ref, duration: dur }
        : { prompt, duration: dur, aspect_ratio: clampAspect(body.aspect) };
      const r = await fetch(`https://queue.fal.run/${ep}`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, cost, action); return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502); }
      const j = JSON.parse(text);
      await recordSpend(uid, "video", ep, cost, USD.videoPerSec * Number(dur));
      await logJob("video", ep, { prompt: prompt.slice(0, 500), ref: !!ref, duration: dur, aspect: payload.aspect_ratio ?? "from image" }, "queued", { request_id: j?.request_id });
      return json({ request_id: j?.request_id, status_url: j?.status_url, response_url: j?.response_url, charged: cost, duration: dur, credits_remaining: remaining ?? undefined });
    }

    /* =======================================================================
       THE LOCAL WORKER.

       A GPU box of ours (worker/ in the repo) polls m3ix_jobs and renders
       with open models — Wan 2.2 5B today. It costs electricity, not a
       provider fee, so the credit price is lower. The option only appears
       when a worker has checked in within the last few minutes; otherwise
       the Studio falls back to the provider path above.
       ======================================================================= */
    if (action === "workers") {
      const rows = await (await fetch(`${BASE()}/rest/v1/m3ix_workers?select=name,gpu,kinds,last_seen&last_seen=gte.${encodeURIComponent(new Date(Date.now() - 5 * 60_000).toISOString())}`, { headers: svcHeaders() })).json();
      return json({ online: Array.isArray(rows) ? rows : [], cost_video: COST_VIDEO_LOCAL });
    }

    if (action === "job_submit") {
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      return await queueLocal(req, uid, body.kind === "image" ? "image" : "video", body);
    }

    if (action === "job_status") {
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      const id = String(body.job_id ?? "");
      if (!UUIDRE.test(id)) return json({ error: "Bad job id" }, 400);
      const rows = await (await fetch(`${BASE()}/rest/v1/m3ix_jobs?id=eq.${id}&user_id=eq.${uid}&select=status,output,error,claimed_at,finished_at`, { headers: svcHeaders() })).json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return json({ error: "No such job" }, 404);
      // A failed job is refunded by the worker itself (service role), once.
      return json(row);
    }

    if (action === "video_status" || action === "video_result") {
      const url = String(body.url ?? "");
      if (!url.startsWith("https://queue.fal.run/")) return json({ error: "url must be a queue.fal.run URL" }, 400);
      const r = await fetch(url, { headers: auth });
      const text = await r.text();
      if (!r.ok) return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502);
      return new Response(text, { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    /* =======================================================================
       THE VIDEO LIBRARY.

       A finished video is worth nothing sitting in a browser tab. These four
       actions are the shop window: publish puts a video in the queue, list
       serves the approved ones to everybody, queue and moderate are the
       founder's desk.

       Everything writes with the service role on purpose. The table has no
       client INSERT or UPDATE grant, so 'approved' cannot be set by the person
       who made the video — only by someone on the admin list.
       ======================================================================= */
    if (action === "video_publish") {
      const me = await callerUser(req);
      if (!me) return json(SIGNUP_REQUIRED, 401);
      const url = String(body.video_url ?? "").trim();
      if (!/^https:\/\//.test(url)) return json({ error: "A published video needs its https URL." }, 400);
      const row = {
        owner: me.id,
        title: String(body.title ?? "Untitled").trim().slice(0, 120) || "Untitled",
        prompt: String(body.prompt ?? "").slice(0, 1000) || null,
        video_url: url,
        poster_url: typeof body.poster_url === "string" && /^https:\/\//.test(body.poster_url) ? body.poster_url : null,
        duration_secs: Number.isFinite(Number(body.duration_secs)) ? Number(body.duration_secs) : null,
        width: Number.isFinite(Number(body.width)) ? Math.round(Number(body.width)) : null,
        height: Number.isFinite(Number(body.height)) ? Math.round(Number(body.height)) : null,
        aspect: typeof body.aspect === "string" ? body.aspect.slice(0, 12) : null,
        source: body.source === "editor" ? "editor" : "studio",
        maker_name: typeof body.maker_name === "string" ? body.maker_name.slice(0, 80) : null,
        maker_link: typeof body.maker_link === "string" && /^https?:\/\//.test(body.maker_link) ? body.maker_link.slice(0, 300) : null,
        status: "pending",
      };
      const r = await fetch(`${BASE()}/rest/v1/m3ix_videos`, {
        method: "POST",
        headers: { ...svcHeaders(), Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      const text = await r.text();
      if (!r.ok) return json({ error: `Could not publish: ${text.slice(0, 200)}` }, 502);
      const saved = JSON.parse(text)?.[0] ?? null;
      return json({
        id: saved?.id ?? null,
        status: "pending",
        message: "Sent to the Library — it goes live once it has been checked.",
      });
    }

    if (action === "video_list") {
      const limit = Math.min(Math.max(Number(body.limit ?? 24), 1), 60);
      const cols = "id,title,prompt,video_url,poster_url,duration_secs,width,height,aspect,source,maker_name,maker_link,views,created_at";
      const r = await fetch(
        `${BASE()}/rest/v1/m3ix_videos?select=${cols}&status=eq.approved&order=created_at.desc&limit=${limit}`,
        { headers: svcHeaders() },
      );
      if (!r.ok) return json({ videos: [] });
      return json({ videos: await r.json() });
    }

    if (action === "video_mine") {
      const me = await callerUser(req);
      if (!me) return json(SIGNUP_REQUIRED, 401);
      const cols = "id,title,video_url,poster_url,status,source,created_at,review_note";
      const r = await fetch(
        `${BASE()}/rest/v1/m3ix_videos?select=${cols}&owner=eq.${me.id}&order=created_at.desc&limit=60`,
        { headers: svcHeaders() },
      );
      if (!r.ok) return json({ videos: [] });
      return json({ videos: await r.json() });
    }

    if (action === "video_queue" || action === "video_moderate") {
      const me = await callerUser(req);
      if (!me) return json(SIGNUP_REQUIRED, 401);
      if (!adminEmails().includes(me.email)) return json({ error: "Not your queue." }, 403);

      if (action === "video_queue") {
        const cols = "id,title,prompt,video_url,poster_url,duration_secs,aspect,source,owner,created_at";
        const want = String(body.status ?? "pending");
        const st = ["pending", "approved", "rejected", "hidden"].includes(want) ? want : "pending";
        const r = await fetch(
          `${BASE()}/rest/v1/m3ix_videos?select=${cols}&status=eq.${st}&order=created_at.asc&limit=100`,
          { headers: svcHeaders() },
        );
        if (!r.ok) return json({ videos: [] });
        return json({ videos: await r.json() });
      }

      const id = String(body.id ?? "");
      if (!UUIDRE.test(id)) return json({ error: "Which video?" }, 400);
      const want = String(body.status ?? "");
      if (!["approved", "rejected", "hidden", "pending"].includes(want)) return json({ error: "status must be approved, rejected, hidden or pending." }, 400);
      const r = await fetch(`${BASE()}/rest/v1/m3ix_videos?id=eq.${id}`, {
        method: "PATCH",
        headers: { ...svcHeaders(), Prefer: "return=representation" },
        body: JSON.stringify({
          status: want,
          reviewed_at: new Date().toISOString(),
          reviewed_by: me.id,
          review_note: typeof body.note === "string" ? body.note.slice(0, 400) : null,
        }),
      });
      const text = await r.text();
      if (!r.ok) return json({ error: `Could not update: ${text.slice(0, 200)}` }, 502);
      return json({ ok: true, status: want });
    }

    return json({ error: "Unknown action. Use image | video_submit | video_status | video_result | workers | job_submit | job_status | video_publish | video_list | video_mine | video_queue | video_moderate | asset_submit | refine | world_submit | world_status | world_import | fetch_asset | balance" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
