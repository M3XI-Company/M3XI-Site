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
| `get_tour` | `{ tour_id \| slug }` | `{ tour, rooms, nodes (with preview_url), floorplan:{url} }` |
| `update_tour` | `{ tour_id, title?, branding?: {name,email,phone,colour,website,logo_path}, spawn?: {node_id,yaw} }` | edits |
| `update_room` | `{ room_id, name?, ordinal? }` | sets `edited_at` |
| `update_node` | `{ node_id, pin?, north_deg?, label?, links?: uuid[], status?: "deleted" }` | sets `edited_at` |
| `list_leads` | `{ tour_id \| slug }` | `{ leads: [{ id,name,contact,message,node_label,notified_at,notify_error,created_at }] }` |

`TourSummary` = `{ id, slug, status, title, branding, spawn, view_key, published_at, created_at, property:{id,address,has_floorplan}, counts:{nodes,rooms,leads}, urls:{preview,live} }`.

## Public

### `manifest`
`{ action, slug, view_key? }` → 403 unless `published`, or `unlisted` with the right `view_key`.
```
{ tour: { slug, status, provenance, title, branding:{name,email,phone,colour,website,logo_url}, spawn:{node_id,yaw}, published_at },
  property: { address },
  floorplan: { url, uploaded_at } | null,
  rooms: [ { id, name, ordinal, scan: { url, format, facts, scanned_at } | null } ],
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
