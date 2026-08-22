# Property tour — API contract (m3ix-spatial v2)

Endpoint: `POST https://tnlcuptfldwxtxajudoq.supabase.co/functions/v1/m3ix-spatial`
Headers: `Content-Type: application/json`, `apikey: <anon key>`, `Authorization: Bearer <user JWT, or anon key for public actions>`.
Every response is JSON. Errors are `{ error: string }` with an HTTP status (400 bad input, 401 sign in, 403 not yours / not live, 404 not found, 409 wrong state, 422 rejected capture, 500 server).

Source: `supabase/functions/m3ix-spatial/index.ts`. Media bucket: `tours` (private; the viewer only ever receives signed URLs that expire after `expires_in` seconds).

## Identity

Member-only actions require the signed-in user's JWT (supabase-js `session.access_token`). The function resolves the user and checks `m3ix_org_member` for the org that owns the property. The anon key is rejected with 401 `Sign in to do that.` on every member-only action, before any lookup.

## Capture (member)

### `register_capture`
`{ action, address }` or `{ action, property_id }` → `{ capture_id, property_id, storage_prefix, address, existing_tour }`
- `address` is found-or-created within the caller's agency (same address → same property → same tour).
- `existing_tour` is `{ id, slug, status, view_key }` or `null`.

### `upload_url`
`{ action, capture_id, filename }` → `{ upload_url, path }`
- `filename` must match `^[a-z0-9][a-z0-9\-_.]{0,80}$` (the function lowercases and replaces other characters with `-`).
- PUT the file bytes to `upload_url` with the file's `Content-Type`. `path` is what you later put in the manifest.
- Refused with 409 once the capture is sealed.

### `complete_capture`
```
{ action, capture_id,
  nodes: [ { key, room, ordinal, label, path, preview_path, width, height, bytes, sha256,
             source: "360-camera" | "phone-photosphere" | "other",
             pin: {x,y} | null, north_deg: number | null, captured_at } ],
  floorplan: { path } | null,
  links: [ [keyA, keyB], ... ],        // extra walkable links between standpoints (same-room pairs are added automatically)
  spawn: { key, yaw } | null,          // opening standpoint + yaw (deg, 0 = image centre)
  captured_at }
```
→ `{ ok: true, tour: TourSummary, nodes, rooms }` or 422 `{ ok:false, problems:[...] }`.
- Validation: every `path` under `storage_prefix/`; `width ≥ 2048`, `height ≥ 1024`, `width/height` within 4 % of 2:1; every object must already exist in storage.
- Rooms are upserted by `r-<slug(room)>`; nodes by `r-<slug(room)>-n<ordinal>`. A node in a re-shot room that is not in this manifest becomes `superseded`. An agent's later edits (`edited_at` set by `update_room`/`update_node`) win over a re-capture.
- The tour is created **unlisted** (or kept at its current status). Nothing goes live here.

## Lifecycle (member)

| action | input | effect |
|---|---|---|
| `go_live` | `{ tour_id \| slug }` | status → `published` (409 if no active nodes) |
| `unpublish` | `{ tour_id \| slug }` | status → `unlisted` (preview link still works) |
| `archive` | `{ tour_id \| slug }` | status → `archived` (nothing works) |
| `rotate_view_key` | `{ tour_id \| slug }` | new preview key; old preview links die |
| `delete_tour` | `{ tour_id \| slug }` | deletes tour, rooms, nodes, captures and every object under `captures/<property>/`; keeps the property and its leads |
| `list_tours` | `{}` | `{ tours: TourSummary[] }` for the caller's agencies |
| `get_tour` | `{ tour_id \| slug }` | `{ tour, rooms (with signed scan), nodes (with preview_url), floorplan:{url} }` |
| `update_tour` | `{ tour_id, title?, branding?: {name,email,phone,colour,website,logo_path}, spawn?: {node_id,yaw} }` | edits |
| `update_room` | `{ room_id, name?, ordinal? }` | sets `edited_at` |
| `update_node` | `{ node_id, pin?, north_deg?, label?, links?: uuid[], status?: "deleted" }` | sets `edited_at` |
| `list_leads` | `{ tour_id \| slug }` | `{ leads: [{ id,name,contact,message,node_label,notified_at,notify_error,created_at }] }` |

`TourSummary` = `{ id, slug, status, title, branding, spawn, view_key, published_at, created_at, property:{id,address,has_floorplan}, counts:{nodes,rooms,leads}, urls:{preview,live} }`.

