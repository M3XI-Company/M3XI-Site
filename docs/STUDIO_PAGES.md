# The Studio, split by job

`/studio/` was one 1,900-line document holding the hero, the portfolio, image
and video generation, worlds, the business product, the library, the account
panel, credit packs and the roadmap. Everyone downloaded all of it to do any
one thing, and creator pricing sat three scroll-lengths from business pricing.

## The pages

| Page | Job |
|---|---|
| `index.html` | Hub. Hero, a card per bench, roadmap. No generation code. |
| `images.html` | Stills. Prompt, references, **landscape or portrait**, 1 credit. |
| `video.html` | Clips. Shape, 5s/10s, Film mode, link into the Editor. |
| `worlds.html` | Walkable worlds and 3D assets. |
| `editor.html` | The timeline editor. |
| `business.html` | M3XI Spatial. £200 and £500/mo, scanning quoted per site. |
| `library.html` | Published videos and worlds. |
| `pricing.html` | **Creator credits only** — £5 / £20 / £45. |
| `account.html` | Sign in, balance, redeem, profile, referrals. |

Two shared files: `studio.css` (the design system) and `studio-core.js`
(sign-in, the credit ledger calls, the top-up modal, lightbox,
reveal-on-scroll, and every generation handler). Rollup emits both once, so the
second page a visitor opens is nearly free.

## The two money tracks are now genuinely separate

`pricing.html` carries prepaid creator credits and says nothing about £200 or
£500. `business.html` carries the walkthrough plans and shows no credit packs.
Neither page mentions the other's numbers; each links across once, in prose.

**Business plans are still an enquiry, not a checkout.** `m3ix-checkout` only
knows the three one-off credit packs — no `mode=subscription`, no recurring
price, and `stripe-webhook` mints credits on every successful payment, which is
wrong for a monthly plan. Wiring real subscriptions needs a recurring Stripe
price, a webhook branch that grants access instead of credits, and somewhere to
record the entitlement. Worth doing; it was not in this change.

## One script, nine pages

Every page loads all of `studio-core.js` and simply omits the markup it does not
need. `$()` returns an inert stand-in for anything missing, so binding a handler
to a button that is not on this page does nothing instead of throwing and
killing the rest of the file.

Two traps that came with that, both fixed:

* `genMode()` used to be `const s=$('#genMode'); return s?s.value:'backend'`.
  The stand-in is **truthy**, so `.value` returned `''`, no page matched
  `'backend'`, and every generation would have been routed down the
  bring-your-own-key path. It uses `getElementById` now. Same for three profile
  fields.
* The auth client is fetched from a CDN. Loading it with a **top-level await**
  suspends the entire module until the network answers — so a CDN that *hangs*
  rather than fails takes every button on the page with it, silently and
  forever. Verified in a sandbox with jsDelivr blocked: zero handlers bound, no
  error anywhere. It now starts signed-out with an inert client and upgrades in
  the background, and the same sandbox binds every handler.

## Fixed on the way through

Text-to-image only ever produced 1920×1080. The backend has always accepted
`portrait` for 1080×1920 and the UI never sent it — the same bug the video
aspect ratio had. `images.html` now has a shape toggle.

## Old links

Hashes never reach the server, so Vercel cannot redirect them. `index.html`
forwards `#studio`, `#worlds`, `#spatial`, `#library`, `#plans`, `#account`,
`#engines`, `#pipeline` and `#property-tours` client-side.

## Housekeeping

`_to_delete/vercel.json.tmp` is an empty file I created by accident and cannot
remove from here — delete the folder when you next have the repo open.
