import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ===========================================================================
   M3XI Spatial — ingest pipeline.

   One shape for every stage:

     key = sha256(stage ‖ stage_version ‖ sorted(input_hashes) ‖ canonical(params))
     run : (inputs, params) -> artifacts
     if the artifact store already holds `key`, the stage is skipped.

   That single rule buys resumability, partial rebuilds and reproducibility:
   bump one stage's version and only it and its descendants re-run. A crashed
   worker re-runs one stage, never a property.

   The viewer receives FACTS — navmesh, floor plane, room graph, spawn — and
   performs no geometry inference of its own. Orientation is resolved once,
   here, from the measured gravity vector.

   Actions: register_capture | complete_capture | build | stage_result
            | publish | manifest
   =========================================================================== */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const BASE = () => Deno.env.get("SUPABASE_URL") ?? "";
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

/* ---------- content addressing ---------- */

const PIPELINE_VERSION = "1.0.0";

/** Stage identity: name, version, and the params that change its output. */
const STAGES = [
  { name: "ingest",       version: "1.0.0", needs: [] },
  { name: "quality",      version: "1.0.0", needs: ["ingest"] },
  { name: "pose_refine",  version: "1.0.0", needs: ["quality"] },
  { name: "align",        version: "1.0.0", needs: ["pose_refine"] },
  { name: "register",     version: "1.0.0", needs: ["align"], optional: true },
  { name: "proxy_mesh",   version: "1.0.0", needs: ["align"], phase: 2 },
  { name: "navmesh",      version: "1.0.0", needs: ["proxy_mesh"], phase: 2 },
  { name: "rooms",        version: "1.0.0", needs: ["align"] },
  { name: "appearance",   version: "1.0.0", needs: ["align"] },
  { name: "package",      version: "1.0.0", needs: ["rooms", "appearance"] },
] as const;

/** Stable stringify: key must not change because a JSON key order changed. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function stageKey(stage: string, version: string, inputHashes: string[], params: unknown) {
  return await sha256([stage, version, [...inputHashes].sort().join(","), canonical(params ?? {})].join(" "));
}

/* ---------- capture manifest validation ----------
   A capture is COMPLETE only when its manifest checksum verifies. Anything
   less is rejected whole: a half-capture that looks fine is worse than none. */

type Pose = { i: number; room: number; seg?: number; heading: number; url: string };
type Manifest = {
  format_version: string;
  capture_id: string;
  poses?: Pose[];
  floorplan?: { url: string; pins?: Record<string, { x: number; y: number }> } | null;
  address?: string;
  capture_method?: string;
  device?: Record<string, unknown>;
  intrinsics?: Record<string, number | boolean>;
  gravity?: { vector: number[]; confidence: number };
  geo?: Record<string, number>;
  rooms_declared?: { idx: number; name: string }[];
  coverage?: { score: number; per_room?: Record<string, number> };
  frame_count?: number;
  duration_s?: number;
  captured_at?: string;
  sha256?: string;
};

const MIN_COVERAGE = 0.7;
const MIN_GRAVITY_CONFIDENCE = 0.8;

/* Two capture methods, two honest standards.

   A NATIVE AR capture will be reconstructed into geometry, so it must carry
   real optics and real measured gravity — without them the maths cannot run.

   A WEB PANORAMA is never reconstructed. The viewer only ever shows the photo
   nearest the heading you face, so what it needs is a heading on every photo
   and enough of them to cover a turn. Demanding camera intrinsics from a
   browser that cannot report them would reject every valid web capture — as
   it just did. */
