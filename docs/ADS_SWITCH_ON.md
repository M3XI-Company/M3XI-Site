# Ads on the Help page — how to switch them on

Written 10 October 2026. **State: built, and OFF.** The Help page
(`/questions/`) has room for two Google ads in its side margins, but nothing is
drawn and no Google script is requested until Google has approved the site and
the switch below is flipped. This is the whole checklist, in order.

Checked against a real build (`npm run build`) and a browser at 1920, 1800,
1536, 1520, 1519, 1440, 1280, 1024 and 390 px wide, with ads off and with a test
switch-on in which Google's script was stubbed rather than fetched. Google's own
side (approval, consent message, real ads filling) cannot be checked until step
1 is done; where something depends on it, it says so.

## What is in place

| Piece | Where | State |
| --- | --- | --- |
| The switch and the loader | `shared/site-ads.js` | `enabled: false`. Bundled from `/questions/` only, like `site-chrome.js`, so it needs no entry in `vite.config.js`. |
| Two ad rails | `questions/index.html` | Hidden. Markup, label and CSS are in the page. |
| ads.txt | `public/ads.txt` → `m3xi.com/ads.txt` | Live once pushed. The same line as `app-ads.txt`. |
| Site verification | `<meta name="google-adsense-account">` in `index.html` and `questions/index.html` | Live once pushed. A meta tag loads nothing. |
| Content-Security-Policy | `vercel.json` | No change needed, see step 3c. |
| Privacy page | `privacy/index.html` | **Not changed yet.** It says, truthfully for now, that the site runs no advertising trackers. Step 3b changes it on switch-on day. |

## How it behaves once switched on

* **Wide screens only.** The rails sit in the empty margins either side of the
  page's 1100px column and never touch it: 160px-wide units from a 1520px
  window, 300px-wide from 1800px. Below 1520px there are no rails at all, and
  that covers every phone, every tablet and many laptops (a 1536px laptop
  screen, 1920 at 125% scaling, does get them). The sums are in the
  comment above the rail CSS in `questions/index.html`.
* **Nothing on phones, not even a request.** The loader checks whether a rail
  is actually showing before it loads anything, so a phone or a narrow window
  never downloads Google's script and never sees an ad or a consent message.
  A window that is widened later gets its ads then.
* **Sticky.** The ad follows the reader down the questions and stops above
  the full-width "Still stuck?" band, so it never crosses that band or the
  footer. On a window shorter than 800px it scrolls with the page instead, so
  the bottom of the ad is never cut off.
* **Safe with ad blockers.** The wrapper round the questions is called
  `.help-frame`, never anything starting `ad-`: ad blockers hide elements
  named like `.ad-frame` (EasyList has that exact rule), which would hide the
  whole page. A blocker may hide the rails themselves, which is fine.
* **Each unit is exactly 160x600 or 300x600**, set by the page's CSS (Google's
  "exact size per screen width" way of sizing a responsive unit). A free-height
  vertical unit can come back 300x1050, which a sticky rail cannot hold.
* **No empty boxes.** The label only appears once Google says the unit is
  filled. An unfilled unit, a blocked script (ad blockers) or a policy that
  refuses the script folds the rail away again.
* **Consent is Google's own message** (step 1.7), shown by Google's script in
  the UK, EEA and Switzerland before any ad cookie. There is no banner of ours.
* Nothing in the rails moves or animates.

## 1. In AdSense (Michael)

1. Go to adsense.google.com and sign in with **the Google account that owns
   AdMob**. AdSense uses the same publisher ID, `pub-3432976752504337`, which
   makes the web ad client `ca-pub-3432976752504337`. If AdSense shows any
   other `pub-` number, stop: `public/ads.txt`, both meta tags and
   `shared/site-ads.js` all name 3432976752504337, and all of them would have
   to change together.
2. **Sites → Add site → `m3xi.com`.** The bare domain, no `www`, no `https://`.
   AdSense treats it as covering www.m3xi.com.
3. **Connect the site: choose "Meta tag".** The tag is already in the front
   page and the Help page, so tick that it is there and press **Verify**.
   ads.txt is also in place: `m3xi.com/ads.txt` is redirected to
   `https://www.m3xi.com/ads.txt` by the apex-to-www rule in `vercel.json`. The
   ads.txt standard allows a redirect that stays inside the same domain, and
   AdMob already reads `app-ads.txt` the same way.
