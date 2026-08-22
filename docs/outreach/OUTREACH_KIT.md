# M3XI Spatial — first-customer outreach kit

**Updated 21 Aug 2026.** Everything here is ready to use tonight, as long as
the demo is described honestly. Two demos, two different sentences:

- **Generated demo (what the QR and the links open today):**
  `https://www.m3xi.com/studio/walkthrough.html?world=generated-bedroom-first-marble-world-a2td&embed=1`
  This world is **AI-generated from a text prompt** (Marble). It is a demo of
  the *viewer* — how walking a space in the browser feels — not a photograph
  of anywhere. Never call it a real room.
- **Real scan (use this when you want to show a captured place):**
  `https://www.m3xi.com/studio/walkthrough.html?world=meadow-valley-enq7&embed=1`
  Meadow Valley is a real phone scan. It is outdoors and has no cover image,
  so it is less of a show-stopper on a phone — but it is true.
- **A real property tour** (360 photographs on a floorplan, `/tour/?t=<slug>`)
  is the actual product for estate agents. **As soon as one exists, it
  replaces both links above in every pitch** — capture one at
  `https://www.m3xi.com/capture/`, check it in `https://www.m3xi.com/tours/`,
  press Go live, and paste the live link here.

**Print piece:** `m3xi-spatial-onepager.html` in this folder — open in Chrome →
Ctrl+P → Save as PDF (A4). The QR opens the generated demo; the one-pager
says so in the copy. Print 30.

> **TODO (owner): reconcile the £200.** Right now the site, the one-pager and
> this kit each describe a *different* £200: the Studio page sells a
> **£200/month Starter plan** (3 live worlds); the one-pager sells a **£200
> one-off build, pay on approval, then £200/month after three months**; this
> kit's scripts say **£200, live in 48 hours, pay on approval**. Pick one
> offer and change the other two to match before anything goes out. This kit
> does not pick for you.

---

## Finding 25 targets (45 minutes, no tools needed)

1. **Estate agents:** Google Maps → "estate agent" centred on your area →
   ignore chains (Foxtons, Savills etc.) → keep independents with 1–2 pins.
   Open their listings on Rightmove: **no 3D tour on their listings = your
   lead.** Note the office address and the owner's name from "About us".
2. **Photo/hire studios:** you know these from modelling — every studio whose
   hire page is a photo grid is a lead. Start with people who know your face.
3. **Galleries:** UAL degree-show venues + any independent gallery within
   walking distance. One free/cheap gallery build = the case study the estate
   agents will ask for.

## The walk-in (the one that closes)

Phone out, demo already loading. Twelve seconds. Two honest versions — say
the one that matches the link on your screen.

**(a) With the generated demo loaded:**

> "Hi — I'm Michael, I run a London 3D studio. Thirty seconds, look at this —
> *[hand them the phone]* — walk around with your thumb. That one is a
> generated demo, so you can feel how the viewer works in a browser, no app.
> Your tour is built from real 360 photographs of your listing — a buyer
> only ever sees what the camera saw. I'll build yours this week — you only
> pay if you like it. Two hundred pounds, live in 48 hours."

**(b) With Meadow Valley, or a real property tour once one exists:**

> "Hi — I'm Michael, I run a London 3D studio. Thirty seconds, look at this —
> *[hand them the phone]* — walk around with your thumb. That's a real place,
> photographed, in the browser, no app. I make these for
> [listings/showrooms/galleries]. I'll build yours this week — you only pay
> if you like it. Two hundred pounds, live in 48 hours."

Objection answers, memorised:
- *"We use Matterport / have video."* → "This runs in the browser from the
  listing itself. One short visit with a 360 camera, no crew, half the
  price — and the enquiry button sits inside the tour."
- *"Send me something."* → hand the one-pager, take THEIR email, send the
  demo link within the hour (template below).
- *"Not now."* → "Completely fine — scan the card whenever. It's the kind of
  thing you get once you've walked one."
- *"Is that AI?"* (if they ask about the generated demo) → "That demo is,
  yes — it shows the viewer. Your tour isn't: it's your rooms, photographed.
  We never put AI imagery in a property tour."

## Cold email (estate agents / studios)

> **Subject: your [Street Name] listing, walkable in the browser — 40-second demo**
>
> Hi [Name],
>
> I make property listings walkable — a tour that runs in the browser from
> the listing itself. No app, no headset, works on any phone:
> [demo link]
>
> [If the link is the generated demo:] That one is a generated demo of the
> viewer. Yours would be built from real 360° photographs of the property —
> one short visit with a 360 camera, no crew.
>
> Give it 40 seconds with your thumb, that's the whole pitch.
>
> I'd like to build one for [their specific property/space] this week. £200,
> pay only on approval, live in 48 hours. Enquiries from inside the tour land
> in your dashboard and by email. If it doesn't earn its place, you
> unpublish or delete it from the dashboard yourself — nothing to untangle.
>
> Michael — M3XI, London
> m3xiteam@m3xi.com · +44 7418 025706 · www.m3xi.com

**Note on "and by email":** enquiries always appear in the dashboard at
`/tours/`. The email copy only goes out once the `RESEND_API_KEY` secret is
set on the Supabase project (Edge Function secrets). Until it is set, drop
"and by email" from the line above — or set the key before you send.

## Instagram DM (studios / galleries — where your network lives)

> Hey [name] — made something you'll want to see. That's a walkable space
> running in a browser: [demo link]. [If generated: it's a generated demo of
> the viewer — yours would be your actual room, photographed.] I'm building
> these for hire studios / galleries — the hire page becomes something people
> can actually walk. Want yours done this week? You only pay if you love it.

## The rhythm

- **Day 1:** print 30 one-pagers, list 25 targets, send 10 emails/DMs.
- **Days 2–4:** 10 doors a day, phone out. Every capture you do, film it —
  "I turned this [café] into a walkable tour" is a UGC clip AND their free ad.
- **Day 5:** follow up every email once, with the prospect's own street named.
- Close 1 of 25 and the machine is proven; raise the price on customer four.

## When they say yes

**Property (estate agent):** one short visit with a 360 camera, no crew.
Open `https://www.m3xi.com/capture/` on your phone, enter the address, take
one 360 photo per standpoint, pin each on the floorplan, upload. In
`https://www.m3xi.com/tours/` the tour is created **unlisted** — open the
preview link, walk it, **share the preview link** for their approval, and
press **Go live** only after they pay. The same dashboard shows every
enquiry and has **Unpublish** (takes it off the public link; preview keeps
working) and **Delete** (removes the tour and its photos; keeps the property
and its enquiries). No AI imagery goes into a property tour, ever.

**Studio / gallery (World Engine scan):** scan with Scaniverse (Splat mode →
Share → Export), build the world in the World Viewer, place hotspots, set the
height, save the fix, **share the private view-key link** for their approval
— publish only after they pay.

Invoice from M3XI (sole trader until the LTD lands), payment by bank transfer
or a Stripe payment link from the dashboard.
