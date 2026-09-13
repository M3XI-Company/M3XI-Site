# On hold

Pages taken out of m3xi.com on 13 September 2026, when M3XI narrowed to two
products: **CallMe** (the front page) and **M3XI Spatial** (what M3XI Studio
became: property walkthroughs for agencies).

Nothing in this folder is built or deployed. Vite only builds the pages listed
in `vite.config.js` plus `public/`, and this folder is neither. Old URLs are
redirected in `vercel.json` so shared links still land somewhere.

They were moved with `git mv`, so their history is intact. To bring one back,
move it to its old path and add it to `vite.config.js` again.

| File here | Was served at | Why it is here |
|---|---|---|
| `cornelia.html` | `/cornelia.html` | Cornelia (NoteTaker) is on hold. It was never released on a store; the page was a waitlist. Its Supabase project is paused. |
| `autouv.html` | `/autouv.html` | AutoUV is on hold. Its Supabase project (licences and Stripe checkout) is paused. |
| `products/index.html` | `/products/` | Listed Cornelia and AutoUV. Already unreachable behind a redirect. |
| `callme-waitlist-page.html` | `/callme.html` | Superseded, not paused. It still described CallMe as a dating app with a waitlist; CallMe is live on Google Play and the front page is now about CallMe. |
| `studio/generate.html`, `images.html`, `video.html` | `/studio/generate.html` and the two redirects | Image, video and words generation removed from the Studio. |
| `studio/editor.html` | `/studio/editor.html` | Video editor removed. |
| `studio/pricing.html` | `/studio/pricing.html` | Creator credit packs removed; the business tier is the only pricing. |
| `studio/library.html` | `/studio/library.html` | Published walkthroughs are shown on the Spatial Engine page itself. |
| `public-studio/free.html` | `/studio/free.html` | Free in-browser generation removed. |
| `public-studio/ugc.html` | `/studio/ugc.html` | UGC studio removed. |

## Still deliberately live

- `public/autouv/version.json` and the installers beside it. Copies of AutoUV
  that are already installed check that file for updates; removing it would make
  them error. `public/autouv/index.html` was replaced with a short notice that
  AutoUV is paused and no longer offers the trial.
- The backend actions for image, video and UGC in `m3ix-generate` are still
  deployed. Nothing on the site calls them any more, and with no render box
  connected they refuse without charging.
