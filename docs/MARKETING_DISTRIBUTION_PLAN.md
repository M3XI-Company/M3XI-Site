# M3XI — Marketing & Distribution Plan

**Written:** 10 August 2026 · **Products:** M3XI Studio (flagship), CallMe, Cornelia
**Positioning spine:** *One studio, three doors.* The Studio is the main service; the apps are proof it ships real software.

---

## Part 1 — Positioning

| Product | One-liner | Audience | Hook that wins |
|---|---|---|---|
| **M3XI Studio** | Type an idea, get a film | Creators, anime/recap channels, small brands | The output *is* the ad — every demo video is a billboard |
| **CallMe** | Dating by voice, not swiping | 18+ singles, UK first | **Every profile is ID-verified 18+** — no catfish, no minors. Nobody else leads with this |
| **Cornelia** | Lectures → calm Cornell notes | University + college students | Record on your phone, revise from real notes — timed to September intake |

The company story ties them: a model-engineer studying Creative Robotics at UAL built all three (the /michael/ page is the persona anchor for press and socials).

---

## Part 2 — Marketing campaign (90 days)

### Phase 0 — Foundations (this week)
- ✅ m3xi.com now leads with the Studio; /studio/, /michael/ live after deploy.
- Consolidate socials: bios of Instagram (@m3xicorp), TikTok (@m3xicorp), LinkedIn (company/111653431) all point to m3xi.com; contact everywhere is **M3xiTeam@m3xi.com**.
- Set up UTM links (`?utm_source=tiktok&utm_campaign=studio-launch`) so waitlist signups are attributable.
- **Dogfood rule:** every ad and teaser for Cornelia/CallMe is *made in the Studio pipeline*. One production line, two outcomes: content + proof the Studio works.

### Phase 1 — Weeks 1–4: waitlists become armies
- **Cornelia:** turn the waitlist into the Play **closed-testing pool** (Google wants sustained testers before production anyway — the marketing funnel IS the compliance funnel). Email: "You're not on a waitlist any more. You're a tester. Here's the link."
- **CallMe:** seed **one city (London)**. Voice-dating dies without density; 200 verified Londoners beat 2,000 scattered users. Campus + nightlife micro-influencers (1–10k followers, cheap/gifted collabs).
- **Studio:** open "founding seats" — early access with founding pricing, capped. The `m3xi_access_codes` table already exists; invite codes make scarcity real.

### Phase 2 — Weeks 5–8: content engine
Weekly cadence, all shorts-first (TikTok / Reels / YT Shorts):

