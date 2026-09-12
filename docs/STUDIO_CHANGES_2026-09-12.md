# M3XI Studio — what changed, 12 September 2026

**Committed and deployed on 12 September 2026.**

- Site: commits `f347dce`, `63696b4`, `73f86cc` pushed to `main`; Vercel has
  rebuilt. `/studio/generate.html` and `/studio/worlds.html` are live and the
  engine switch works in production.
- Backend: `m3ix-generate` v26 and `m3ix-worlds` v11 are deployed, both with
  `verify_jwt` on. Smoke-tested live: creating a world without an account is
  now refused, the public Library listing still answers, and a request with no
  key at all gets 401.
- **Still not applied: the SQL migration.** See section 3.

---

## 1. The things you asked for

### Spatial and Worlds are one system, called the Spatial Engine

`studio/worlds.html` is now the Spatial Engine. The World Engine display you
wanted kept — Scan, Publish, Share — is still the front of it, retitled around
property: scan with Scaniverse, it is measured once, share one link, enquiries
land in your dashboard.

Under it: an estate-agent card (the viewing before the viewing, captured on the
phone you own, measured not guessed, yours to embed), then the generator, then
the Library.

- Nav everywhere is now **Free · Generation · Spatial · Editor · UGC · Library ·
  Business · Pricing**. "Worlds" as a separate destination is gone.
- The viewer (`walkthrough.html`) is reached from the Spatial page rather than
  from the nav, because it is the tool, not the front door.
- The two pages no longer contradict each other. One set of prices (150 final,
  40 draft, 15 an object), one set of model ids, one honesty rule stated the
  same way on both: scanned places are a record, generated places carry the
  AI-generated label everywhere they appear.
- The dead "Direct fal.ai (bring your own key)" option is gone from the advanced
  panel. Direct mode was removed from the code months ago; the control stayed
  on the page doing nothing.

### Images and Video are one bench called Generation

New page `studio/generate.html`. One prompt box, one set of attachments, one
credit field, one output panel, and a switch across the top:

| Engine | What it does | Price shown |
|---|---|---|
| Image | a still, landscape or portrait | 1 credit |
| Video | 5s or 10s, any shape, plus Film mode | 60 / 120 credits, follows the length you pick |
| Words | listing copy, a script, captions, a shot list | 2 credits |

Switching engines keeps what you typed. The choice rides in `?mode=` so a link
can open straight into video, and it is remembered per browser.

`images.html` and `video.html` are now redirects into it, so every old link,
bookmark and search result still works.

### A prompt-polish toggle above every prompt

"Sharpen my prompt first", off by default, on the Generation bench and on the
Spatial Engine, and inside the viewer's own composer. On, your words are
rewritten for the engine you picked, and **the rewrite is printed so you can see
what was actually sent**. A prompt that is silently replaced makes a bad result
impossible to diagnose.

It never blocks: if the language model is down, your own words go through.

It is genuinely free. It runs on the Groq free tier, and rather than trust that,
the backend now refuses to sharpen at all if the free model is unavailable
instead of quietly falling through to a paid one. See the bug list: as first
written today it would have charged 2 credits while the page said Free.

### Anything you generate can go to the Editor

Images now get an "Open in the Editor" button next to "Open full size", the same
as video already had. Words and places do not, which is what you said.

While doing this I found the Editor destroyed your saved timeline whenever
something arrived from the Studio — it skipped restoring the autosave if the
inbox had anything in it, then overwrote it. Send one image over and an
afternoon's editing was gone. Fixed: it restores first, then adds.

### The free tier, gated at seven days

Day 1 to 7: exactly as now, unlimited, no account.

After seven days, signed out: a letter saying so, with "Create a free account"
and "See what the paid Studio does". The tools ask for an account before they
run.

After seven days, signed in: once a week, a letter asking whether to carry on
free or move up, with both answers as buttons.

It fails open. Every storage read is wrapped, and a failure leaves the page
working — nobody is ever locked out because private mode ate localStorage.

**Worth being straight about:** this is a sign-up gate, not a cost control. The
free tier runs in the visitor's browser and costs you nothing however much it is
used. Its value is conversion and knowing who is using it.

### Attachments look like files

Each attachment is now a card: the thumbnail, the real file name, the folder it
came from, the size, and a remove button in the same place every time. Eight
photos of one room used to be eight identical squares.

