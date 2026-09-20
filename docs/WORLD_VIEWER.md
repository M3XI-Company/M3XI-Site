# World Viewer — what is deployed, what is not, and what it needs

Written 20 September 2026. Everything below was checked against the live
Supabase project (`tnlcuptfldwxtxajudoq`) and a real build, not inferred from
the source. Where something is unverified, it says so.

## What this is

A property walkthrough is a **versioned spatial database**, not a file. The
rows in `wv_*` are the truth; `world.json` is a rendering of them, regenerated
at publish and invalidated by corrections. Everything else follows from that:
an operator's correction has to land somewhere row-level security can protect
and a portfolio query can read, which a file cannot do.

## Where the pieces live

| Piece | Path | State |
| --- | --- | --- |
| World contract | `spatial/packages/world-core` | Complete. Do not edit `types.ts` without saying why. |
| Spatial engine | `spatial/packages/spatial-engine` | Complete. Deterministic geometry: raycast, measure, nav, fit. |
| Viewer | `spatial/packages/viewer` | Complete. Spark + three.js, splats fused with proxy meshes. |
| Agent | `spatial/packages/agent` | Complete. 21 tools, deterministic-first router. |
| Console UI | `spatial/packages/console-ui` | Complete. |
| Review (corrections) | `spatial/packages/review` | Complete. Model, wire, session and the SVG-floorplan editor. |
| Compliance | `spatial/packages/compliance` | Complete. Certificate, DMCC checklist, redaction audit, accessibility statement. |
| Capture guidance | `spatial/packages/capture-core` | Rebuilt 20 Sep 2026. Every threshold traceable to the pipeline. |
| Viewer page | `spatial/apps/view` | Builds. Served at `/view`. |
| Operator console | `spatial/apps/console` | Builds. Served at `/console`. |
| Capture PWA | `spatial/apps/capture` | Empty directories. |
| Pipeline | `spatial/pipeline` | 13-stage DAG + RunPod worker. 265 Python tests pass. |
| Edge functions | `supabase/functions/wv-*` | Deployed code in repo; see "Not yet deployed" below. |

## The build

`npx vite build` at the repo root builds the site **and** the two spatial apps.
Two things about that are worth knowing before changing it:

* The viewer and console entries are **conditional** on `spatial/node_modules`
  being present, because that directory is gitignored. A build server that has
  not run `npm install` inside `spatial/` builds the site exactly as it did
  before those entries existed, rather than failing on an unresolvable import.
* `three` is aliased to a directory, which bypasses its package `exports` map.
  `three/addons/*` therefore needs its own alias, spelled before the bare one.
  Without it the build fails on a missing `Pass.js`, which reads like a broken
  install rather than a resolution rule.

The capture entry is guarded on the page existing alone, not on
`spatial/node_modules`: it imports neither three.js nor Spark.

## Routing

`/view` and `/console` are rewrites in `vercel.json` onto
`/spatial/apps/{view,console}/index.html`, so the repo layout does not leak
into a customer-facing URL. `/console/:path*` also rewrites, because the
console is a single-page app with its own router.

### Known gap: /studio/ is now a hole

Retiring the old spatial system deleted `studio/index.html`,
`studio/worlds.html`, `studio/business.html` and `studio/account.html`.
`vite.config.js` still listed all four, so **every m3xi.com deploy was failing**
on `Could not resolve entry module "studio/index.html"`. The entries are gone
and the build passes.

What is left behind, and is NOT fixed:

* **29 redirects in `vercel.json` point into `/studio/`**, including
  `/studio/pricing` → `/studio/business.html` and
  `/studio/:page(account|business|walkthrough|worlds)`. Every one of them now
  lands on a 404.
* The `/tour/:slug` rewrite points at `/api/tour`, which was also deleted.
* **M3XI Spatial has no marketing page at all.** The product an agency is
  asked to pay for has a console and a viewer and nothing that explains it.

This is a product decision rather than a code fix, which is why it was left
rather than guessed at. The options are to restore a landing page at `/studio/`
(the URL that is already linked and indexed), to move the product to
`/spatial/` and redirect, or to point the retired URLs at the front page and
accept that an agency following an old bookmark lands on a video-call app.

## Database

Migrated and verified on 20 September 2026. Three migrations were applied that
day:

1. `world_viewer_document_cache` — written earlier, never applied. Adds
   `wv_world.scale_provenance` / `scale_confidence`, natural keys for
   `wv_relationship` and `wv_nav_edge`, and statement-level staleness triggers.
2. `world_viewer_server_api` — the database half of handler code that was
   already shipped and calling it: `wv_member.email` with fill and sync
   triggers, `wv_user_id_by_email`, `wv_remove_member`, `updated_at` on the
   four correctable tables, the build cap counting `splat` instead of the
   retired `reconstruct`, pg_trgm indexes for portfolio search, and the three
   storage buckets with their policies.
3. `world_viewer_revoke_anon_predicates` — `anon` could execute
   `wv_org_of_world`, which maps any world id to its owning org. Supabase's
   default privileges grant `EXECUTE` to `anon` explicitly, so the earlier
   revoke from `PUBLIC` had not removed it.
4. `world_viewer_corrections` — `wv_delete_world_row` (the only delete an
   operator can reach, allowlisted to three tables and always scoped by world),
   `wv_region.source` so an operator may withdraw their own coverage note but
   not a survey gap the pipeline recorded, `correction_sources` on the four
   correctable tables so a correction receipt has somewhere to live, and a
   unique index making `register_capture` idempotent for a phone that retries.
