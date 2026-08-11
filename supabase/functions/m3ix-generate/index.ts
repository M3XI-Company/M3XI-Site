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
};
const WL = "https://api.worldlabs.ai/marble/v1";
const PART_LIMIT = 45 * 1024 * 1024;

const COST_IMAGE = Number(Deno.env.get("M3IX_COST_IMAGE") ?? 1);
const COST_VIDEO = Number(Deno.env.get("M3IX_COST_VIDEO") ?? 60);
const COST_ASSET = Number(Deno.env.get("M3IX_COST_ASSET") ?? 15);
const COST_REFINE = Number(Deno.env.get("M3IX_COST_REFINE") ?? 2);
const COST_WORLD = Number(Deno.env.get("M3IX_COST_WORLD") ?? 150);
const COST_WORLD_DRAFT = Number(Deno.env.get("M3IX_COST_WORLD_DRAFT") ?? 40);

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

async function spend(code: string, cost: number): Promise<number> {
  const r = await fetch(`${BASE()}/rest/v1/rpc/m3ix_spend`, {
    method: "POST", headers: svcHeaders(), body: JSON.stringify({ p_code: code, p_cost: cost }),
  });
  if (!r.ok) return -1;
  return Number(await r.json());
}
async function refund(code: string, cost: number): Promise<void> {
  await fetch(`${BASE()}/rest/v1/rpc/m3ix_refund`, {
    method: "POST", headers: svcHeaders(), body: JSON.stringify({ p_code: code, p_cost: cost }),
  }).catch(() => {});
}

