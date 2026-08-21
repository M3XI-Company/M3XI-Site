import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// M3XI Worlds API — world persistence, publishing, library, leads, events.
// Actions: create | upload_url | save | load | list_published | rehost | unpublish | lead | event
// `source` (marble | twin-viewer) travels with every world that leaves here, so a
// viewer can say whether what it shows was generated or scanned.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function svcHeaders() {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };
}
const BASE = () => Deno.env.get("SUPABASE_URL") ?? "";

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
const SAFE_PATH = /^[a-z0-9][a-z0-9\-_.\/]{0,120}$/;
const PART_LIMIT = 45 * 1024 * 1024; // stay under the storage per-object cap

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
    if (!up.ok) throw new Error(`store part ${i + 1}/${n} failed (${up.status}: ${(await up.text()).slice(0, 100)})`);
    urls.push(`${BASE()}/storage/v1/object/public/worlds/${path}`);
  }
  return urls;
}

async function getRow(slug: string) {
  const r = await fetch(`${BASE()}/rest/v1/m3ix_spaces?embed_slug=eq.${encodeURIComponent(slug)}&select=id,embed_slug,edit_key,status,world,title,source`, { headers: svcHeaders() });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
function logEvent(slug: string, kind: string, meta?: unknown) {
  fetch(`${BASE()}/rest/v1/m3ix_events`, {
    method: "POST",
    headers: { ...svcHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ slug, kind, meta }),
  }).catch(() => {});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action ?? "");

  try {
    if (action === "create") {
      const name = String(body.name ?? "Untitled world").slice(0, 80);
      const slug = slugify(name);
      const edit_key = "wk_" + randId(20);
      const ins = await fetch(`${BASE()}/rest/v1/m3ix_spaces`, {
        method: "POST",
        headers: { ...svcHeaders(), Prefer: "return=representation" },
        body: JSON.stringify({ title: name, kind: "other", status: "draft", source: "twin-viewer", embed_slug: slug, edit_key }),
      });
      const rows = await ins.json().catch(() => null);
      if (!ins.ok) return json({ error: "Could not create world" }, 500);
      return json({ slug, edit_key, id: rows?.[0]?.id });
    }

    if (action === "upload_url") {
      const slug = String(body.slug ?? "");
      const key = String(body.edit_key ?? "");
      const filename = String(body.filename ?? "").toLowerCase().replace(/[^a-z0-9\-_.]+/g, "-").slice(0, 80);
      if (!filename) return json({ error: "Missing filename" }, 400);
      const row = await getRow(slug);
      if (!row || row.edit_key !== key) return json({ error: "Unknown world or wrong edit key" }, 403);
      const path = `${slug}/${Date.now().toString(36)}-${filename}`;
      if (!SAFE_PATH.test(path)) return json({ error: "Bad filename" }, 400);
      const r = await fetch(`${BASE()}/storage/v1/object/upload/sign/worlds/${path}`, { method: "POST", headers: svcHeaders(), body: "{}" });
      const text = await r.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text); } catch { /* keep null */ }
      const rel = j && (j.url as string);
      if (!r.ok || !rel) return json({ error: `Could not sign upload (${r.status}: ${text.slice(0, 160)})` }, 500);
      return json({
        upload_url: `${BASE()}/storage/v1${rel}`,
        public_url: `${BASE()}/storage/v1/object/public/worlds/${path}`,
        path,
      });
    }

    if (action === "save") {
      const slug = String(body.slug ?? "");
      const key = String(body.edit_key ?? "");
      const world = body.world as Record<string, unknown> | undefined;
      if (!world || typeof world !== "object") return json({ error: "Missing world document" }, 400);
      const row = await getRow(slug);
      if (!row || row.edit_key !== key) return json({ error: "Unknown world or wrong edit key" }, 403);
      const published = world.published === true;
      const doc = { ...world, id: slug, unit: "m", saved_at: new Date().toISOString() };
      const upd = await fetch(`${BASE()}/rest/v1/m3ix_spaces?embed_slug=eq.${encodeURIComponent(slug)}`, {
        method: "PATCH",
        headers: { ...svcHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ world: doc, title: String(world.name ?? row.title ?? "World").slice(0, 80), status: published ? "published" : "draft" }),
      });
      if (!upd.ok) return json({ error: "Save failed" }, 500);
      logEvent(slug, "save");
      return json({ ok: true, slug, published });
    }

    if (action === "load") {
      const slug = String(body.slug ?? "");
      const key = String(body.edit_key ?? "");
      const row = await getRow(slug);
      if (!row || !row.world) return json({ error: "World not found" }, 404);
      const isOwner = key && row.edit_key === key;
      // A draft can be walked through a private view link: the view_key lives
      // in the world doc, grants viewing only, and re-keying kills old links.
      const vk = String(body.view_key ?? "");
      const canView = row.status === "published" || isOwner ||
        (vk && (row.world as Record<string, unknown> | null)?.["view_key"] === vk);
      if (!canView) return json({ error: "This world is not published" }, 403);
      if (!isOwner) logEvent(slug, "view");
      return json({ slug, world: row.world, published: row.status === "published", owner: !!isOwner, source: row.source ?? null });
    }

    if (action === "list_published") {
      const limit = Math.max(1, Math.min(60, Number(body.limit ?? 24)));
      const r = await fetch(
        `${BASE()}/rest/v1/m3ix_spaces?status=eq.published&world=not.is.null&select=embed_slug,title,world,created_at,source&order=created_at.desc&limit=${limit}`,
        { headers: svcHeaders() },
      );
      const rows = await r.json().catch(() => []);
      if (!r.ok || !Array.isArray(rows)) return json({ worlds: [] });
      const worlds = rows.map((x: Record<string, unknown>) => {
        const w = (x.world ?? {}) as Record<string, unknown>;
        const creator = (w.creator ?? {}) as Record<string, unknown>;
        const env = (w.environment ?? {}) as Record<string, unknown>;
        return {
          slug: x.embed_slug,
          name: x.title ?? (w.name as string) ?? "World",
          cover: typeof w.cover === "string" ? w.cover : null,
          creator: { name: String(creator.name ?? "").slice(0, 80), url: String(creator.url ?? "").slice(0, 300) },
          env_type: (env.type as string) ?? "splat",
          source: (x.source as string) ?? null,
          saved_at: (w.saved_at as string) ?? x.created_at,
        };
      });
      return json({ worlds });
    }

    if (action === "rehost") {
      const slug = String(body.slug ?? "");
      const key = String(body.edit_key ?? "");
      const row = await getRow(slug);
      if (!row || row.edit_key !== key) return json({ error: "Unknown world or wrong edit key" }, 403);
      const doc = (row.world ?? {}) as Record<string, any>;
      const src = String(body.url ?? doc?.environment?.src ?? "");
      if (!/^https:\/\//.test(src)) return json({ error: "World has no https environment source" }, 400);
      if (src.startsWith(`${BASE()}/storage/`)) return json({ ok: true, slug, src, note: "already self-hosted" });
      const dl = await fetch(src);
      if (!dl.ok) return json({ error: `Source fetch failed (${dl.status})` }, 502);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      if (bytes.length < 10_000) return json({ error: `Source returned only ${bytes.length} bytes — not a scan file (check the URL)` }, 502);
      const extM = src.split("?")[0].match(/\.(ply|spz|splat|ksplat)$/i);
      const ext = extM ? extM[1].toLowerCase() : "ply";
      const base = `${slug}/env-${Date.now().toString(36)}.${ext}`;
      const urls = await storeChunks(base, bytes);
      const env = { ...(doc.environment ?? {}), src: urls[0] } as Record<string, unknown>;
      if (urls.length > 1) { env.parts = urls; env.file = `env.${ext}`; } else { delete env.parts; delete env.file; }
      const newDoc = { ...doc, environment: env, saved_at: new Date().toISOString() };
      const upd = await fetch(`${BASE()}/rest/v1/m3ix_spaces?embed_slug=eq.${encodeURIComponent(slug)}`, {
        method: "PATCH", headers: { ...svcHeaders(), Prefer: "return=minimal" }, body: JSON.stringify({ world: newDoc }),
      });
      if (!upd.ok) return json({ error: "Doc update failed" }, 500);
      logEvent(slug, "rehost", { from: src.slice(0, 120), mb: Math.round(bytes.length / 1048576), parts: urls.length });
      return json({ ok: true, slug, src: urls[0], parts: urls.length, size_mb: Math.round(bytes.length / 1048576) });
    }

    /* Take a world off the public Library. The doc keeps published:false so
       a later save does not silently re-publish it. */
    if (action === "unpublish") {
      const slug = String(body.slug ?? "");
      const key = String(body.edit_key ?? "");
      const row = await getRow(slug);
      if (!row || row.edit_key !== key) return json({ error: "Unknown world or wrong edit key" }, 403);
      const doc = { ...((row.world ?? {}) as Record<string, unknown>), published: false, saved_at: new Date().toISOString() };
      const upd = await fetch(`${BASE()}/rest/v1/m3ix_spaces?embed_slug=eq.${encodeURIComponent(slug)}`, {
        method: "PATCH", headers: { ...svcHeaders(), Prefer: "return=minimal" }, body: JSON.stringify({ world: doc, status: "draft" }),
      });
      if (!upd.ok) return json({ error: "Unpublish failed" }, 500);
      logEvent(slug, "unpublish");
      return json({ ok: true, slug, published: false });
    }

    if (action === "lead") {
      const slug = String(body.slug ?? "");
      const row = await getRow(slug);
      if (!row) return json({ error: "Unknown world — property tours send enquiries to m3ix-spatial, not here" }, 404);
      const name = String(body.name ?? "").slice(0, 120);
      const contact = String(body.contact ?? "").slice(0, 200);
      const message = String(body.message ?? "").slice(0, 2000);
      if (!contact) return json({ error: "A contact (email or phone) is required" }, 400);
      const ins = await fetch(`${BASE()}/rest/v1/m3ix_leads`, {
        method: "POST",
        headers: { ...svcHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ space_id: row.id, name, contact, message, source_url: "world:" + slug }),
      });
      if (!ins.ok) return json({ error: "Could not record enquiry" }, 500);
      logEvent(slug, "lead");
      return json({ ok: true });
    }

    if (action === "event") {
      const slug = String(body.slug ?? "").slice(0, 60);
      const kind = String(body.kind ?? "").slice(0, 40);
      if (slug && kind) logEvent(slug, kind, body.meta);
      return json({ ok: true });
    }

    return json({ error: "Unknown action. Use create | upload_url | save | load | list_published | rehost | unpublish | lead | event" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