5. `world_viewer_delete_scene_graph` — deleting a room or entity now removes
   the `wv_relationship` edges naming it. No foreign key could do this:
   the table is polymorphic. Left behind, those edges are rendered into the
   document `wv-ask` answers from, so a buyer could be told about a room an
   operator deleted that morning because it never existed.

Verified by exercising it, not by reading it: the staleness triggers fire on
insert, update, delete and on the world row; writing the cache does not
invalidate the cache; the `updated_at` trigger overrides a caller-supplied
value, so a correction cannot be backdated over PostgREST; the build cap fires;
and all thirteen queued jobs are claimable through the real `wv_claim_job`, in
exact DAG order.

### Buckets

| Bucket | Holds | Limit |
| --- | --- | --- |
| `wv-assets` | splats, meshes, floorplans, covers, rendered `world.json` | 2 GiB/object |
| `wv-exports` | the customer's permanence bundle | 5 GiB |
| `wv-captures` | the raw walkthrough video | 5 GiB |

All private. The first path segment is always the world id; the storage
policies depend on it, and every writer prepends it rather than letting a
caller choose.

## Not yet deployed

The `wv-*` edge functions in this repo have **not** been deployed since this
work. Deploying needs, in order:

1. `cd spatial && npm run build` — `supabase/functions/deno.json` maps
   `@m3xi/agent` and friends to `dist/`, where their `.js` specifiers resolve.
2. `npx supabase@2.109.1 functions deploy <name> --project-ref tnlcuptfldwxtxajudoq`
   for each of wv-view, wv-ask, wv-jobs, wv-worlds, wv-export.

`supabase/config.toml` pins `verify_jwt` per function: false for wv-view,
wv-ask and wv-jobs (each authenticates itself; wv-jobs by shared secret), true
for wv-worlds and wv-export. Never pass `--no-verify-jwt`: the flag has no
opposite and a plain redeploy will not restore the setting.

## Secrets the system needs

| Secret | Used by | Set? |
| --- | --- | --- |
| `WV_WORKER_SECRET` | wv-jobs, the RunPod worker | Unverified |
| `ANTHROPIC_API_KEY` | wv-ask | Unverified |
| `WV_MODEL_SMALL` / `WV_MODEL_LARGE` | wv-ask routing | Optional |
| `WV_SESSION_COST_CAP_USD` | wv-ask | Optional |

The worker holds **one** secret and no Supabase key. That is deliberate: a
service-role key bypasses RLS across every table in the project, and these GPU
boxes are rented by the minute and recycled between customers. Worker identity
is provisioned out of band as a row in `wv_worker` and supplied as
`WV_WORKER_ID`; a worker that could mint its own identity would make the queue
unauditable.

## The capture guidance, and why its thresholds are copied rather than chosen

`@m3xi/capture-core` is the contract between the phone in an operator's hand
and `spatial/pipeline/worldengine/stages/frames.py`. Every constant in
`thresholds.ts` declares itself MIRRORED from a named pipeline constant,
DERIVED from one with the derivation written out, or CAPTURE-specific with an
argument for the value — and a test reads the Python and fails if a mirrored
one drifts.

That discipline exists because the failure it prevents is expensive and late:
an app that invents its own thresholds tells an operator the walk was fine, and
the pipeline rejects it thirty-five GPU-minutes and $0.74 later, by which time
they have left the property.

The blur metric is contrast-normalised, and that is the property most worth
knowing about. Raw variance of the Laplacian falls by roughly a hundredfold on
a dim scene, so an unnormalised metric calls a perfectly sharp frame in a
badly lit hallway blurred and sends the operator back to re-walk a room that
was fine. The tests drive synthetic frames whose sharpness and contrast vary
independently, and assert both halves: a large contrast change barely moves the
score on the same sharp content, and the score still falls decisively on
content that is genuinely blurred.

What a browser cannot do is refused rather than faked. There is no position —
integrating `DeviceMotionEvent` twice is metres out within three seconds — so
there is no self-filling floorplan anywhere, and `RoomCoverage` has no position
field to misuse. There is no depth, which is why the glazing evidence is
computed in full and the mirror evidence is not computed at all. When a device
cannot keep up, the analysis RATE comes down and the resolution does not,
because variance of the Laplacian is resolution-dependent and scoring smaller
would silently change what the blur floor means.

## What has never been run

Everything GPU-side. MapAnything, MoGe-2, gsplat, DN-Splatter, RoomFormer and
SAM 3.1 are integrated as they will really run on an L40S, and **none has
touched a real checkpoint**. The riskiest binding is SAM 3.1's Python API,
which is load-bearing in two stages (redaction and semantics); one concept over
ten frames would settle it.

SPZ has only ever been round-tripped against itself. Open one exported file in
PlayCanvas SuperSplat before any paid export, and ship the PLY alongside until
then.

## One thing for a lawyer, not for code

SAM 3.1's licence permits commercial use but is bespoke, and it is load-bearing
in both redaction and semantics. If it turns out to be restricted, redaction
degrades to dilated boxes (already supported) and semantics has no drop-in
replacement.

Licences that are already settled and must stay settled: **never ship
Inria-derived 3DGS code**. The original 3DGS, 2DGS, Mip-Splatting, Scaffold-GS,
SuGaR, MILo and Gaussian Opacity Fields are research-only. gsplat (Apache-2.0)
only. Also avoid YOLO-World (GPL-3.0) and the CC-BY-NC MapAnything checkpoint —
use `facebook/map-anything-apache`.

## Running the tests

```
cd spatial && npx vitest run --no-file-parallelism
cd spatial/pipeline && python -m pytest -q
```

The `--no-file-parallelism` flag is not optional: default parallelism hangs on
this machine. The Python suite needs `opencv-python-headless`, which
`pyproject.toml` declares.