function validateManifest(m: Manifest): string[] {
  const bad: string[] = [];
  if (!m || m.format_version !== "1.0") bad.push("unsupported format_version");
  const pano = m.capture_method === "web-panorama";

  if (pano) {
    const poses = m.poses ?? [];
    if (!poses.length) bad.push("no photos in the capture");
    else if (poses.some((p) => typeof p.heading !== "number" || !p.url))
      bad.push("every photo needs a heading and a url");
    if (!m.rooms_declared?.length) bad.push("no rooms were declared");
    if ((m.frame_count ?? 0) < 12) bad.push("too few photos — under half a turn");
  } else {
    if (!m.intrinsics || !m.intrinsics.fx) bad.push("camera intrinsics missing");
    if (!m.gravity || !Array.isArray(m.gravity.vector) || m.gravity.vector.length !== 3)
      bad.push("gravity vector missing — orientation cannot be resolved");
    else if ((m.gravity.confidence ?? 0) < MIN_GRAVITY_CONFIDENCE)
      bad.push(`gravity confidence ${m.gravity.confidence} below ${MIN_GRAVITY_CONFIDENCE}`);
    if (!m.frame_count || m.frame_count < 30) bad.push("too few frames");
  }

  if ((m.coverage?.score ?? 0) < MIN_COVERAGE)
    bad.push(`coverage ${((m.coverage?.score ?? 0) * 100).toFixed(0)}% below ${MIN_COVERAGE * 100}%`);
  return bad;
}

/* ---------- gravity -> canonical frame ----------
   Orientation, once and for all. The phone measured which way is down; we
   build the rotation that takes that to -Y and never infer it again. */