4. **Request review.** Google reviews the whole site; it can take from a few
   days to a few weeks. Nothing changes on the site meanwhile. The site shows
   as **Ready** when it is approved, and Google sends an email.
5. **Turn Auto ads OFF for m3xi.com.** Ads → By site → the pencil next to
   m3xi.com → Auto ads off → Apply to site. This matters: the moment Google's
   script loads on `/questions/`, Auto ads would let Google put extra ads
   anywhere on that page (inside the questions, a bar along the bottom, a
   full-screen ad between pages), which is everything the rails were built to
   avoid.
6. **Create two display ad units.** Ads → By ad unit → **Display ads**.
   * Name it `Help page, left rail`. Ad size: **Responsive** (the shape preview
     does not matter; the page fixes each unit at 160x600 or 300x600).
   * Create it. From the code Google then shows, copy **only the number** after
     `data-ad-slot="`. It is about ten digits. Ignore the rest of the code; the
     loader writes it.
   * Do the same for `Help page, right rail`. Two units rather than one so the
     reports show each side.
7. **Privacy & messaging → European regulations → Create message.** Choose
   m3xi.com and English, add the **Do not consent** button alongside Consent
   and Manage options (the ICO expects saying no to be as easy as saying yes),
   and give the privacy policy link as `https://www.m3xi.com/privacy/#website-ads`.
   (That heading only exists once step 3b is pushed; until then the link
   simply opens the privacy page at the top, which is fine.)
   **Publish** it. This is the Google-certified consent tool that Google
   requires before it serves ads to visitors in the EEA, the UK and
   Switzerland. The US state regulations message is optional; skip it.
8. Worth doing: **Brand safety → Blocking controls**, and block the sensitive
   categories you do not want beside CallMe's help pages. **Dating** is the
   obvious one, or other dating apps can advertise on CallMe's own help page.
   Advertiser URLs can be blocked there too.

## 2. The label

Each rail is labelled **Advertisements**, in the page's paper look. AdSense's
ad placement policy allows ads to be labelled only **"Advertisements"** or
**"Sponsored Links"**, with no other variations. That is why the app's
"Advertisement · Paid placement — not part of CallMe" wording is not used here
(changed 10 Oct 2026, before any ad ran). Keep it that way: any other wording
can hold up approval.

**Also know: two sticky rails at once.** Google's own guidance for sticky
side ads (the Ad Manager "sticky ads" guidelines) asks that they never overlap
or sit too close to content, keep Google's ad attribution visible and scroll
only up and down, which these rails do. It does not forbid one on each side,
and AdSense's own "side rails" Auto ads format uses both sides. Some
third-party summaries of the AdSense rules say only one sticky ad may be on
screen at a time, though. If Google ever flags it, keep both ads and make one
of them scroll with the page: add
`.ad-rail--right .ad-rail-in{position:static}` to the rail CSS.

## 3. The switch (one push)

### 3a. `shared/site-ads.js`

Set `enabled` to `true` and paste the two numbers from step 1.6:

```js
window.M3XI_ADS = {
  enabled: true,
  client: 'ca-pub-3432976752504337',
  slots: { left: '1234567890', right: '0987654321' }
};
```

A slot id that is empty or not all digits leaves its rail hidden. If both are,
Google's script is never requested at all.

### 3b. `privacy/index.html` (same push)

The website policy (`#website`) currently says there are no advertising
trackers, which stops being true the moment 3a goes live. Three edits, all in
the `<article class="policy web" id="website">` block, then the date.

**Edit 1.** In the "Operational data" bullet, replace

```html
We do not run advertising trackers on this website.
```

with

```html
We do not run advertising trackers on this website, except for the Google ads on the Help page described under <a href="#website-ads" class="inl">Ads on the Help page</a>.
```

**Edit 2.** In the paragraph under `<h3>Cookies</h3>`, replace the opening

```html
This site uses only strictly necessary operational storage,
```

with

```html
Apart from the Google ads on the Help page (below), this site uses only strictly necessary operational storage,
```

**Edit 3.** Straight after that Cookies paragraph, before the "Back to all
policies" link, paste:

```html
    <h3 id="website-ads">Ads on the Help page</h3>
    <p>The Help page, <a href="/questions/" class="inl">m3xi.com/questions</a>, shows ads in its side margins on computer screens wide enough to fit them. The ads come from Google AdSense. No other page on this website shows ads. On narrower screens, such as phones and tablets, the page does not load Google's ad code at all. Google chooses the ads, not us, and we do not give Google anything about you or your CallMe account for them.</p>
    <p>When the ads load, your browser connects to Google, which receives your IP address, details of your browser and device, and the address of the page. Google and the companies it works with may use cookies and similar technology to show these ads, to count them and to stop fraud, and, if you agree, to choose ads based on your visits to this and other websites. In the UK, the EEA and Switzerland, Google asks for your consent in its own message before any of that, and you can change your answer later from the privacy and cookie settings link it leaves on the page. If you say no, Google may still show ads, but not ones based on your browsing. Google decides how it uses what it collects this way; its privacy policy is at <a href="https://policies.google.com/privacy" class="inl" rel="noopener">policies.google.com/privacy</a>.</p>
    <p>You can turn off personalised ads from Google at any time in <a href="https://myadcenter.google.com/" class="inl" rel="noopener">My Ad Center</a>. Google explains how it uses information from websites that show its ads in <a href="https://policies.google.com/technologies/partner-sites" class="inl" rel="noopener">How Google uses information from sites or apps that use our services</a>, and how it uses cookies in advertising in <a href="https://policies.google.com/technologies/ads" class="inl" rel="noopener">How Google uses cookies in advertising</a>. Other ad companies' cookies can be turned off at <a href="https://www.youronlinechoices.eu/" class="inl" rel="noopener">youronlinechoices.eu</a> or <a href="https://optout.aboutads.info/" class="inl" rel="noopener">optout.aboutads.info</a>.</p>
```

**Date.** Change `Last updated: 3 October 2026` in the `<small class="upd">`
line at the top to the switch-on date.

The shared "Legal bases" section already lists consent for "advertising
choices", so it needs no change.

### 3c. `vercel.json`: nothing to change

**No header block in `vercel.json` applies to `/questions/`.** The blocks that
exist are for `/.well-known/apple-app-site-association` (a Content-Type only),
`/staff` and `/staff/(.*)`, `/events` and `/events/(.*)`, `/e` and `/e/(.*)`,
`/design` and `/design/(.*)`, and `/p` and `/p/(.*)`. There is no catch-all.
So the Help page is served today with no Content-Security-Policy at all, and
switching ads on needs no change to it.

**Do not copy the `/events/` block onto `/questions/` while ads are on.** Its
`script-src 'self'` refuses Google's script. That was tried in a browser: the
page itself works and the rails fold away cleanly, but no ad ever shows.

If the Help page is ever given a policy of its own, know this first:

* **Google supports only a strict, nonce-based policy for AdSense**, not a list
  of allowed domains, because the domains its ad code uses change over time.
  Its supported policy
  ([AdSense help: Content Security Policy](https://support.google.com/adsense/answer/16283098))
  is:

  ```
  object-src 'none'; script-src 'nonce-{random}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:; base-uri 'none'; report-uri https://your-report-collector.example.com/
  ```

  A nonce has to be new on every request and stamped on every `<script>` and
  `<link rel="modulepreload">` in the page. Vercel serving this site as static
  files cannot do that; it would take Vercel Routing Middleware rewriting each
  response. The loader is ready for it either way: it adds Google's script
  with `createElement`, which `'strict-dynamic'` trusts by itself, and copies
  any nonce it finds on the page onto that script.

* **The allowlist below is NOT supported by Google** and may start blocking
  something without warning when Google moves a domain. If it is used at all,
  ship it as `Content-Security-Policy-Report-Only` (which reports, but blocks
  nothing) and watch the browser console. It is what Google's ad stack is
  known to load from today: the script and ad frames on
  `pagead2.googlesyndication.com`, `tpc.googlesyndication.com`,
  `*.safeframe.googlesyndication.com` and `googleads.g.doubleclick.net`; an
  ad-identity script on `adservice.google.com`; the
  ad-traffic-quality checks on `*.adtrafficquality.google` (with reCAPTCHA
  frames on `www.google.com` and `www.gstatic.com`); the consent message on
  `fundingchoicesmessages.google.com`; and measurement pings to `csi.gstatic.com`
  and `www.google.<country>`. It also keeps everything the page itself needs
  (its own files, the inline `<style>` block and Google Fonts). The JSON-LD block
  is data, not script, and is not affected. With Google's script stubbed, the
  loader and the page ran under this policy with no violations.

  ```json
  {
    "source": "/questions/(.*)",
    "headers": [
      {
        "key": "Content-Security-Policy-Report-Only",
        "value": "default-src 'self'; script-src 'self' https://pagead2.googlesyndication.com https://tpc.googlesyndication.com https://googleads.g.doubleclick.net https://adservice.google.com https://fundingchoicesmessages.google.com https://*.adtrafficquality.google https://www.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.googlesyndication.com https://*.g.doubleclick.net https://*.adtrafficquality.google https://fundingchoicesmessages.google.com https://www.google.com https://www.google.co.uk https://www.gstatic.com https://csi.gstatic.com; frame-src https://googleads.g.doubleclick.net https://*.googlesyndication.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com https://www.google.com; connect-src 'self' https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://*.adtrafficquality.google https://fundingchoicesmessages.google.com https://csi.gstatic.com https://www.google.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
      }
    ]
  }
  ```

  Add the same block again with `"source": "/questions"`, the way `/events`
  has both. Expect reports for other `www.google.<country>` domains (ad clicks
  and conversions ping whichever country Google picks) and for inline script
  inside Google's ad frames. Reports like that are why Google will not
  support an allowlist.

## 4. Check it works

**Before approval (once this work is pushed):**

* `https://www.m3xi.com/ads.txt` shows exactly
  `google.com, pub-3432976752504337, DIRECT, f08c47fec0942fa0`, and
  `https://m3xi.com/ads.txt` redirects there.
* View source on `https://www.m3xi.com/` and on `/questions/`: both have
  `<meta name="google-adsense-account" content="ca-pub-3432976752504337" />`.
* On `/questions/`, in the browser console, `window.M3XI_ADS.enabled` is
  `false`, and the Network tab filtered on `google` shows nothing but fonts.

**After the switch-on push:**

* Open `https://www.m3xi.com/questions/` in a desktop window at least 1520px
  wide: maximised on a 1920 monitor, or DevTools' device toolbar at 1600x900
  and then reload. In the UK, Google's consent message comes first. After you
  answer it, both margins show the label with an ad under it.
* New ad units can stay blank for up to an hour or so. A blank unit folds its
  rail away rather than showing an empty box, so no rails at first is not a
  fault. Try again later.
* Console checks: `window.M3XI_ADS` shows `enabled: true` and both slot ids;
  `[...document.querySelectorAll('ins.adsbygoogle')].map(i => i.dataset.adStatus)`
  gives `["filled", "filled"]` once ads arrive. In the Network tab,
  `adsbygoogle.js?client=ca-pub-3432976752504337` returns 200.
* Narrow the window below 1520px: the rails disappear and nothing scrolls
  sideways. Open the page on a phone: no ads, no consent message, and no Google
  request.
* With an ad blocker (uBlock Origin, AdBlock Plus) switched on, the questions
  still show in full; only the rails are gone.
* AdSense → Sites shows m3xi.com as Ready, and Reports show impressions by the
  next day.
* **Never click your own ads, and do not reload over and over to check them.**
  Google counts both as invalid traffic, and that is a fast route to a
  suspended account.

## Switching off again

Set `enabled: false` in `shared/site-ads.js` and push. The rails go back to
hidden and Google's script stops loading on the next deploy. Put the privacy
page back to the wording it has today at the same time.

## Why it is built this way

* **The switch is a `window` property, not a plain constant.** With a constant
  `enabled: false`, Rollup proves the loader is dead code and deletes it from
  the build entirely, so the live page would show no trace of the wiring until
  the day it was switched on. As it is, the loader ships (a 1.9 kB chunk on
  `/questions/` only), does nothing, and can be checked in production first.
* **The frame round the questions is `.help-frame`, and the rails end before
  the "Still stuck?" band.** A wrapper named `.ad-frame` (the first version)
  would have been hidden by every EasyList ad blocker, taking the whole Help
  page with it even while ads were off. Ending the frame before the full-width
  band keeps the ads from crossing that band, which Google's sticky-ad
  guidance counts as overlapping content.
* **The rails are in the page markup but `hidden`**, and the CSS shows them
  only where they fit, so an off switch, a missing slot id or a narrow screen
  all come to the same thing: nothing drawn and nothing requested. A hidden rail
  is also out of the accessibility tree, so screen readers do not meet two empty
  "Advertisements" landmarks.
* **Google's code is not changed beyond what Google documents.** The loader
  writes the same `<ins class="adsbygoogle">` and the same async, `crossorigin`
  script tag that AdSense's snippet does. The size comes from CSS the way
  Google's "exact ad unit size per screen width" example does it. An unfilled
  unit is hidden the way Google's own help suggests. A responsive unit hidden
  by a media query is the case AdSense's code policy allows.