### UGC

Left exactly where it is, as you said.

---

## 2. Bugs fixed

A read-only sweep of the whole Studio (eight agents: pages, shared script, both
edge functions, the database, and cost) returned **143 findings — 10 critical,
35 high**. The full notes are in the scratchpad; these are the ones now fixed.

### Money

1. **Images and video charged for work nothing could ever do.** With the paid
   provider off, both queue to the render box. No box has ever checked in
   (`m3ix_workers` is empty), nothing drains the queue, and there is no timeout
   anywhere — so the charge stood for ever while the page said it would finish.
   Now: if no box has ever connected, it refuses and **does not charge**. If one
   exists but is off, it still queues, and a job nobody claims within six hours
   is failed and refunded automatically.
2. **A Marble world that failed after submitting was never refunded** — and the
   viewer told you it had been. The charge happens at submit and the only refund
   was for an immediate error, but real failures arrive minutes later. Now the
   poll that first sees the failure issues the refund, once.
3. **A network blip after the charge kept the money.** The provider call had no
   try/catch, so a dropped connection threw past every refund line. Wrapped.
4. **Any user could run any expensive model at the cheap price.** The model name
   came from the request, validated only as "starts with fal-ai/", while the
   price was decided by a substring. Replaced with an allowlist for image, video
   and 3D.
5. **The same world could be imported over and over**, re-downloading hundreds
   of megabytes into storage each time, with no ownership check. Now recorded
   against the operation id: a repeat returns the world you already have.
6. **The real cost was never recorded.** Every world was logged at a flat $1.00
   estimate; the finished operation carries the settled figure, which for
   1.1-plus can be $2.48. Now recorded from the operation.
7. **Worlds were imported at preview quality.** The code asked for
   `spz_urls.default`, a key that does not exist, and fell back to whichever the
   provider happened to list first — plausibly the 100k preview instead of the
   two-million-splat world. **This may well be the softness you have been
   blaming on Marble.** Now asks for `full_res` and works down.
8. **Metric scale was being guessed.** Every world ships
   `metric_scale_factor` and `ground_plane_offset`; both were ignored while the
   viewer measured the ceiling and normalised it to 2.45 m. Now carried on the
   world; the measured guess stays as the fallback for pre-December-2025 worlds.
9. **The rate limit was unhandled.** Three generations a minute is the cap and
   the house builder fires one per room in a loop. A 429 now says wait, and says
   the money came back.

### Security

10. **Stored cross-site scripting in the Library.** A maker's profile website
    went straight into an `href`, so any account could publish a world whose
    byline ran script in every visitor's browser. Only http and https become
    links now.
11. **Anyone could create worlds without an account** — the anon key is in the
    page — which minted an edit key, and that key unlocked `rehost`, an
    unbounded fetch of any URL into your public bucket. Creating now needs a
    signed-in user, and rehost is capped at 60 MB.
12. **Enquiries from a world reached nobody.** Worlds were created with no
    owner, so the notifier had no address to send to, while the visitor was told
    it had been sent. Worlds now record their owner.
13. **Two more script-injection holes in the Editor**, through a media name or
    an opened project file. Escaped.
14. **A SQL migration is written but not applied** (see below) for the database
    findings: the anon role holds INSERT, UPDATE, DELETE and **TRUNCATE** on
    around twenty-two tables including the credit ledger, and the public tour
    view is writable through to the table underneath.

### Things that plainly did not work

15. **Enter never generated anything.** The prompt box read a selector that
    exists on no page, so every Enter answered "write what you want first" over
    a full prompt box, and because Enter is intercepted you could not even get a
    newline. Fixed, and on the Generation bench Enter now sends to the engine
    you picked.
16. **"See credit packs" did nothing** on the only pages that show the
    out-of-credits dialog. It scrolled to an anchor that exists only on the
    pricing page. Now it goes there.
17. **"Sign in" in the nav was a dead link** on six of seven pages, for the same
    reason.
18. **Check balance on the pricing page always said "enter a code first"**,
    whatever you typed, because that page names its field differently.
19. **The pricing page swallowed every checkout message**, including failures.
20. **About a thousand database round trips per world.** Every six-second poll
    refreshed the whole account panel to redraw a balance that had not moved.
    Now only when it changes, or once a minute.

---

## 3. Not fixed — these need you