## Room scans (Phase 2)

A room may carry **one** real Gaussian-splat scan — a Scaniverse "Splat mode" export, or a Polycam-class file — so a buyer can walk it first-person instead of only turning on the spot. A scan is a recording: what the phone never saw stays missing. Nothing is in-painted, generated or filled in.

A scan is **two objects**: the splat file, and a `facts.json` computed from it once, at the moment the agent attaches it. The floor height, up-axis, spawn point and walkable area are worked out offline and stored; the viewer reads them and never recomputes them in a visitor's browser.

Both objects live in the private `tours` bucket under `captures/<property_id>/scans/`, so `delete_tour`'s purge already sweeps them up. Formats: `.ply`, `.spz`, `.splat`, `.ksplat`. One object may be at most **50 MB** (52,428,800 bytes). Note that this is the **project's** global per-object limit, not the bucket's: the `tours` bucket is configured for 250 MB and will report that, but storage refuses anything over 50 MB with `EntityTooLarge`, surfaced through a signed PUT as an opaque HTTP 400. Measured by bisection against the live API (50 MB uploads, 51 MB refused). Above **25 MB** the API still accepts the file but returns a `warning`, because the buyer downloads it. A `.spz` export of the same room is usually about a tenth the size of a `.ply` and looks the same.

The order is always `scan_upload_url` → PUT both files → `attach_scan`. All three actions are member-only: the anon key is rejected with 401 `Sign in to do that.` before any lookup, like every other member action.

### `scan_upload_url`
`{ action, room_id, filename, bytes }` → `{ upload_url, path, facts_upload_url, facts_path, max_bytes, warning }`
- `filename` is lowercased and non-`[a-z0-9-_.]` characters become `-`, as in `upload_url`. Its extension decides the format and must be one of the four — anything else is 400.
- `bytes` is the size of the **scan** file (not the facts) and is required. Over `max_bytes` → 400, naming the cap and suggesting a `.spz` export. Over 25 MB → 200 with `warning` set; `null` otherwise.
- `path` is `captures/<property_id>/scans/<12 hex>-<filename>`, and `facts_path` is that same path plus `.facts.json`. **Both** are signed for a single PUT: send the scan to `upload_url`, the facts JSON to `facts_upload_url`.
- Nothing is attached to the room here. A slot that is never used is simply never referenced.

### `attach_scan`
```
{ action, room_id, path, facts_path, format, bytes, sha256, splats, summary, scanned_at }
```
→ `{ ok: true, room, objects_removed }`
- Both `path` and `facts_path` must start with `captures/<property_id>/scans/` (400 otherwise), and **both objects must already be in storage** — the same check `complete_capture` makes for photos — or 422 `Not uploaded yet: …`.
- `facts_path` must differ from `path` and end in `.json`. It does **not** have to be the slot minted alongside this scan, so recomputed facts can be attached to a scan that is already uploaded: send the existing `path` with a fresh `facts_path` and only the superseded facts file is deleted.
- `summary` is required and must carry a boolean `usable`: `{ area_m2, holes_pct, usable, up }`, lifted from the facts you just computed (`up` is written `"z-"` for `{axis:'z',sign:-1}`). A missing verdict is not a yes.
- A file already attached to a different room in the same property is refused with 409 — one scan, one room, so removing it from one room can never break another.
- `sha256` (64 hex) and `splats` are optional and stored as given; `format` must match the four, and `bytes` is checked against the cap again.
- If the room already had a scan at a different path, the row is written **first** and only then are the previous scan and its facts deleted: a failure leaves the old walk working, a success leaves no orphans. `objects_removed` counts what went.
- Sets the room's `edited_at`, like `update_room`, so a later re-capture does not overwrite the agent's work.

Stored on `m3ix_room.scan`:
```json
{ "path": "captures/<property_id>/scans/<rand>-office.ply",
  "facts_path": "captures/<property_id>/scans/<rand>-office.ply.facts.json",
  "format": "ply", "bytes": 91515019, "sha256": "…", "splats": 369006,
  "summary": { "area_m2": 18.4, "holes_pct": 3.1, "usable": true, "up": "z-" },
  "scanned_at": "2026-08-20", "attached_at": "2026-08-22T08:00:00Z" }
```

