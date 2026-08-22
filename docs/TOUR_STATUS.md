# Property tour — status (22 Aug 2026)

What is live, how each item was verified, what is not done, and what the owner has to do next. Outcomes only.

## Live

| Piece | Where | State |
|---|---|---|
| Buyer viewer | `https://www.m3xi.com/tour/?t=<slug>` and `/tour/<slug>` | Full-sphere panoramas (three.js), yaw/pitch/zoom, gyroscope on phones, floor arrows between linked standpoints, cross-zoom moves with preload (no black frame), floorplan minimap with view cone, room strip, agency branding, "Photographed <date>", Enquire (only says Sent on a real ok), Share + embed snippet, flat CSS fallback when WebGL is off. Deployed `dpl_CzL3hxn3ffRGYzEhUT1Y37nM5Xvx`. |
| Share previews | `/tour/<slug>` via `api/tour.js` + `vercel.json` rewrite | og:title / description / image / url, noindex for unknown or unlisted tours. Live probe: `/tour/nope` → 200, 4 og tags, robots noindex, viewer shows "We can't find that tour." |
| Listing embed | `https://www.m3xi.com/tour/embed.js` | `<script src=… data-tour="<slug>" async>` writes a responsive 16:9 iframe. |
| Agent capture | `https://www.m3xi.com/capture/` | One 360 photo per standpoint (2:1, ≥ 2048×1024 enforced), rooms, floorplan + pins, north calibration ("turn until you face the neighbour"), XMP GPano prefill, IndexedDB persistence and resume, background uploads with retry, finish → unlisted preview → Go live. Phone-spin capture removed. |
| Agent dashboard | `https://www.m3xi.com/tours/` | List, preview, go live, unpublish, archive, delete (purges storage), rotate preview key, branding, room names, draggable pins, walk links, opening view, embed snippet, enquiries with delivery state. |
| Backend | `m3ix-spatial` v8 (Supabase edge function, source in `supabase/functions/m3ix-spatial/`) | Identity from the caller's JWT + org membership on every member action (401 before any lookup); nodes model; private `tours` bucket with signed URLs; `lead` action keyed on tour slug; lifecycle actions. Contract in `docs/TOUR_API.md`. |
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
7. **Phase 2 (walk a real scan inside a tour)** and Phase 3 (owned reconstruction) are not started — by design, they wait for Phase 1 to be sold.

## What the owner has to do next

- Set `RESEND_API_KEY` (+ `LEAD_FROM`) in Supabase → Edge Functions → Secrets.
- Add the two redirect URLs above in Supabase Auth.
- Sign in on a phone, open `/capture/`, and run one real property with a 360 camera (or the synthetic set as a smoke test). Preview, go live, send a test enquiry, confirm the dashboard shows it.
- Point the outreach kit / one-pager QR at that first real tour and retire the AI demo from the pitch.