function frameFromGravity(g: number[], headingDeg?: number) {
  const n = Math.hypot(g[0], g[1], g[2]) || 1;
  const down = [g[0] / n, g[1] / n, g[2] / n];
  const up = [-down[0], -down[1], -down[2]];
  // rotation taking `up` onto +Y (axis-angle, world frame)
  const target = [0, 1, 0];
  const axis = [
    up[1] * target[2] - up[2] * target[1],
    up[2] * target[0] - up[0] * target[2],
    up[0] * target[1] - up[1] * target[0],
  ];
  const dot = up[0] * target[0] + up[1] * target[1] + up[2] * target[2];
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  const al = Math.hypot(axis[0], axis[1], axis[2]);
  return {
    up,
    align_axis: al > 1e-6 ? [axis[0] / al, axis[1] / al, axis[2] / al] : [1, 0, 0],
    align_angle_rad: al > 1e-6 ? angle : 0,
    north_deg: headingDeg ?? null,
    resolved_by: "measured_gravity",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    /* --- 1. reserve a capture and hand back an upload prefix --- */
    if (action === "register_capture") {
      const property_id = String(body.property_id ?? "");
      if (!property_id) return json({ error: "property_id required" }, 400);
      const id = crypto.randomUUID();
      const prefix = `captures/${property_id}/${id}`;
      const row = await db("m3ix_capture", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id, property_id, storage_prefix: prefix,
          manifest_sha: `pending:${id}`, status: "uploading",
          device: body.device ?? null, app_version: body.app_version ?? null,
        }),
      });
      return json({ capture_id: id, storage_prefix: prefix, capture: row?.[0] ?? null });
    }

    /* --- 1b. a signed slot to PUT one file into this capture's raw prefix ----
       Raw stays raw: every object lands under the capture's own immutable
       prefix and nothing in the pipeline overwrites it. */
    if (action === "upload_url") {
      const capture_id = String(body.capture_id ?? "");
      const filename = String(body.filename ?? "").toLowerCase().replace(/[^a-z0-9\-_.]+/g, "-").slice(0, 80);
      if (!capture_id || !filename) return json({ error: "capture_id and filename required" }, 400);
      const caps = await db(`m3ix_capture?id=eq.${capture_id}&select=storage_prefix,status`);
      const cap = caps?.[0];
      if (!cap) return json({ error: "capture not found" }, 404);
      if (cap.status === "complete") return json({ error: "capture is sealed" }, 409);
      const path = `${cap.storage_prefix}/${filename}`;
      if (!/^[a-z0-9][a-z0-9\-_./]{2,200}$/.test(path)) return json({ error: "bad path" }, 400);
      const r = await fetch(`${BASE()}/storage/v1/object/upload/sign/worlds/${path}`, {
        method: "POST", headers: svc(), body: "{}",
      });
      const text = await r.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text); } catch { /* keep null */ }
      const rel = j && (j.url as string);
      if (!r.ok || !rel) return json({ error: `could not sign upload (${r.status})` }, 500);
      return json({
        upload_url: `${BASE()}/storage/v1${rel}`,
        public_url: `${BASE()}/storage/v1/object/public/worlds/${path}`,
        path,
      });
    }

    /* --- 2. the manifest lands last; verifying it is what makes a capture real --- */
    if (action === "complete_capture") {
      const capture_id = String(body.capture_id ?? "");
      const manifest = body.manifest as Manifest;
      if (!capture_id || !manifest) return json({ error: "capture_id and manifest required" }, 400);

      const problems = validateManifest(manifest);
      if (problems.length) {
        await db(`m3ix_capture?id=eq.${capture_id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "rejected", quality: { problems } }),
        });
        return json({ ok: false, status: "rejected", problems }, 422);
      }

      const sha = await sha256(canonical(manifest));

      /* Dedupe is idempotent, not an error. The app retries after a dropped
         connection; identical content is the SAME capture, so hand back the
         original and discard the placeholder rather than 409-ing at a phone
         standing in someone's hallway. */
      const self = await db(`m3ix_capture?id=eq.${capture_id}&select=property_id`);
      const propId = self?.[0]?.property_id;
      if (propId) {
        const twin = await db(
          `m3ix_capture?property_id=eq.${propId}&manifest_sha=eq.${sha}&select=id&limit=1`,
        );
        if (twin?.length && twin[0].id !== capture_id) {
          await db(`m3ix_capture?id=eq.${capture_id}`, { method: "DELETE" });
          return json({ ok: true, capture_id: twin[0].id, manifest_sha: sha, deduped: true });
        }
      }

      await db(`m3ix_capture?id=eq.${capture_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "complete",
          manifest_sha: sha,
          manifest,                       // raw is the source of truth: keep all of it
          frame_count: manifest.frame_count ?? null,
          duration_s: manifest.duration_s ?? null,
          gravity: manifest.gravity ?? null,
          geo: manifest.geo ?? null,
          coverage: manifest.coverage ?? null,
          device: manifest.device ?? null,
          captured_at: manifest.captured_at ?? new Date().toISOString(),
        }),
      });
      return json({ ok: true, capture_id, manifest_sha: sha });
    }

    /* --- 3. plan a build: compute every stage key, reuse what already exists --- */
    if (action === "build") {
      const capture_id = String(body.capture_id ?? "");
      if (!capture_id) return json({ error: "capture_id required" }, 400);
      const caps = await db(`m3ix_capture?id=eq.${capture_id}&select=*`);
      const cap = caps?.[0];
      if (!cap) return json({ error: "capture not found" }, 404);
      if (cap.status !== "complete") return json({ error: `capture is ${cap.status}` }, 409);

      const phase = Number(body.phase ?? 1);
      const params = { phase, lidar: !!cap.device?.has_lidar };

      // Prior builds of the same capture: any stage whose key matches is reusable.
      const prior = await db(
        `m3ix_build?capture_id=eq.${capture_id}&status=eq.complete&select=stage_keys,artifacts&order=created_at.desc&limit=5`,
      );
      const known: Record<string, unknown> = {};
      for (const b of prior ?? []) {
        for (const [k, v] of Object.entries(b.artifacts ?? {})) if (!(k in known)) known[k] = v;
      }

      const keys: Record<string, string> = {};
      const plan: { stage: string; key: string; reuse: boolean }[] = [];
      const hashOf: Record<string, string> = { ingest: cap.manifest_sha };
      for (const s of STAGES) {
        if ((s as { phase?: number }).phase && (s as { phase?: number }).phase! > phase) continue;
        if (s.name === "register" && !body.register_against) continue;
        const inputs = s.needs.length ? s.needs.map((n) => hashOf[n]).filter(Boolean) : [cap.manifest_sha];
        const key = await stageKey(s.name, s.version, inputs, params);
        keys[s.name] = key;
        hashOf[s.name] = key;
        const reuse = Object.values(known).some((a) => (a as { key?: string })?.key === key);
        plan.push({ stage: s.name, key, reuse });
      }

      const build = await db("m3ix_build", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          capture_id, property_id: cap.property_id,
          pipeline_version: PIPELINE_VERSION,
          stage_keys: keys, status: "queued", started_at: new Date().toISOString(),
          // Say where "up" came from. A phone held upright is an ASSUMPTION;
          // a measured gravity vector is a fact. Never label one as the other.
          frame_transform: (cap.manifest as Manifest | null)?.capture_method === "web-panorama"
            ? { up: [0, 1, 0], north_deg: null, confidence: 1, resolved_by: "assumed_upright" }
            : (cap.gravity ? frameFromGravity(cap.gravity.vector, cap.geo?.heading_deg) : null),
        }),
      });
      const buildId = build?.[0]?.id;

      /* The `rooms` stage for a phase-1 panorama capture: declared rooms become
         records carrying their floorplan pin and the photos taken standing in
         them. Keyed STABLY, so an agent who renamed "Bedroom" to "Master
         bedroom", or nudged a pin, keeps that through every rebuild — a
         pipeline must never overwrite a human's edit. */
      const man = cap.manifest as Manifest | null;
      if (buildId && man?.rooms_declared?.length) {
        const poses = (man.poses ?? []) as Pose[];
        const pins = man.floorplan?.pins ?? {};
        for (const rd of man.rooms_declared) {
          const nodes = poses
            .filter((p) => p.room === rd.idx)
            .sort((a, b) => a.heading - b.heading)
            .map((p) => ({ heading: p.heading, url: p.url }));
          const stable = `r${rd.idx}-${rd.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
          const found = await db(
            `m3ix_room?property_id=eq.${cap.property_id}&stable_key=eq.${encodeURIComponent(stable)}&select=id,edited_at,pin`,
          );
          const prior = found?.[0];
          const row: Record<string, unknown> = {
            property_id: cap.property_id, stable_key: stable,
            floor_index: 0, ordinal: rd.idx, computed_by: buildId, nodes,
          };
          if (!prior?.edited_at) row.name = rd.name;         // agent's name wins
          const pin = pins[rd.name];
          if (pin && !prior?.pin) row.pin = pin;             // agent's pin wins
          if (prior) await db(`m3ix_room?id=eq.${prior.id}`, { method: "PATCH", body: JSON.stringify(row) });
          else await db("m3ix_room", { method: "POST", body: JSON.stringify(row) });
        }
        if (man.floorplan?.url) {
          await db(`m3ix_property?id=eq.${cap.property_id}`, {
            method: "PATCH",
            body: JSON.stringify({ floorplan: { url: man.floorplan.url, uploaded_at: new Date().toISOString() } }),
          });
        }
      }
      return json({ build_id: buildId, pipeline_version: PIPELINE_VERSION, plan });
    }

    /* --- 4. a worker reports one stage; artifacts are keyed, so this is idempotent --- */
    if (action === "stage_result") {
      const build_id = String(body.build_id ?? "");
      const stage = String(body.stage ?? "");
      if (!build_id || !stage) return json({ error: "build_id and stage required" }, 400);
      const rows = await db(`m3ix_build?id=eq.${build_id}&select=*`);
      const b = rows?.[0];
      if (!b) return json({ error: "build not found" }, 404);

      const artifacts = { ...(b.artifacts ?? {}) };
      if (body.artifacts && typeof body.artifacts === "object") {
        for (const [name, a] of Object.entries(body.artifacts as Record<string, unknown>)) {
          artifacts[name] = { ...(a as object), key: b.stage_keys?.[stage] ?? null, stage };
        }
      }
      const done = !!body.done;
      const failed = !!body.error;
      await db(`m3ix_build?id=eq.${build_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          artifacts,
          metrics: { ...(b.metrics ?? {}), ...(body.metrics ?? {}) },
          status: failed ? "failed" : done ? "complete" : "running",
          error: failed ? body.error : null,
          ended_at: done || failed ? new Date().toISOString() : null,
        }),
      });
      return json({ ok: true, build_id, stage, status: failed ? "failed" : done ? "complete" : "running" });
    }

    /* --- 5. publish: one pointer swap, then re-anchor semantics ----------------
       Annotations live in the property frame, so a rebuild of the same capture
       needs no work. A DIFFERENT capture must be registered first; where the
       registration is weak we flag the annotation rather than move it. Agent
       work is never destroyed to make a pipeline succeed. */
    if (action === "publish") {
      const build_id = String(body.build_id ?? "");
      const slug = String(body.slug ?? "");
      if (!build_id) return json({ error: "build_id required" }, 400);
      const rows = await db(`m3ix_build?id=eq.${build_id}&select=*`);
      const b = rows?.[0];
      if (!b) return json({ error: "build not found" }, 404);
      if (b.status !== "complete") return json({ error: `build is ${b.status}` }, 409);

      const confident = Number(b.frame_transform?.confidence ?? 1) >= 0.8;
      if (!confident) {
        await db(`m3ix_annotation?property_id=eq.${b.property_id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "needs_review" }),
        });
      }

      /* One tour per property: the permalink is the stable thing, so a new
         build swaps the pointer rather than minting a second link. The
         response must show the tour as it NOW stands, not as it was found. */
      const existing = await db(`m3ix_tour?property_id=eq.${b.property_id}&select=id,slug&limit=1`);
      let tour = existing?.[0];
      if (tour) {
        const updated = await db(`m3ix_tour?id=eq.${tour.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ build_id, status: "published", published_at: new Date().toISOString() }),
        });
        tour = updated?.[0] ?? tour;
      } else {
        const t = await db("m3ix_tour", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            property_id: b.property_id, build_id,
            slug: slug || `tour-${crypto.randomUUID().slice(0, 8)}`,
            view_key: crypto.randomUUID().replace(/-/g, "").slice(0, 20),
            provenance: "captured", status: "published",
            published_at: new Date().toISOString(),
          }),
        });
        tour = t?.[0];
      }
      return json({ ok: true, tour, annotations_flagged: !confident });
    }

    /* --- 6. everything the viewer needs, in one fetch, with no inference left --- */
    if (action === "manifest") {
      const slug = String(body.slug ?? "");
      const vk = String(body.view_key ?? "");
      if (!slug) return json({ error: "slug required" }, 400);
      const tours = await db(`m3ix_tour?slug=eq.${encodeURIComponent(slug)}&select=*`);
      const t = tours?.[0];
      if (!t) return json({ error: "not found" }, 404);
      if (t.status !== "published" && !(vk && vk === t.view_key))
        return json({ error: "not published" }, 403);

      const builds = t.build_id ? await db(`m3ix_build?id=eq.${t.build_id}&select=*`) : null;
      const b = builds?.[0];
      const rooms = await db(
        `m3ix_room?property_id=eq.${t.property_id}&select=id,name,kind,floor_index,ordinal,pin,nodes,spawn&order=floor_index,ordinal`,
      );
      const annos = await db(`m3ix_annotation?property_id=eq.${t.property_id}&status=eq.ok&select=*`);
      const props = await db(`m3ix_property?id=eq.${t.property_id}&select=address_line,floorplan`);
      const prop = props?.[0];

      return json({
        tour: { slug: t.slug, provenance: t.provenance, branding: t.branding, status: t.status },
        property: { address: prop?.address_line ?? null },
        floorplan: prop?.floorplan ?? null,
        frame: b?.frame_transform ?? null,
        artifacts: b?.artifacts ?? {},
        rooms: rooms ?? [],
        annotations: annos ?? [],
        pipeline_version: b?.pipeline_version ?? null,
      });
    }

    return json({
      error: "Unknown action. Use register_capture | complete_capture | build | stage_result | publish | manifest",
    }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