### `remove_scan`
`{ action, room_id }` → `{ ok: true, objects_removed }`
- Clears `m3ix_room.scan` first, then deletes the two objects, so a failure leaves a room pointing at files that still exist rather than at files that are gone. A room with no scan answers `{ ok: true, objects_removed: 0 }`.

### What a client is served

`manifest` (public) and `get_tour` (member) both sign **both** objects:

```
rooms: [ { id, name, ordinal,
           scan: { url, facts_url, format, summary, scanned_at, bytes, splats } | null } ]
```
- `url` is the splat file and keeps exactly the meaning it had before Phase 2; `facts_url` is its `facts.json`. Both are short-lived signed URLs that expire after `expires_in` seconds, like every other URL in the manifest.
- Fetch `facts_url` and use what it says. If `facts_url` is `null`, or `summary.usable` is `false`, do **not** offer "Walk this room" — say why instead. `usable:false` means the walkable area came out under 2 m²; dropping a visitor into a cage, or letting them fly through walls, is worse than not offering the walk.
- `scan.facts` also appears and is legacy: it is `null` for everything `attach_scan` writes. Read `facts_url`.
- `get_tour` returns that object *plus* the stored fields (`path`, `facts_path`, `sha256`, `attached_at`), so a dashboard can show what is attached. The public `manifest` never exposes storage paths.

### `facts.json`

Uploaded next to the scan, in this exact shape. The backend stores it byte-for-byte and never parses it — the module that computes it and the viewer that reads it are the two ends of this contract.

```json
{
  "version": 1,
  "source": { "format": "ply", "splats": 369006, "bytes": 91515019, "sha256": "…" },
  "up": { "axis": "z", "sign": -1 },
  "floor_y": -3.72,
  "eye": 1.6,
  "spawn": { "x": 0.2, "y": -3.72, "z": 1.1, "yaw": 0 },
  "grid": {
    "w": 62, "h": 58, "cell": 0.16, "minx": -5.0, "minz": -4.6,
    "floorY": "<base64 Float32Array w*h, NaN = no floor>",
    "ceilY":  "<base64 Float32Array w*h, NaN = none>",
    "walk":   "<base64 Uint8Array  w*h, 1 = a body fits>",
    "solid":  "<base64 Uint8Array  w*h, 1 = wall/furniture>",
    "reach":  "<base64 Uint8Array  w*h, 1 = in the largest connected region>"
  },
  "area_m2": 18.4, "holes_pct": 3.1, "walls": 412,
  "usable": true,
  "warnings": ["…"],
  "diagnostics": { "splats": 369006, "threshold": 0.75, "up_margin": 2.41, "…": "…" },
  "computed_at": "2026-08-22T08:00:00Z"
}
```