async function countToday(kind: string, extra = ""): Promise<number> {
  try {
    const base = BASE();
    if (!base) return 0;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const r = await fetch(
      `${base}/rest/v1/m3ix_gen_jobs?select=id&kind=eq.${kind}${extra}&created_at=gte.${today.toISOString()}&limit=1`,
      { headers: { ...svcHeaders(), Prefer: "count=exact" } },
    );
    const range = r.headers.get("content-range") ?? "/0";
    return Number(range.split("/")[1] ?? 0);
  } catch (_) { return 0; }
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

    /* ---------- Marble world generation (World Labs World API) ---------- */
    if (action === "world_submit") {
      const model = String(body.model ?? "marble-1.1");
      if (!/^marble-1\.[01](-draft|-plus)?$/.test(model)) return json({ error: "Unknown Marble model — use marble-1.0-draft, marble-1.0, marble-1.1 or marble-1.1-plus" }, 400);
      const prompt = String(body.prompt ?? "").trim();
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
      await logJob("world", model, { prompt: prompt.slice(0, 300), imgs: imgs.length, code: code ?? undefined }, "queued", { operation_id: j?.operation_id });
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
        eye: 1.6, speed: 2.6, hotspots: [], assets: [],
        creator: { name: String(body.creator_name ?? "M3XI Studio").slice(0, 60), url: String(body.creator_url ?? "").slice(0, 200) },
        cover, marble_url: w.world_marble_url, generator: "marble",
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

    const auth = { Authorization: `Key ${falKey()}`, "Content-Type": "application/json" };

    if (action === "refine") {
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return json({ error: "Missing prompt" }, 400);
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      const ch = await charge(req, COST_REFINE, "refine");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      const system = String(body.system ?? "You are a film director's assistant. Refine the user's idea into vivid, concrete visual prompts.");
      const model = String(body.llm ?? "google/gemini-flash-1.5");
      const r = await fetch(`https://fal.run/${DEFAULTS.llm}`, { method: "POST", headers: auth, body: JSON.stringify({ model, system_prompt: system, prompt }) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, COST_REFINE, action); return json({ error: `fal ${r.status}: ${text.slice(0, 240)}` }, 502); }
      const j = JSON.parse(text);
      const out = j?.output ?? j?.text ?? "";
      if (!out) { await refundUser(uid, COST_REFINE, action); return json({ error: "No output from the language model" }, 502); }
      return json({ output: out, credits_remaining: remaining ?? undefined });
    }

    if (action === "image") {
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      const ch = await charge(req, COST_IMAGE, "image");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) { await refundUser(uid, COST_IMAGE, action); return json({ error: "Missing prompt" }, 400); }
      const multi = Array.isArray(body.image_urls) ? (body.image_urls as string[]).filter((u) => typeof u === "string" && u).slice(0, 6) : null;
      const ref = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
      let ep = String(body.endpoint ?? (multi && multi.length ? "fal-ai/nano-banana/edit" : ref ? DEFAULTS.imgI2I : DEFAULTS.imgT2I));
      if (!ep.startsWith("fal-ai/")) { await refundUser(uid, COST_IMAGE, action); return json({ error: "Endpoint must start with fal-ai/" }, 400); }
      const payload = multi && multi.length
        ? { prompt, image_urls: multi, num_images: 1 }
        : ref
        ? { prompt, image_url: ref, strength: typeof body.strength === "number" ? body.strength : 0.82 }
        : { prompt, image_size: body.portrait === true ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }, num_images: 1 };
      const r = await fetch(`https://fal.run/${ep}`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, COST_IMAGE, action); return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502); }
      const j = JSON.parse(text);
      const url = j?.images?.[0]?.url ?? j?.image?.url;
      if (!url) { await refundUser(uid, COST_IMAGE, action); return json({ error: "No image in provider response" }, 502); }
      await logJob("image", ep, { prompt: prompt.slice(0, 500), ref: !!ref || !!(multi && multi.length), code: code ?? undefined }, "done", { url });
      return json({ url, credits_remaining: remaining ?? undefined });
    }

    if (action === "asset_submit") {
      const img = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
      if (!img) return json({ error: "3D assets are built from an image — attach one or generate one first." }, 400);
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
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
      await logJob("asset", ep, { ref: true, code: code ?? undefined }, "queued", { request_id: j?.request_id });
      return json({ request_id: j?.request_id, status_url: j?.status_url, response_url: j?.response_url, credits_remaining: remaining ?? undefined });
    }

    if (action === "video_submit") {
      const uid = await callerId(req);
      if (!uid) return json(SIGNUP_REQUIRED, 401);
      const ch = await charge(req, COST_VIDEO, "video");
      if (!ch.ok) return json({ error: ch.error }, ch.status);
      const remaining: number = ch.balance;
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) { await refundUser(uid, COST_VIDEO, action); return json({ error: "Missing prompt" }, 400); }
      const ref = typeof body.image_url === "string" && body.image_url ? body.image_url : null;
      let ep = String(body.endpoint ?? (ref ? DEFAULTS.vidI2V : DEFAULTS.vidT2V));
      if (!ep.startsWith("fal-ai/")) { await refundUser(uid, COST_VIDEO, action); return json({ error: "Endpoint must start with fal-ai/" }, 400); }
      const payload = ref ? { prompt, image_url: ref, duration: "5" } : { prompt, duration: "5", aspect_ratio: String(body.aspect ?? "16:9") };
      const r = await fetch(`https://queue.fal.run/${ep}`, { method: "POST", headers: auth, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) { await refundUser(uid, COST_VIDEO, action); return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502); }
      const j = JSON.parse(text);
      await logJob("video", ep, { prompt: prompt.slice(0, 500), ref: !!ref, code: code ?? undefined }, "queued", { request_id: j?.request_id });
      return json({ request_id: j?.request_id, status_url: j?.status_url, response_url: j?.response_url, credits_remaining: remaining ?? undefined });
    }

    if (action === "video_status" || action === "video_result") {
      const url = String(body.url ?? "");
      if (!url.startsWith("https://queue.fal.run/")) return json({ error: "url must be a queue.fal.run URL" }, 400);
      const r = await fetch(url, { headers: auth });
      const text = await r.text();
      if (!r.ok) return json({ error: `fal ${r.status}: ${text.slice(0, 300)}` }, 502);
      return new Response(text, { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return json({ error: "Unknown action. Use image | video_submit | video_status | video_result | asset_submit | refine | world_submit | world_status | world_import | fetch_asset | balance" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
