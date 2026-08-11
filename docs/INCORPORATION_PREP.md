# Registering M3XI — everything decided in advance

**Written 11 August 2026.** This is preparation, not filing. You do the filing —
it needs your identity documents and your card, and neither of those is
something I handle. Work top to bottom and the actual submission takes about
twenty minutes.

This is general information from official guidance, not legal or tax advice. The
company structure below is the ordinary default for a one-person UK software
company; if the tax side matters to you, an hour with an accountant is worth it.

---

## Why this is on the critical path

Your Google Play account is an **organisation** account. Organisation accounts
are exempt from the 12-testers-for-14-days closed-testing gate — which is
exactly what is blocking Cornelia and CallMe right now — but they are verified
against a **real registered business**. Google's own wording: a mismatch means
the account is restricted, "which would remove all of your apps from Google
Play."

So this is not admin. It is the fastest route to production, and it is also the
thing that removes your apps if left undone.

It also clears two other blockers already sitting in the plan: the M3XI Spatial
business plans (£200–£500/mo) cannot be invoiced by an unregistered trader, and
the homepage currently says "M3XI isn't a registered company yet" a short scroll
from those prices.

---

## Step 0 — verify your identity FIRST (this is new, and it blocks everything)

Since **18 November 2025** every director and every person with significant
control must verify their identity with Companies House *before* the company can
be incorporated. You cannot complete a registration without a **Companies House
personal code**.

- Do it at **GOV.UK One Login**, free, ~10–20 minutes with a UK passport via the app.
- You come away with a personal code. Keep it — you will paste it into the
  incorporation form.

Doing this out of order is the single most common way a same-day incorporation
turns into a week.

---

## Step 1 — the name

**M3XI LTD** (or M3XI LIMITED — identical in law, pick on looks).

Checked on the Companies House register on 11 Aug 2026: **no company matches
"M3XI"**. The name is free.

One thing to know rather than worry about: 838 companies contain "MEXI"
(MEXI ALLIANCE LTD, MEXIS LIMITED and so on). The published "same as" rules
disregard case, spacing, punctuation and treat a number word and its figure as
equal ("Three" = "3") — they do **not** say the digit 3 counts as the letter E.
So M3XI should register cleanly. Separately, any existing company can later
object that a name is *too similar* via the Company Names Tribunal. Nobody
trading as "Mexi-" in food or facilities is a plausible objector to a software
studio, so this is a note, not a risk.

**Worth doing at some point, not now:** a UK trade mark for M3XI in class 9
(software) and class 42 (SaaS). Registering the company does not protect the
brand.

---

## Step 2 — the four decisions

| Field | Suggested | Why |
|---|---|---|
| Company type | Private limited by shares | The default for a trading company that will take revenue |
| Shares | 100 ordinary shares of £1, all to you | Round number, leaves room to give Justin or an investor a clean percentage later without splitting pennies. Liability capped at £100 |
| Director | Michael (you) | |
| PSC | Michael, 75%+ of shares | "Person with significant control" — with 100% of shares this is just you |

If Justin is to be a co-founder on paper, decide **before** filing. Adding a
shareholder later is a share transfer with tax questions attached; issuing at
incorporation is free.

---

## Step 3 — the two addresses (both new-ish rules, both catch people out)

**Registered office** must be an "appropriate address" — somewhere post actually
reaches a person. A PO Box is no longer acceptable. It appears on the **public
register forever**.

- Using your home address publishes your home address permanently.
- A registered-office service is £30–£60/year and solves that.
- **Important for Google:** whatever you choose must be a real physical address,
  because Play verification rejects a registered-agent address for the
  *organisation address*. Those can differ — the registered office may be a
  service, but give Google somewhere you genuinely are.

**Registered email address** is required (since March 2024) and is *not*
published. Use `M3xiTeam@m3xi.com` so it survives you changing personal
addresses.

---

## Step 4 — SIC codes

Pick up to four from the official list. For what M3XI actually does:

- **62012** — Business and domestic software development *(primary — Cornelia, CallMe)*
- **62020** — Information technology consultancy activities
- **74100** — Specialised design activities *(the Studio and Spatial work)*
- **63120** — Web portals *(the Library and the platform itself)*

These are descriptive only. They do not restrict what you may trade in, and
getting them approximately right is fine.

---

## Step 5 — file

**GOV.UK → "Set up a limited company"**, digital incorporation.
**£100** as of 1 February 2026 (it was £50 — the fee rose this year). Usually
same day, occasionally 24 hours.

You will need: personal code from Step 0, name, addresses, share structure,
director and PSC details, SIC codes, and three security questions (mother's
maiden name and the like).

---

## Step 6 — immediately after, in this order

1. **D-U-N-S number** — free from Dun & Bradstreet, **up to 30 days**. This is
   the long pole for Google, so request it the same day the company number
   arrives. Use the incorporated name and address *exactly*.
2. **Business bank account** — needs the company number. Tide/Starling open in a
   day or two and are used to sole founders.
3. **Play Console → organisation profile** — set the organisation name and
   address to match the incorporation **character for character**. Mismatch is
   precisely what triggers restriction.
4. **Corporation tax** — register within 3 months of starting to trade.
5. **VAT** — only required above £90k turnover. Voluntary registration lets you
   reclaim VAT on the AI spend, but adds quarterly filing. Not yet.
6. **Update the site** — replace "M3XI isn't a registered company yet" and add
   the company number to the footer, which is a legal requirement once
   incorporated and also what a Spatial buyer looks for.

---

## What I cannot do, and why

I can't file this for you. Incorporation requires your identity verification and
a card payment, and I don't enter identity documents or payment details into
forms on anyone's behalf — that holds even though you have asked, because the
risk of a wrong keystroke lands on you and the account is yours.

What I have done is remove every decision from the process, so the form is
transcription rather than thinking.

Once the company number exists, tell me and I will do the parts that are mine:
update the site footer and legal pages, draft the exact field-by-field values
for the Play organisation profile, and prepare the D-U-N-S submission details.