| # | What | Why it is yours |
|---|---|---|
| 1 | **Apply the SQL migration** `supabase/migrations/20260912093000_lock_anon_writes_and_dedupe_credits.sql` | It revokes anon writes across the schema. I did not run it against your live database: if something legitimately writes as anon that I did not find, it would break. It is written to be safe (SELECT untouched, the waitlist keeps its INSERT) and it reports rather than fails. Read it, then run it. |
| 2 | **100,687 unbacked credits count as real money** | Your own redeemed owner code is treated as paid balance, and at 150 credits a world that is $848 to $1,664 of Marble spend available. Either exclude that ledger row from `m3ix_paid_balance` or cap daily provider spend. It is a business decision, not a bug. |
| 3 | **No kill switch on Marble** | `M3IX_PROVIDER_ENABLED=false` turns off fal only. World generation and the Street View lookup still bill with the provider "off", and the comment at the top of the file says otherwise. Worth a `M3IX_WORLDS_ENABLED` flag. |
| 4 | **Stripe: credits are granted by the thanks page only** | If the buyer closes the tab, nothing credits. There is a `stripe-webhook` deployed that is not in this repo. Get it into git, then decide which one grants. |
| 5 | **`exterior` spends Google's quota for zero credits** with no per-user limit. |
| 6 | **Business plans are still an enquiry, not a checkout.** No recurring Stripe price exists. |
| 7 | **Three different £200 offers** across the site, the one-pager and the outreach kit. Pick one. |

---

## 4. On cost, which you asked about

**Where you are now.** The floor is Supabase's free tier plus Vercel's hobby
tier, so roughly £0 a month standing. The only thing that bills per use is
Marble at $1.26 to $2.48 a world, plus a few pence of Street View. Groq is free.
The free tier is free because it runs in the visitor's browser.

**£20 buys about fifteen finished worlds, or fifty drafts.** Drafts are 40
credits and cost you 12 to 20 pence; a finished world is 150 credits and costs
you $1.26 upward. At 4.5p a credit you charge £6.75 for a world that costs you
about £1, which is a healthy margin as long as nothing spends without charging.
Every fix in section 2 protects exactly that.

**What I would do with £20 to £50:**

- Apply the migration and the code in this change. Most of the leaks are
  charging-without-delivering, which cost you customers rather than cash, but
  the unauthenticated rehost and the unbacked credits could cost real money.
- Leave the paid provider off. Images and video now refuse cleanly instead of
  taking credits for a queue that does not move.
- Push drafts. Generating a draft first and the finished version only when the
  idea holds up is the single biggest lever on cost, and the Spatial Engine's
  model dropdown now says so.
- Set `GROQ_API_KEY` if it is not set. Words, prompt sharpening and floor-plan
  reading all run on it and it costs nothing.
- The Supabase project auto-paused on 7 September from inactivity and took the
  site down. Either accept that or budget $25 a month for Pro before you have
  paying customers on it.

**What does not scale and would need money:** video and images need a GPU. They
are off. If a customer wants them, rent by the second rather than buying a card
— a 24 GB GPU is about 34 cents an hour on RunPod, so a three-minute render is
under two pence. That is a change to `worker.py`'s deployment, not to the
Studio.

---

## 5. Deploying

Site and functions are done. The one thing left is the migration, and it is the
only step that touches live data.

Open the Supabase dashboard, go to the SQL editor, paste
`supabase/migrations/20260912093000_lock_anon_writes_and_dedupe_credits.sql`
and run it. Read it first: it revokes write access from the anonymous role
across the schema. It leaves every SELECT alone and gives the waitlist form back
its INSERT, so the public site keeps working, but if something else writes as
anon that I did not find, that is where it would show.

Afterwards the two checks at the bottom of the migration should both come back
empty, and the waitlist form on m3xi.com should still take an email.

### Notes for next time

The Supabase CLI is authenticated on this machine even though there is no token
file — it uses the Windows credential store — so `npx supabase functions deploy
<name> --project-ref tnlcuptfldwxtxajudoq` works without logging in.

It has a `--no-verify-jwt` flag and **no opposite**. Passing it by accident turns
the gateway check off, and a plain redeploy does not restore it, because the API
keeps whatever was last set. That happened to m3ix-generate during this deploy
and was caught and fixed within a minute. `supabase/config.toml` now pins
`verify_jwt` for every function, so a deploy cannot change it again.