| Day | Post | Product |
|---|---|---|
| Mon | Studio render of the week (prompt shown on screen) | Studio |
| Wed | "POV: your lecture became notes while you slept" demo | Cornelia |
| Fri | Voice-first dating skit / "we banned swiping" | CallMe |
| Sun | Founder build-log (Michael on camera — model + engineer is the algorithm's dream) | Company |

- Outreach: 20 anime-recap YouTube channels get a free founding Studio seat in exchange for "made with M3XI Studio" credit. Their uploads are your distribution.
- Reddit/Discord (r/GetStudying, r/UniUK, student Discords): genuine posts from the tester pool, never astroturf.

### Phase 3 — Weeks 9–12: launch windows
- **Cornelia public launch: mid-September** (UK freshers). App-store feature pitch angle: "built by a UAL student who taught kids to code."
- **CallMe launch: October** (cuffing season begins; dating-app installs climb into Q4). PR angle for UK tech press: *the first UK dating app with mandatory ID verification* — safety regulation is front-page material right now.
- **Studio: rolling** — every good user render gets reposted; monthly "best of the Studio" cut.
- Budget tiers: £0 = organic above; £250/mo = boost the best-performing organic short per product; £1,000/mo = add Meta/TikTok prospecting for CallMe London + Cornelia student lookalikes.

### Metrics that matter (weekly dashboard)
- Waitlist → tester conversion (Cornelia), verified signups in London (CallMe), founding seats claimed (Studio)
- D1/D7 retention per app; first-100-calls completion rate (CallMe); renders per seat (Studio)
- One kill-rule: any channel with <1% conversion after 3 weeks gets cut.

---

## Part 3 — Distribution plan

### The Google problem, honestly
Both apps are stuck at Google approval. That pain is real but *different* per app:

- **Cornelia** is already in **closed testing** — it's most of the way through the gauntlet. Finishing costs console work (Data Safety, content rating, GDPR message, targetSdk 36 build), not luck. **Do not abandon a 70%-complete runway.**
- **CallMe** is a *dating app with UGC* on a young developer account — the hardest category Google reviews. Expect friction: dating category policy, UGC moderation evidence, ID-verification data handling declarations.

### Recommendation: split the strategy, don't "switch" it

**1. Cornelia → finish Google now (Android-first stands).**
September intake is the whole year's best window; iOS can follow in Q4 via EAS.

**2. CallMe → Apple-first pivot (yes, migrate the lead platform).**
Why Apple is actually the *easier* road for CallMe:
- Apple's dating-app rules are strict but **predictable and documented**; Google's review of a new dating app is opaque.
- The hard Apple requirements are **already built**: report/block ✅, ID verification ✅, 18+ gate ✅, moderation hooks ✅, ATT pattern known from Cornelia ✅.
- iOS dating users monetise materially better (your £6.99/mo premium lands softer there).
- TestFlight gives a 90-day, 10,000-tester beta with *no equivalent of the Play testing gauntlet* — London seeding can start weeks earlier.

Cost of entry: Apple Developer **$99/yr**, `APPLE_SHARED_SECRET` into Supabase secrets, iOS build via EAS (no Mac needed), App Privacy declarations. Keep the Play submission alive in parallel — worst case Android simply launches second.

**3. Studio → the web. No gatekeeper at all.**
The Studio is a web platform: deploy, take Stripe payments, done. **No store review, no approval risk, and it's the only product with revenue infrastructure already written** (credit packs + ledger + edge functions). The fastest legal money in the company is: fund fal.ai (~$10) → first render → founding seats. Make the Studio the revenue engine that funds the app-store war.

### Sequenced timeline

| When | Cornelia | CallMe | Studio |
|---|---|---|---|
| Aug W2 | Prebuild (targetSdk 36), upload to closed testing | Apple Dev account; eas.json ✅; iOS build via EAS | Fund fal.ai; first render on record |
| Aug W3–4 | Testers from waitlist; Data Safety + rating + GDPR msg | TestFlight beta, London seeding; keep Play internal-testing track warm | Deploy web app; Stripe live keys; invite codes |
| Sep | **Apply for production; launch at freshers** | Grow TestFlight cohort; App Store submission end-Sep | Founding seats public; recap-channel outreach |
| Oct | iOS build starts | **App Store launch (cuffing season)**; Play resubmission with traction evidence | First "best of Studio" showcase |

*Traction evidence matters:* a live, moderated iOS deployment with real users is the strongest artifact you can attach to a Google appeal.

### Console prerequisites (the boring gates — all owner-action)
1. `DIDIT_WEBHOOK_SECRET` → Supabase (CallMe) — verification callbacks currently 78/78 failed.
2. AdMob apps created under admin@m3xi.com + real IDs into both app.json files + GDPR message + payment profile.
3. Didit top-up (balance $9.20, alert threshold $10).
4. GIPHY production key (beta = 100 calls/hr).
5. Play: Cornelia versionCode bump, both apps' Data Safety forms.
6. Apple: $99 enrolment, shared secret, App Privacy ("Used to Track" = Yes for Cornelia with ads).
7. Sightengine (or keep photos unmoderated at your own policy risk — not recommended for a dating app).

---

## Part 4 — This week's five moves
1. Deploy the new site (Studio-first) — it's built and verified locally.
2. Set `DIDIT_WEBHOOK_SECRET` (2 minutes, fixes a 100% failure rate).
3. Enrol Apple Developer + kick off the first CallMe iOS build on EAS.
4. Upload Cornelia's targetSdk-36 build to closed testing and email the waitlist.
5. Put $10 into fal.ai and press render on the Studio's first film.