`spawn.yaw` is in **degrees**, same convention as everywhere else in this document (0 = the direction the scan's own +Z faces after the up-rotation). `chooseSpawn` currently always writes 0.

`diagnostics` is free-form and advisory: how the up-axis was settled, the wall threshold chosen, the bounding box, the cell counts. Nothing reads it to make a decision — it exists so a person can see why a scan measured the way it did. Treat every key in it as unstable.

`usable:false` means the walkable area is under 2 m² — the viewer must then refuse to offer "Walk this room" and say why, rather than dropping the visitor into a cage or letting them fly through walls.

**`walk` vs `reach`, and which one governs.** `walk` is every cell with a floor and shoulder room; `reach` is the largest patch of those whose floors actually connect by steps rather than cliffs. `area_m2` — the number the agent is shown and the buyer is promised — is measured from `reach`, and **`reach` is also what `canStand()` enforces**, so the space you may walk is exactly the space that was measured. The two must not be allowed to drift apart: on a real office scan `walk` held 3,401 cells spanning seventeen metres of height (mostly the sparse halo a phone capture throws off) against `reach`'s 327 flat cells, and gating movement on `walk` let a visitor stroll off the floor and fall. Where a scan yields no connected region at all, `walk` is the fallback so the visitor is not frozen in place.

### Scan coordinate convention

`facts.up = {axis:'x'|'y'|'z', sign:1|-1}` is the rotation the renderer must apply so that `sign * axis` becomes **+Y (up)**. **Every other number in `facts` is expressed in that rotated, Y-up frame** — `floor_y`, `spawn`, the grid's `minx`/`minz` and all `floorY`/`ceilY` values. Apply the rotation first, then use the facts directly.

This is separate from the 360 geometry below, which is about equirectangular images and floorplan pins.

## Public

### `manifest`
`{ action, slug, view_key? }` → 403 unless `published`, or `unlisted` with the right `view_key`.
```
{ tour: { slug, status, provenance, title, branding:{name,email,phone,colour,website,logo_url}, spawn:{node_id,yaw}, published_at },
  property: { address },
  floorplan: { url, uploaded_at } | null,
  rooms: [ { id, name, ordinal, scan: { url, facts_url, format, summary, scanned_at, bytes, splats } | null } ],
  nodes: [ { id, room_id, ordinal, label, url, preview_url, width, height, pin, north_deg, links:[node_id], source, captured_at } ],
  photographed_at, expires_in, pipeline_version }
```
All `url`s are signed and expire after `expires_in` seconds — ask again when they do.

### `og`
`{ action, slug, view_key? }` → `{ title, address, image (signed, 7 days), agency, rooms, nodes, photographed_at }` — for the share-preview shell.

### `lead`
`{ action, slug, view_key?, name, contact, message, node_label }` → `{ ok: true, lead_id }`.
Inserts into `m3ix_leads` with `property_id` + `tour_id`; the `m3ix_lead_notify` trigger calls `m3ix-lead-notify`, which emails the agency (needs the `RESEND_API_KEY` secret; otherwise the lead carries `notify_error` and is visible in the dashboard).

## Geometry conventions

- A node image is equirectangular. **Yaw 0° is the image centre** (where the camera's front faced); yaw increases turning right (clockwise seen from above), so the left edge is −180°/180° and the right edge +180°. `north_deg` is the yaw in the image that points to the floorplan's up direction; `null` means uncalibrated (arrows fall back to room order). `spawn.yaw` uses the same convention.
- Floorplan pins are fractions of the plan image (`0..1`), origin top-left.
- Bearing from node A to node B on the plan: `atan2(dx, -dy)` in degrees (0 = up/north, clockwise). The yaw to look at B from A in A's image is `north_deg_A + bearing` (normalised to −180..180).

## Clean URLs

A tour is shared as `https://www.m3xi.com/tour/<slug>` (preview links add `?vk=<view_key>`). That path is served by `api/tour.js`, a Vercel Node function: it calls `og` with the slug (and `view_key`), fetches the static viewer shell `public/tour/index.html` (cached in memory for five minutes), and injects into its `<head>` — at the `<!-- og -->` marker if the shell has one, otherwise right after `<meta charset>` — a `<title>`, `og:title` (address, else title), `og:description` ("Walk through N rooms from M standpoints — photographed <date>. Tour by <agency>."), `og:image` (omitted when null), `og:type`, `og:url`, `twitter:card`, and `<meta name="robots" content="noindex">` when `og` answered 403/404 or a `vk` is present. Responses carry `Cache-Control: public, max-age=60, s-maxage=300`. If `og` or the shell fetch fails, the unmodified shell (plus the slug script below) still goes out with `no-store`, and the viewer shows its own error.

**Viewer note:** because the address bar stays at `/tour/<slug>`, there is no `?t=` to read. The function injects `<script>window.__M3IX_TOUR={slug:"<slug>",vk:"<vk>"}</script>` before anything else in `<head>`; the viewer should read `window.__M3IX_TOUR` as a fallback when `?t` is absent (`vk` is `""` when there is none).

**Integrator:** add this rewrite to `vercel.json` (it is not there yet). The negative lookahead keeps the shell and the viewer's scripts on the static path; `vercel.json` rewrites are already evaluated after the filesystem, so `/tour/` and `/tour/index.html` keep serving the static file. The literal dots are written `[.]` so the line is valid JSON as-is (a bare `\.` is not a JSON escape; it would need doubling).

```json
{ "source": "/tour/:slug((?!index[.]html$|tour[.]js$|embed[.]js$)[a-z0-9-]+)", "destination": "/api/tour?slug=:slug" }
```

Checked against the regex path-to-regexp 6 (Vercel's version) compiles this to: `/tour/nope` and `/tour/12-elm-street` rewrite; `/tour/`, `/tour/index.html`, `/tour/tour.js`, `/tour/embed.js` and `/tour/a/b` do not. The query string (`?vk=`) is carried through to `/api/tour` by Vercel; the function reads `req.query.slug` and `req.query.vk`.

Nothing in `api/tour.js` needs an environment variable; it reads `VERCEL_ENV` only to decide where to fetch the shell from (production: `https://www.m3xi.com/tour/index.html`; preview/local: the request's own origin first, then the live site).
