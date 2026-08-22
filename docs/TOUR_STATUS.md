# Property tour — status (22 Aug 2026)

> Phase 1 (360 tours) and Phase 2 (walk a real scan inside a room) are both built and deployed. Neither has yet carried a real property: the database still holds 0 tours. See "Not done" below.

What is live, how each item was verified, what is not done, and what the owner has to do next. Outcomes only.

## Live

| Piece | Where | State |
|---|---|---|
| Buyer viewer | `https://www.m3xi.com/tour/?t=<slug>` and `/tour/<slug>` | Full-sphere panoramas (three.js), yaw/pitch/zoom, gyroscope on phones, floor arrows between linked standpoints, cross-zoom moves with preload (no black frame), floorplan minimap with view cone, room strip, agency branding, "Photographed <date>", Enquire (only says Sent on a real ok), Share + embed snippet, flat CSS fallback when WebGL is off. Deployed `dpl_CzL3hxn3ffRGYzEhUT1Y37nM5Xvx`. |
| Share previews | `/tour/<slug>` via `api/tour.js` + `vercel.json` rewrite | og:title / description / image / url, noindex for unknown or unlisted tours. Live probe: `/tour/nope` → 200, 4 og tags, robots noindex, viewer shows "We can't find that tour." |
| Listing embed | `https://www.m3xi.com/tour/embed.js` | `<script src=… data-tour="<slug>" async>` writes a responsive 16:9 iframe. |
| Agent capture | `https://www.m3xi.com/capture/` | One 360 photo per standpoint (2:1, ≥ 2048×1024 enforced), rooms, floorplan + pins, north calibration ("turn until you face the neighbour"), XMP GPano prefill, IndexedDB persistence and resume, background uploads with retry, finish → unlisted preview → Go live. Phone-spin capture removed. |
| Agent dashboard | `https://www.m3xi.com/tours/` | List, preview, go live, unpublish, archive, delete (purges storage), rotate preview key, branding, room names, draggable pins, walk links, opening view, embed snippet, enquiries with delivery state. |
| Backend | `m3ix-spatial` v9 (Supabase edge function, source in `supabase/functions/m3ix-spatial/`) | Identity from the caller's JWT + org membership on every member action (401 before any lookup); nodes model; private `tours` bucket with signed URLs; `lead` action keyed on tour slug; lifecycle actions. Contract in `docs/TOUR_API.md`. |
| Lead delivery | `m3ix_lead_notify` trigger (pg_net) → `m3ix-lead-notify` function | Emails the agency via Resend when `RESEND_API_KEY` is set; otherwise writes `notify_error` on the lead, which the dashboard shows. |
| Security | DB migration `20260821190000` | `m3ix_spaces.edit_key` and `m3ix_tour.view_key` no longer readable by the anon role (was: every published world's edit key readable by a plain GET); anon cannot read/write `m3ix_tour`, `m3ix_leads`, `m3ix_node`. |
| AI-world honesty | `public/studio/walkthrough.html` | Permanent "AI-GENERATED — NOT A RECORD OF A REAL PLACE" mark on Marble worlds (verified live on the outreach demo), tab title from the world name, real credit prices (150/300), Best-quality scoring uses the real hole % (was a constant 999), Unpublish button, Library AI badges. `world-ha3u` / `world-nwye` (untitled test generations) set to draft. |
| Site copy | `index.html`, `studio/index.html`, outreach kit, one-pager | No links to draft worlds; generated worlds labelled generated; property-tour block in `#spatial` linking `/capture/` and `/tours/`; account panel links; plans no longer list lead export / API access; kit and one-pager no longer call a Marble world "a real room". |

## How it was verified

- Backend: anonymous POSTs to every member action → 401 (`Sign in to do that.`), public `manifest`/`og`/`lead` → 404 for an unknown slug; anon REST GET on `m3ix_spaces.edit_key` → `permission denied`; `m3ix_library` / `m3ix_featured_world` / worlds `load` still answer anonymous callers.
- Viewer: driven in a browser against a mock manifest with synthetic labelled panoramas — yaw 0 centred on the "front" label; arrival yaw into the kitchen = 90; arrow bearings hall→kitchen 71.57°, kitchen→hall −18.43°, kitchen→bedroom −90°, kitchen→kitchen 2 −156.04° (all match hand calculation in plan pixels); 4 textures held; plan cone 0° when facing north; Enquire validation; flat fallback; embed=1 chrome; 375 px layout.
- Capture: driven with the synthetic test set via the dev mock — validation rejects non-2:1 images, IndexedDB restore after reload, pins stored as fractions, calibration stores `north_deg = yaw − bearing`, XMP heading prefill, manifest matches `docs/TOUR_API.md` field for field, failed-upload retry and resume, 401 → in-page sign-in and resume, PDF floorplan rendering.
- Dashboard, OG function, splat viewer, site copy: each built and then independently reviewed (code read against the contract + browser run); reviewer fixes applied.
- Build: `node --check` on every script, `vite build` clean, Vercel production deployment READY, live probes of every route.

## Not done / not verified

1. **Signed-in end-to-end run.** Nobody has yet run register → upload → preview → go live → enquiry against production with a real session. Needs the owner's login. The synthetic panoramas in the session scratchpad are valid 2:1 images and can be used for a smoke test; delete the tour afterwards from `/tours/`.
2. **Real 360 photographs.** No property has been captured with a 360 camera yet. The demo on the outreach surfaces is still the (now labelled) AI world; replace it with the first real tour.
3. **Email.** `RESEND_API_KEY` (and optionally `LEAD_FROM` with a verified domain) must be set as Supabase function secrets before any lead email goes out. Until then leads appear in `/tours/` with the reason shown.
4. **Auth redirect allow-list.** Add `https://www.m3xi.com/capture/` and `https://www.m3xi.com/tours/` to Supabase Auth → URL Configuration → Redirect URLs, or magic links will land on the site URL instead of the page the agent started on.
5. **Phone hardware.** Gyroscope look, pinch zoom and the capture flow on iOS Safari / Android Chrome were not exercised on a device.
6. **Pricing.** The site, one-pager and kit still state three different £200 offers; reconciling them is the owner's decision (TODO left in the kit).
7. **Phase 3** (an owned video-to-splat reconstruction pipeline) is not started, by design. **Phase 2 is built** — see the section below.

## What the owner has to do next

- Set `RESEND_API_KEY` (+ `LEAD_FROM`) in Supabase → Edge Functions → Secrets.
- Add the two redirect URLs above in Supabase Auth.
- Sign in on a phone, open `/capture/`, and run one real property with a 360 camera (or the synthetic set as a smoke test). Preview, go live, send a test enquiry, confirm the dashboard shows it.
- Point the outreach kit / one-pager QR at that first real tour and retire the AI demo from the pitch.


---

# Phase 2 — walk a real room

A room in a tour can now carry one **real** Gaussian-splat scan (Scaniverse "Splat mode" or similar). The buyer gets a "Walk this room" button and walks it first-person, in the same page, with the same branding, minimap and Enquire. The 360 standpoint stays the default and the fallback.

## What ships

| Piece | Where |
|---|---|
| Measuring a scan | `public/tour/scanfacts.js` + `public/tour/splatparse.js` — pure modules (no DOM, no WebGL) that read splat centres out of a `.ply`/`.splat` and work out the up-axis, floor plane, walkable grid, spawn point and hole percentage. Runs in node, a worker or the page. |
| Attaching one | `/tours/` — the agent picks a file, it is measured **in a worker before anything is uploaded**, the result is shown (area, holes, which way was up), and only then are the scan and its `facts.json` uploaded and attached. |
| Walking it | `public/tour/walk.js` — dynamic Spark/three import, applies the stored facts, WASD + pointer-lock on desktop, joystick on touch, capsule collision from the stored grid, Exit back to the 360 standpoint. |
| Backend | `m3ix-spatial` v9: `scan_upload_url`, `attach_scan`, `remove_scan`; `manifest`/`get_tour` sign the scan and its facts. |

**The facts are computed once, at attach time, and stored.** Until now the same heuristics ran in every visitor's browser on every load, giving different answers each visit with nobody ever seeing them. The viewer now reads; it never guesses.

**Holes stay holes.** Nothing fills, in-paints or generates. The viewer says so in frame: "Scanned <date> — areas the camera could not see are left empty."

## Verified

- **Against the real 91.5 MB office scan (369,006 splats, a genuine phone capture):** up-axis `z,-1` with a 2.41× margin — matching `walkthrough.html`'s own recorded figures for this exact file (x 0.027 / y 0.031 / z 0.057) — 88 walls found where the old Y-up assumption found **zero**, 8.4 m² walkable, 3.3% holes, spawn standing on the measured ground plane. Measured in 200 ms; `facts.json` is 151 KB for an 87 MB scan.
- **Synthetic rooms with known answers**, in three orientations (Y-up, +Z-up, −Z-up): the up-axis and direction are found in all three, the same room measures identically after rotation, walls and a wardrobe block, the doorway is open. 39 assertions, 0 failures (`scratchpad/harness/facts.mjs`).
- **Two defects found and fixed during integration**, both caught by tests rather than by reading:
  1. *The room hung from its own ceiling.* Turn a room upside down and its ceiling scores **higher** than its floor (5.56 vs 4.52), because the real floor above then looks like a ceiling. Fixed by porting the original's gravity test — things rest on floors and hang from nothing — as a tie-break on the winning axis. On the real scan it agrees independently (rest-ratio 5.12 vs 0.31).
  2. *You could walk through the walls.* The "enough structure" bar was a flat 2% of cells, far below what encloses a room, so the self-tuning threshold could dissolve the walls to 24 stray cells and still win on area — reporting 20.2 m² of walking in a room whose entire floor is 20 m². Replaced with a geometric bar (about half the region's own perimeter). The real scan was unaffected; the synthetic went from 24 walls/20.2 m² to 134 walls/15.1 m².
- **A third defect found by review and fixed in the core:** `canStand` allowed 3,401 cells (87 m²) whose floors spanned **17 m**, while the agent and buyer were promised 8.4 m². A buyer could walk off the floor and fall metres into scan halo. Movement now honours `reach` — the region we actually measured — so the promise and the permission are the same set: 327 cells, floor spread **0.00 m**, and **zero** adjacent steps exceeding the 0.38 m a body can climb (down from 1,810).
- Backend deployed (v9) and probed live: `scan_upload_url`, `attach_scan` and `remove_scan` all answer **401 before any lookup** to an anonymous caller and to a caller with no auth header at all; `manifest` and `og` still serve the public.
- The dashboard's attach flow was driven end to end in Chrome by its builder and re-driven independently by its reviewer against the real scan: staged measurement in a worker, the review card before upload, refusals with **zero bytes read** for a `.txt` and for an over-cap file, a 600-point scan refused with no upload control offered, the exact `facts.json` blob and `m3ix_room.scan` row inspected against the contract, and remove deleting both objects.

## Not verified

1. **I did not see walk mode render.** The browser pane in my environment reports `visibilityState: hidden`, so `requestAnimationFrame` never fires and Spark's decode of the 91 MB scan cannot complete. Both files downloaded, the renderer canvas was created, and the chrome was correct ("Kitchen — walking the scan", "PHOTOGRAPHED 21 AUG · SCANNED 20 AUG", the honesty line, Exit and Back-to-start). Walk mode itself **was** driven successfully in a browser by its builder and independently re-measured by its reviewer (look direction, spawn on the floor, walls stopping, exit, flat memory across three enter/exit cycles) — that is their verification, not mine. A 90 s watchdog turns a stalled load into a plain-language failure rather than a hang.
2. **The `reach` change post-dates those browser runs.** It is verified by measurement in node (numbers above) and it only ever *restricts* movement to the measured region, but nobody has walked the result on screen.
3. **No real signed-in run.** Nothing has gone through `scan_upload_url` → PUT → `attach_scan` against the live backend with a real session and a real 91 MB upload.
4. **Known and accepted:** furniture shorter than the knee-to-head band (a 0.75 m desk) does not become a wall, inherited from the tuned original. A 1.8 m wardrobe does block. Recorded in the test output rather than hidden.
5. One unhandled promise rejection per walk exit, from Spark's own async readback landing after teardown. No functional effect; not swallowed behind a global handler.

## What the owner has to do next

Everything in the Phase 1 list still applies (Resend key, auth redirect URLs, first real capture), plus: to try Phase 2, scan one room with Scaniverse in **Splat mode**, export **`.spz`** (about a tenth the size of a `.ply` — the buyer downloads this file), and attach it to that room in `/tours/`. Quote walk-through per room and "subject to rescan"; never inside the 48-hour promise.
