import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ===========================================================================
   M3XI Spatial — the property-tour backend (v2).

   A tour is a set of NODES: one full-sphere photograph per standpoint, pinned
   on the agent's own floorplan, grouped into rooms, linked to the standpoints
   you can walk to. Nothing here is reconstructed or generated: every pixel a
   buyer sees was recorded by a camera standing in the property.

   Who may do what:
     - Anyone holding a link: `manifest` (published, or unlisted + view_key),
       `lead`, `og`.
     - A signed-in member of the property's org: everything else. Identity is
       the caller's Supabase JWT, resolved through /auth/v1/user; membership is
       m3ix_org_member. The service role is used for writes only after that
       check has passed.

   Media lives in the PRIVATE `tours` bucket. The viewer receives short-lived
   signed URLs from `manifest`; nothing about a home is world-readable.

   Actions
     register_capture | upload_url | complete_capture
     go_live | unpublish | archive | delete_tour | rotate_view_key
     list_tours | get_tour | update_tour | update_room | update_node | list_leads
     manifest | og | lead
   =========================================================================== */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const PIPELINE_VERSION = "2.0.0";
const BUCKET = "tours";
const SIGN_TTL_S = 3600;          // viewer media
const OG_TTL_S = 7 * 24 * 3600;   // unfurl image; crawlers cache it

const BASE = () => Deno.env.get("SUPABASE_URL") ?? "";
const ANON = () => Deno.env.get("SUPABASE_ANON_KEY") ?? "";
function svc() {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}
async function db(path: string, init?: RequestInit) {
  const r = await fetch(`${BASE()}/rest/v1/${path}`, { ...init, headers: { ...svc(), ...(init?.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const one = async (path: string) => (await db(path))?.[0] ?? null;
const UUIDRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown) => typeof s === "string" && UUIDRE.test(s);

/* ---------- identity ---------- */

function bearer(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}
/** The signed-in user's id, or null. The anon key is a valid JWT but not a person. */
const uidCache = new WeakMap<Request, Promise<string | null>>();
function callerId(req: Request): Promise<string | null> {
  let p = uidCache.get(req);
  if (!p) { p = resolveCaller(req); uidCache.set(req, p); }
  return p;
}
async function resolveCaller(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token || token === ANON()) return null;
  try {
    const r = await fetch(`${BASE()}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: ANON() } });
    if (!r.ok) return null;
    const u = await r.json();
    return isUuid(u?.id) ? String(u.id) : null;
  } catch { return null; }
}
/** Every action that changes or reveals an agency's data needs a person behind it. */
const NEEDS_USER = new Set([
  "register_capture", "upload_url", "complete_capture",
  "go_live", "unpublish", "archive", "delete_tour", "rotate_view_key",
  "list_tours", "get_tour", "update_tour", "update_room", "update_node", "list_leads",
]);
async function orgsOf(uid: string): Promise<string[]> {
  const rows = await db(`m3ix_org_member?user_id=eq.${uid}&select=org_id`);
  return (rows ?? []).map((r: { org_id: string }) => r.org_id);
}
class Denied extends Error { status: number; constructor(m: string, s = 403) { super(m); this.status = s; } }

/** Resolve the caller and confirm they belong to the org that owns `property_id`. */
async function requireProperty(req: Request, property_id: string) {
  if (!isUuid(property_id)) throw new Denied("property_id required", 400);
  const uid = await callerId(req);
  if (!uid) throw new Denied("Sign in to do that.", 401);
  const prop = await one(`m3ix_property?id=eq.${property_id}&select=id,org_id,address_line,floorplan`);
  if (!prop) throw new Denied("Property not found", 404);
  const orgs = await orgsOf(uid);
  if (!orgs.includes(prop.org_id)) throw new Denied("That property belongs to another agency.", 403);
  return { uid, prop, orgs };
}
async function requireTour(req: Request, ref: { tour_id?: unknown; slug?: unknown }) {
  const t = isUuid(ref.tour_id)
    ? await one(`m3ix_tour?id=eq.${ref.tour_id}&select=*`)
    : await one(`m3ix_tour?slug=eq.${encodeURIComponent(String(ref.slug ?? ""))}&select=*`);
  if (!t) throw new Denied("Tour not found", 404);
  const ctx = await requireProperty(req, t.property_id);
  return { ...ctx, tour: t };
}

/* ---------- storage ---------- */

const SAFE_NAME = /^[a-z0-9][a-z0-9\-_.]{0,80}$/;
async function signUpload(path: string) {
  const r = await fetch(`${BASE()}/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: "POST", headers: svc(), body: "{}" });
  const t = await r.text();
  let j: { url?: string } | null = null;
  try { j = JSON.parse(t); } catch { /* keep null */ }
  if (!r.ok || !j?.url) throw new Error(`could not sign upload (${r.status}): ${t.slice(0, 120)}`);
  return `${BASE()}/storage/v1${j.url}`;
}
/** Short-lived read URLs for many objects at once. Missing objects come back null. */
async function signRead(paths: string[], ttl = SIGN_TTL_S): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return out;
  const r = await fetch(`${BASE()}/storage/v1/object/sign/${BUCKET}`, {
    method: "POST", headers: svc(), body: JSON.stringify({ expiresIn: ttl, paths: list }),
  });
  const rows = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(rows)) throw new Error(`could not sign reads (${r.status})`);
  for (const row of rows) out[row.path] = row.signedURL ? `${BASE()}/storage/v1${row.signedURL}` : null;
  return out;
}
async function listObjects(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(`${BASE()}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: svc(),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    const rows = await r.json().catch(() => []);
    if (!r.ok || !Array.isArray(rows) || !rows.length) break;
    for (const o of rows) if (o?.name && o?.id) names.push(`${prefix}/${o.name}`);
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return names;
}
/** Remove every object under a capture/property prefix (recursing one level of folders). */
async function purgePrefix(prefix: string): Promise<number> {
  // Storage "folders" are virtual; list each level we know we write to.
  const direct = await listObjects(prefix);
  const nested = (await Promise.all(
    (await listFolders(prefix)).map((f) => listObjects(`${prefix}/${f}`)),
  )).flat();
  const all = [...direct, ...nested];
  if (!all.length) return 0;
  for (let i = 0; i < all.length; i += 200) {
    await fetch(`${BASE()}/storage/v1/object/${BUCKET}`, {
      method: "DELETE", headers: svc(), body: JSON.stringify({ prefixes: all.slice(i, i + 200) }),
    });
  }
  return all.length;
}
async function listFolders(prefix: string): Promise<string[]> {
  const r = await fetch(`${BASE()}/storage/v1/object/list/${BUCKET}`, {
    method: "POST", headers: svc(), body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  const rows = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(rows)) return [];
  return rows.filter((o) => o?.name && !o?.id).map((o) => o.name as string);
}

/* ---------- helpers ---------- */

function slugify(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tour")
    + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 4);
}
const stableKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) || "room";
const viewKey = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const nowIso = () => new Date().toISOString();
const clamp01 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
function pinOf(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const x = clamp01((v as { x?: unknown }).x), y = clamp01((v as { y?: unknown }).y);
  return x === null || y === null ? null : { x, y };
}
function degOf(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
}

type NodeIn = {
  key?: string; room: string; ordinal?: number; label?: string;
  path: string; preview_path?: string; width?: number; height?: number; bytes?: number; sha256?: string;
  source?: string; pin?: unknown; north_deg?: unknown; captured_at?: string;
};

/** A node is a full sphere: a 2:1 equirectangular image of sane size. */
function validateNode(n: NodeIn, prefix: string): string | null {
  if (!n || typeof n.path !== "string" || !n.path.startsWith(prefix + "/")) return "a photo is outside this capture";
  if (n.preview_path && !n.preview_path.startsWith(prefix + "/")) return "a preview is outside this capture";
  if (!n.room || typeof n.room !== "string") return "a photo has no room";
  const w = Number(n.width), h = Number(n.height);
  if (!(w >= 2048 && h >= 1024)) return `"${n.label || n.room}" is too small (${w || "?"}×${h || "?"}); a 360 photo is at least 2048×1024`;
  if (Math.abs(w / h - 2) > 0.04) return `"${n.label || n.room}" is not a full 360 photo (${w}×${h} is not 2:1)`;
  if (n.source && !["360-camera", "phone-photosphere", "other"].includes(n.source)) return "unknown photo source";
  return null;
}

/** Branding for a tour defaults to the agency record; the agent can edit it later. */
async function defaultBranding(org_id: string) {
  const org = await one(`m3ix_org?id=eq.${org_id}&select=name,created_by`);
  const acct = org?.created_by ? await one(`m3ix_accounts?user_id=eq.${org.created_by}&select=email,display_name`) : null;
  return { name: org?.name || acct?.display_name || "", email: acct?.email || "", phone: "", colour: "#d0402b", logo_path: null };
}

async function tourSummary(t: Record<string, unknown>) {
  const prop = await one(`m3ix_property?id=eq.${t.property_id}&select=address_line,floorplan`);
  const nodes = await db(`m3ix_node?property_id=eq.${t.property_id}&status=eq.active&select=id`);
  const rooms = await db(`m3ix_room?property_id=eq.${t.property_id}&select=id`);
  const leads = await db(`m3ix_leads?property_id=eq.${t.property_id}&select=id`);
  return {
    id: t.id, slug: t.slug, status: t.status, title: t.title, branding: t.branding, spawn: t.spawn,
    view_key: t.view_key, published_at: t.published_at, created_at: t.created_at,
    property: { id: t.property_id, address: prop?.address_line ?? null, has_floorplan: !!prop?.floorplan?.path },
    counts: { nodes: nodes?.length ?? 0, rooms: rooms?.length ?? 0, leads: leads?.length ?? 0 },
    urls: {
      preview: `/tour/?t=${encodeURIComponent(String(t.slug))}&vk=${encodeURIComponent(String(t.view_key ?? ""))}`,
      live: `/tour/?t=${encodeURIComponent(String(t.slug))}`,
    },
  };
}

/* =========================================================================== */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    // Identity first, before any lookup can say whether an id exists.
    if (NEEDS_USER.has(action) && !(await callerId(req))) return json({ error: "Sign in to do that." }, 401);

    /* ------------------------------------------------------------------ */
    /* CAPTURE                                                             */
    /* ------------------------------------------------------------------ */

    /* Reserve a capture for an address. The property row is found-or-made
       by the m3ix_capture_property RPC, called AS THE USER so it lands in
       their agency; repeat visits to the same address reuse the property. */
    if (action === "register_capture") {
      const uid = await callerId(req);
      if (!uid) return json({ error: "Sign in to capture." }, 401);
      let property_id = isUuid(body.property_id) ? String(body.property_id) : "";
      if (!property_id) {
        const address = String(body.address ?? "").trim();
        if (!address) return json({ error: "Add the property address first." }, 400);
        const r = await fetch(`${BASE()}/rest/v1/rpc/m3ix_capture_property`, {
          method: "POST",
          headers: { apikey: ANON(), Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_address: address }),
        });
        const t = await r.text();
        if (!r.ok) return json({ error: `Could not open a property record: ${t.slice(0, 200)}` }, 500);
        property_id = JSON.parse(t);
      }
      const { prop } = await requireProperty(req, property_id);
      const id = crypto.randomUUID();
      const prefix = `captures/${property_id}/${id}`;
      await db("m3ix_capture", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id, property_id, storage_prefix: prefix, manifest_sha: `pending:${id}`, status: "uploading",
          device: body.device ?? null, app_version: String(body.app_version ?? "web-2.0.0"),
        }),
      });
      const existing = await one(`m3ix_tour?property_id=eq.${property_id}&select=id,slug,status,view_key`);
      return json({ capture_id: id, property_id, storage_prefix: prefix, address: prop.address_line, existing_tour: existing });
    }

    /* One signed PUT slot per file, inside the capture's own prefix. */
    if (action === "upload_url") {
      const capture_id = String(body.capture_id ?? "");
      const filename = String(body.filename ?? "").toLowerCase().replace(/[^a-z0-9\-_.]+/g, "-").slice(0, 80);
      if (!isUuid(capture_id) || !SAFE_NAME.test(filename)) return json({ error: "capture_id and a plain filename are required" }, 400);
      const cap = await one(`m3ix_capture?id=eq.${capture_id}&select=property_id,storage_prefix,status`);
      if (!cap) return json({ error: "capture not found" }, 404);
      await requireProperty(req, cap.property_id);
      if (cap.status !== "uploading") return json({ error: "This capture is already sealed — start a new one." }, 409);
      const path = `${cap.storage_prefix}/${filename}`;
      return json({ upload_url: await signUpload(path), path });
    }

    /* The manifest lands last. Everything a tour is made of is declared
       here; it is validated whole, then rooms/nodes are upserted by stable
       key so an agent's later edits (names, pins) survive a re-capture, and
       nodes that were not re-shot are superseded rather than duplicated. */
    if (action === "complete_capture") {
      const capture_id = String(body.capture_id ?? "");
      if (!isUuid(capture_id)) return json({ error: "capture_id required" }, 400);
      const cap = await one(`m3ix_capture?id=eq.${capture_id}&select=*`);
      if (!cap) return json({ error: "capture not found" }, 404);
      const { prop, uid } = await requireProperty(req, cap.property_id);
      if (cap.status !== "uploading") return json({ error: `capture is ${cap.status}` }, 409);

      const nodesIn = (Array.isArray(body.nodes) ? body.nodes : []) as NodeIn[];
      if (!nodesIn.length) return json({ ok: false, problems: ["no photos in the capture"] }, 422);
      const problems = nodesIn.map((n) => validateNode(n, cap.storage_prefix)).filter(Boolean) as string[];
      const floorplan = body.floorplan && typeof body.floorplan.path === "string" ? body.floorplan : null;
      if (floorplan && !floorplan.path.startsWith(cap.storage_prefix + "/")) problems.push("floorplan is outside this capture");
      if (problems.length) {
        await db(`m3ix_capture?id=eq.${capture_id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected", quality: { problems } }) });
        return json({ ok: false, status: "rejected", problems }, 422);
      }

      // Confirm the objects actually exist before anything goes live.
      const present = await listObjects(cap.storage_prefix);
      const missing = nodesIn.filter((n) => !present.includes(n.path)).map((n) => n.label || n.room);
      if (floorplan && !present.includes(floorplan.path)) missing.push("floorplan");
      if (missing.length) return json({ ok: false, problems: [`not uploaded yet: ${missing.join(", ")}`] }, 422);

      const pid = cap.property_id as string;
      const manifest = { format_version: "2.0", capture_id, nodes: nodesIn, floorplan, links: body.links ?? [], spawn: body.spawn ?? null, captured_at: body.captured_at ?? nowIso() };
      const sha = await sha256(JSON.stringify(manifest));
      await db(`m3ix_capture?id=eq.${capture_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "complete", manifest_sha: sha, manifest, frame_count: nodesIn.length,
          coverage: { score: 1, nodes: nodesIn.length }, device: cap.device ?? body.device ?? null,
          captured_at: manifest.captured_at,
        }),
      });
      const build = (await db("m3ix_build", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          capture_id, property_id: pid, pipeline_version: PIPELINE_VERSION,
          stage_keys: { nodes: sha }, artifacts: { nodes: { count: nodesIn.length, key: sha } },
          status: "complete", started_at: nowIso(), ended_at: nowIso(),
          frame_transform: { up: [0, 1, 0], resolved_by: "equirectangular", confidence: 1 },
        }),
      }))?.[0];

      // Rooms: upsert by stable key. A renamed room keeps its record.
      const roomIds: Record<string, string> = {};
      const roomNames = [...new Set(nodesIn.map((n) => String(n.room).trim()).filter(Boolean))];
      for (let i = 0; i < roomNames.length; i++) {
        const name = roomNames[i];
        const key = "r-" + stableKey(name);
        const prior = await one(`m3ix_room?property_id=eq.${pid}&stable_key=eq.${encodeURIComponent(key)}&select=id,edited_at`);
        const row: Record<string, unknown> = { property_id: pid, stable_key: key, floor_index: 0, ordinal: i, computed_by: build?.id ?? null };
        if (!prior?.edited_at) row.name = name;
        if (prior) { await db(`m3ix_room?id=eq.${prior.id}`, { method: "PATCH", body: JSON.stringify(row) }); roomIds[name] = prior.id; }
        else {
          const made = (await db("m3ix_room", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...row, name }) }))?.[0];
          roomIds[name] = made.id;
        }
      }

      // Nodes: upsert by stable key (room + ordinal). Keys sent by the page
      // let links refer to nodes before they have ids.
      const keyToId: Record<string, string> = {};
      const touched: string[] = [];
      const perRoom: Record<string, number> = {};
      for (const n of nodesIn) {
        const room = String(n.room).trim();
        const ord = Number.isFinite(Number(n.ordinal)) ? Number(n.ordinal) : (perRoom[room] ?? 0);
        perRoom[room] = ord + 1;
        const key = `r-${stableKey(room)}-n${ord}`;
        const prior = await one(`m3ix_node?property_id=eq.${pid}&stable_key=eq.${encodeURIComponent(key)}&select=id,edited_at,pin,north_deg,label`);
        const row: Record<string, unknown> = {
          property_id: pid, room_id: roomIds[room], capture_id, stable_key: key, ordinal: ord,
          pano_path: n.path, preview_path: n.preview_path ?? null,
          width: Number(n.width), height: Number(n.height), bytes: Number(n.bytes ?? 0) || null, sha256: n.sha256 ?? null,
          source: n.source ?? "360-camera", captured_at: n.captured_at ?? manifest.captured_at, status: "active",
        };
        // A human's edit wins over a re-capture; a fresh value fills a blank.
        if (!prior?.edited_at) { row.label = n.label ?? null; row.pin = pinOf(n.pin); row.north_deg = degOf(n.north_deg); }
        else { if (prior.pin == null) row.pin = pinOf(n.pin); if (prior.north_deg == null) row.north_deg = degOf(n.north_deg); }
        let id: string;
        if (prior) { await db(`m3ix_node?id=eq.${prior.id}`, { method: "PATCH", body: JSON.stringify(row) }); id = prior.id; }
        else id = (await db("m3ix_node", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }))?.[0]?.id;
        keyToId[n.key ?? key] = id; keyToId[key] = id; touched.push(id);
      }
      // Anything in a re-shot room that was not re-shot is superseded, not left live.
      const roomIdList = Object.values(roomIds);
      if (roomIdList.length) {
        await db(`m3ix_node?property_id=eq.${pid}&room_id=in.(${roomIdList.join(",")})&id=not.in.(${touched.join(",")})&status=eq.active`, {
          method: "PATCH", body: JSON.stringify({ status: "superseded" }),
        });
      }
      // Links: explicit pairs from the page, plus every pair within a room.
      const links: Record<string, Set<string>> = {};
      const add = (a?: string, b?: string) => { if (!a || !b || a === b) return; (links[a] ??= new Set()).add(b); (links[b] ??= new Set()).add(a); };
      for (const pair of (Array.isArray(body.links) ? body.links : [])) if (Array.isArray(pair)) add(keyToId[pair[0]], keyToId[pair[1]]);
      const byRoom: Record<string, string[]> = {};
      for (const n of nodesIn) {
        const room = String(n.room).trim();
        const id = keyToId[n.key ?? ""] ?? null;
        if (id) (byRoom[room] ??= []).push(id);
      }
      for (const ids of Object.values(byRoom)) for (const a of ids) for (const b of ids) add(a, b);
      for (const id of touched) {
        await db(`m3ix_node?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ links: [...(links[id] ?? [])] }) });
      }
      if (floorplan) {
        await db(`m3ix_property?id=eq.${pid}`, { method: "PATCH", body: JSON.stringify({ floorplan: { path: floorplan.path, uploaded_at: nowIso() } }) });
      }

      // The tour: one per property. New tours start UNLISTED — the agent
      // previews through the view-key link and goes live on purpose.
      let tour = await one(`m3ix_tour?property_id=eq.${pid}&select=*`);
      const spawnNode = body.spawn?.key ? keyToId[body.spawn.key] : touched[0];
      const spawn = spawnNode ? { node_id: spawnNode, yaw: degOf(body.spawn?.yaw) ?? 0 } : null;
      if (tour) {
        tour = (await db(`m3ix_tour?id=eq.${tour.id}`, {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ build_id: build?.id ?? null, ...(tour.spawn ? {} : { spawn }), ...(tour.status === "archived" ? { status: "unlisted", archived_at: null } : {}) }),
        }))?.[0] ?? tour;
      } else {
        tour = (await db("m3ix_tour", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            property_id: pid, build_id: build?.id ?? null, slug: slugify(prop.address_line || "tour"), view_key: viewKey(),
            provenance: "captured", status: "unlisted", title: prop.address_line ?? null, spawn,
            branding: await defaultBranding(prop.org_id),
          }),
        }))?.[0];
      }
      return json({ ok: true, capture_id, tour: await tourSummary(tour), nodes: touched.length, rooms: roomIdList.length, by: uid });
    }

    /* ------------------------------------------------------------------ */
    /* LIFECYCLE (org members)                                             */
    /* ------------------------------------------------------------------ */

    if (action === "go_live" || action === "unpublish" || action === "archive") {
      const { tour, prop } = await requireTour(req, body);
      const patch: Record<string, unknown> = action === "go_live"
        ? { status: "published", published_at: nowIso(), archived_at: null, branding: tour.branding ?? await defaultBranding(prop.org_id) }
        : action === "unpublish" ? { status: "unlisted" }
        : { status: "archived", archived_at: nowIso() };
      if (action === "go_live") {
        const n = await db(`m3ix_node?property_id=eq.${tour.property_id}&status=eq.active&select=id&limit=1`);
        if (!n?.length) return json({ error: "This tour has no photos yet." }, 409);
      }
      const t = (await db(`m3ix_tour?id=eq.${tour.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }))?.[0];
      return json({ ok: true, tour: await tourSummary(t) });
    }

    if (action === "rotate_view_key") {
      const { tour } = await requireTour(req, body);
      const t = (await db(`m3ix_tour?id=eq.${tour.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ view_key: viewKey() }) }))?.[0];
      return json({ ok: true, tour: await tourSummary(t) });
    }

    /* Delete is total: the tour, its rooms and nodes, every capture, and every
       object under the property's prefix in storage. The property row and its
       leads stay (they are the agency's record). */
    if (action === "delete_tour") {
      const { tour } = await requireTour(req, body);
      const pid = tour.property_id as string;
      const removed = await purgePrefix(`captures/${pid}`);
      await db(`m3ix_tour?id=eq.${tour.id}`, { method: "DELETE" });
      await db(`m3ix_node?property_id=eq.${pid}`, { method: "DELETE" });
      await db(`m3ix_room?property_id=eq.${pid}`, { method: "DELETE" });
      await db(`m3ix_capture?property_id=eq.${pid}`, { method: "DELETE" });   // builds cascade
      await db(`m3ix_property?id=eq.${pid}`, { method: "PATCH", body: JSON.stringify({ floorplan: null }) });
      return json({ ok: true, objects_removed: removed });
    }

    if (action === "list_tours") {
      const uid = await callerId(req);
      if (!uid) return json({ error: "Sign in to see your tours." }, 401);
      const orgs = await orgsOf(uid);
      if (!orgs.length) return json({ tours: [] });
      const props = await db(`m3ix_property?org_id=in.(${orgs.join(",")})&select=id`);
      const ids = (props ?? []).map((p: { id: string }) => p.id);
      if (!ids.length) return json({ tours: [] });
      const tours = await db(`m3ix_tour?property_id=in.(${ids.join(",")})&select=*&order=created_at.desc`);
      return json({ tours: await Promise.all((tours ?? []).map(tourSummary)) });
    }

    if (action === "get_tour") {
      const { tour } = await requireTour(req, body);
      const rooms = await db(`m3ix_room?property_id=eq.${tour.property_id}&select=id,name,ordinal,stable_key,scan,edited_at&order=ordinal`);
      const nodes = await db(`m3ix_node?property_id=eq.${tour.property_id}&status=eq.active&select=id,room_id,stable_key,ordinal,label,pin,north_deg,links,source,captured_at,width,height,bytes,preview_path,pano_path&order=ordinal`);
      const prop = await one(`m3ix_property?id=eq.${tour.property_id}&select=floorplan`);
      const signed = await signRead([...(nodes ?? []).map((n: { preview_path?: string }) => n.preview_path).filter(Boolean), prop?.floorplan?.path].filter(Boolean) as string[]);
      return json({
        tour: await tourSummary(tour), rooms,
        nodes: (nodes ?? []).map((n: Record<string, unknown>) => ({ ...n, preview_url: n.preview_path ? signed[n.preview_path as string] : null })),
        floorplan: prop?.floorplan?.path ? { url: signed[prop.floorplan.path] } : null,
      });
    }

    if (action === "update_tour") {
      const { tour } = await requireTour(req, body);
      const patch: Record<string, unknown> = {};
      if (typeof body.title === "string") patch.title = body.title.slice(0, 120);
      if (body.branding && typeof body.branding === "object") {
        const b = body.branding as Record<string, unknown>;
        patch.branding = {
          ...(tour.branding ?? {}),
          name: String(b.name ?? tour.branding?.name ?? "").slice(0, 80),
          email: String(b.email ?? tour.branding?.email ?? "").slice(0, 120),
          phone: String(b.phone ?? tour.branding?.phone ?? "").slice(0, 40),
          colour: /^#[0-9a-f]{6}$/i.test(String(b.colour ?? "")) ? String(b.colour) : (tour.branding?.colour ?? "#d0402b"),
          website: String(b.website ?? tour.branding?.website ?? "").slice(0, 200),
          logo_path: typeof b.logo_path === "string" && b.logo_path.startsWith(`captures/${tour.property_id}/`) ? b.logo_path : (tour.branding?.logo_path ?? null),
        };
      }
      if (body.spawn && isUuid(body.spawn.node_id)) patch.spawn = { node_id: body.spawn.node_id, yaw: degOf(body.spawn.yaw) ?? 0 };
      const t = (await db(`m3ix_tour?id=eq.${tour.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }))?.[0];
      return json({ ok: true, tour: await tourSummary(t) });
    }

    if (action === "update_room") {
      const room = await one(`m3ix_room?id=eq.${String(body.room_id)}&select=id,property_id`);
      if (!room) return json({ error: "room not found" }, 404);
      await requireProperty(req, room.property_id);
      const patch: Record<string, unknown> = { edited_at: nowIso() };
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
      if (Number.isFinite(Number(body.ordinal))) patch.ordinal = Number(body.ordinal);
      const r = (await db(`m3ix_room?id=eq.${room.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }))?.[0];
      return json({ ok: true, room: r });
    }

    if (action === "update_node") {
      const node = await one(`m3ix_node?id=eq.${String(body.node_id)}&select=id,property_id,links`);
      if (!node) return json({ error: "node not found" }, 404);
      await requireProperty(req, node.property_id);
      const patch: Record<string, unknown> = { edited_at: nowIso() };
      if ("pin" in body) patch.pin = pinOf(body.pin);
      if ("north_deg" in body) patch.north_deg = degOf(body.north_deg);
      if (typeof body.label === "string") patch.label = body.label.slice(0, 60);
      if (body.status === "deleted") patch.status = "deleted";
      if (Array.isArray(body.links)) {
        const valid = await db(`m3ix_node?property_id=eq.${node.property_id}&status=eq.active&select=id`);
        const ok = new Set((valid ?? []).map((v: { id: string }) => v.id));
        patch.links = body.links.filter((l: unknown) => isUuid(l) && ok.has(l as string) && l !== node.id);
      }
      const n = (await db(`m3ix_node?id=eq.${node.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }))?.[0];
      return json({ ok: true, node: n });
    }

    if (action === "list_leads") {
      const { tour } = await requireTour(req, body);
      const leads = await db(`m3ix_leads?property_id=eq.${tour.property_id}&select=id,name,contact,message,node_label,notified_at,notify_error,created_at&order=created_at.desc&limit=200`);
      return json({ leads });
    }

    /* ------------------------------------------------------------------ */
    /* PUBLIC                                                              */
    /* ------------------------------------------------------------------ */

    /* Everything the viewer needs in one response. Media URLs are signed and
       expire; the page refreshes them by asking again. */
    if (action === "manifest" || action === "og") {
      const slug = String(body.slug ?? "");
      const vk = String(body.view_key ?? "");
      if (!slug) return json({ error: "slug required" }, 400);
      const t = await one(`m3ix_tour?slug=eq.${encodeURIComponent(slug)}&select=*`);
      if (!t) return json({ error: "not found" }, 404);
      const open = t.status === "published" || (t.status === "unlisted" && vk && vk === t.view_key);
      if (!open) return json({ error: "not published" }, 403);
      const prop = await one(`m3ix_property?id=eq.${t.property_id}&select=address_line,floorplan`);
      const rooms = await db(`m3ix_room?property_id=eq.${t.property_id}&select=id,name,ordinal,scan&order=ordinal`);
      const nodes = await db(`m3ix_node?property_id=eq.${t.property_id}&status=eq.active&select=id,room_id,ordinal,label,pano_path,preview_path,width,height,pin,north_deg,links,source,captured_at&order=ordinal`);
      const latest = (nodes ?? []).map((n: { captured_at?: string }) => n.captured_at).filter(Boolean).sort().pop() ?? null;
      const branding = { ...(t.branding ?? {}) };
      delete branding.logo_path;

      if (action === "og") {
        const spawn = (nodes ?? []).find((n: { id: string }) => n.id === t.spawn?.node_id) ?? nodes?.[0];
        const img = spawn?.preview_path ? (await signRead([spawn.preview_path], OG_TTL_S))[spawn.preview_path] : null;
        return json({ title: t.title || prop?.address_line || "Property tour", address: prop?.address_line ?? null, image: img, agency: branding.name ?? "", rooms: rooms?.length ?? 0, nodes: nodes?.length ?? 0, photographed_at: latest });
      }

      const paths = [
        ...(nodes ?? []).flatMap((n: { pano_path: string; preview_path?: string }) => [n.pano_path, n.preview_path]),
        prop?.floorplan?.path, t.branding?.logo_path,
        ...(rooms ?? []).map((r: { scan?: { path?: string } }) => r.scan?.path),
      ].filter(Boolean) as string[];
      const signed = await signRead(paths);
      return json({
        tour: { slug: t.slug, status: t.status, provenance: t.provenance, title: t.title, branding: { ...branding, logo_url: t.branding?.logo_path ? signed[t.branding.logo_path] : null }, spawn: t.spawn, published_at: t.published_at },
        property: { address: prop?.address_line ?? null },
        floorplan: prop?.floorplan?.path ? { url: signed[prop.floorplan.path], uploaded_at: prop.floorplan.uploaded_at ?? null } : null,
        rooms: (rooms ?? []).map((r: Record<string, unknown>) => ({
          id: r.id, name: r.name, ordinal: r.ordinal,
          scan: (r.scan as { path?: string; format?: string; facts?: unknown; scanned_at?: string } | null)?.path
            ? { url: signed[(r.scan as { path: string }).path], format: (r.scan as { format?: string }).format, facts: (r.scan as { facts?: unknown }).facts ?? null, scanned_at: (r.scan as { scanned_at?: string }).scanned_at ?? null }
            : null,
        })),
        nodes: (nodes ?? []).map((n: Record<string, unknown>) => ({
          id: n.id, room_id: n.room_id, ordinal: n.ordinal, label: n.label,
          url: signed[n.pano_path as string], preview_url: n.preview_path ? signed[n.preview_path as string] : null,
          width: n.width, height: n.height, pin: n.pin, north_deg: n.north_deg, links: n.links, source: n.source, captured_at: n.captured_at,
        })),
        photographed_at: latest,
        expires_in: SIGN_TTL_S,
        pipeline_version: PIPELINE_VERSION,
      });
    }

    /* An enquiry from inside a tour. Recorded against the property so the
       agency sees it; the m3ix_lead_notify trigger emails them. */
    if (action === "lead") {
      const slug = String(body.slug ?? "");
      const t = await one(`m3ix_tour?slug=eq.${encodeURIComponent(slug)}&select=id,property_id,status,view_key`);
      if (!t) return json({ error: "Tour not found" }, 404);
      if (!(t.status === "published" || (t.status === "unlisted" && String(body.view_key ?? "") === t.view_key))) return json({ error: "This tour is not live" }, 403);
      const contact = String(body.contact ?? "").trim().slice(0, 200);
      if (!contact) return json({ error: "An email or phone number is required" }, 400);
      const ins = await fetch(`${BASE()}/rest/v1/m3ix_leads`, {
        method: "POST", headers: { ...svc(), Prefer: "return=representation" },
        body: JSON.stringify({
          property_id: t.property_id, tour_id: t.id,
          name: String(body.name ?? "").trim().slice(0, 120), contact,
          message: String(body.message ?? "").trim().slice(0, 2000),
          node_label: String(body.node_label ?? "").slice(0, 120) || null,
          source_url: `tour:${slug}`,
        }),
      });
      if (!ins.ok) return json({ error: `Could not record the enquiry (${ins.status})` }, 500);
      const row = (await ins.json().catch(() => []))?.[0];
      return json({ ok: true, lead_id: row?.id ?? null });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const err = e as Denied;
    return json({ error: err.message }, err.status && err.status >= 400 ? err.status : 500);
  }
});

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
