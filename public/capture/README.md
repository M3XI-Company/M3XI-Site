# /capture — the installable shell for the capture PWA

The capture app itself is built from `spatial/apps/capture/`. This folder holds
the five things an app needs in order to be *installed on a phone and opened
without a network*, which are static files rather than build output: a
manifest, a service worker, icons and an offline page.

## Why these files are here and not in `spatial/apps/capture/public/`

Because nothing would ever copy them.

`vite.config.js` at the repo root sets neither `root` nor `publicDir`, so Vite
uses its default: `<root>/public`, which is this directory. The capture page is
not a separate Vite project with a public folder of its own — it is one more
entry in `build.rollupOptions.input`, alongside `index.html`, `questions/` and
the viewer. An `apps/capture/public/` directory is therefore invisible to the
build, and a manifest sitting in it would 404 in production while looking
perfectly correct in the repo.

Putting them here has a second consequence, and it is load-bearing rather than
incidental. `public/` is copied to the root of `dist/`, so `public/capture/sw.js`
is served at `/capture/sw.js` — the same path prefix the app is served from. A
service worker's default scope is its own directory, so this one controls
`/capture/` and nothing else, with no `Service-Worker-Allowed` header and no
change to `vercel.json`. A worker served from `/sw.js` would have been able to
control the whole marketing site, which is not something a capture app should
be able to do.

**Never put an `index.html` in this folder.** Vercel serves a matching static
file before it applies a rewrite, so `public/capture/index.html` would shadow
the `/capture/` rewrite and the app would silently stop being served. This is
not hypothetical: until 19 September 2026 this directory held the retired tour
capture app, `index.html` and `capture.js`, served exactly that way.

## The files

| File | What it is |
| --- | --- |
| `manifest.webmanifest` | Install metadata: name, colours, icons, start URL, scope. |
| `sw.js` | The shell cache. Hand written and commented in full; read its header before changing it. |
| `offline.html` | What the operator sees when the shell is missing and the network is gone. |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png` | Home-screen icons. |
| `icons.py` | The generator that produced those four PNGs. |

## What the app page has to do

`vercel.json` rewrites `/capture` and `/capture/` onto
`spatial/apps/capture/index.html`. That page needs, in `<head>`:

```html
<link rel="manifest" href="/capture/manifest.webmanifest">
<link rel="apple-touch-icon" href="/capture/apple-touch-icon-180.png">
<meta name="theme-color" content="#19150F">
```

and, once the page has loaded:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/capture/sw.js', { scope: '/capture/' })
    .catch((err) => { console.error('[capture] service worker registration failed', err); });
}
```

**Link to `/capture/` with the trailing slash, everywhere.** The worker's scope
is `/capture/`, and `/capture` (no slash) is not inside it. A page opened at
`/capture` renders identically and is *not controlled by the worker*, so it has
no offline shell and no install prompt on some browsers. The manifest's
`start_url` is `/capture/` for the same reason. If an operator is sent a link,
it needs the slash.

Two further rules the page inherits from `sw.js`:

* **Only `/capture` and `/capture/` are routed.** Unlike the console, there is
  no `/capture/:path*` rewrite, so a client-side router that pushes
  `/capture/room/3` produces a URL that 404s when it is reloaded or shared. The
  worker deliberately does not paper over this — see its `SHELL_PATH` comment.
* **Anything loaded cross-origin will not work offline.** The worker refuses to
  cache cross-origin responses, on purpose (an opaque response reports status 0,
  so a cached error is indistinguishable from a cached file). If the page pulls
  Playfair Display and Inter from Google Fonts the way `index.html` does, the
  installed app falls back to system fonts in a lift. `offline.html` already
  assumes that and uses the system stack.

## The manifest, field by field

JSON cannot carry comments, so the reasoning lives here.

* **`id: "/capture/"`** — a stable identity for the installed app that does not
  move if `start_url` ever gains a query parameter. Without it, the browser
  derives the id from `start_url`, and changing `start_url` later would install
  a second copy beside the first rather than updating it.
* **`name: "M3XI Capture"` / `short_name: "Capture"`** — the icon already says
  M3XI, so the label says what the app does. At twelve characters or fewer,
  `Capture` is not truncated by any launcher; `M3XI Capture` would be, and
  launchers truncate at the end, which would have lost the informative word.
* **`description`** — what the app is for, in the operator's terms, not the
  product's: record a walkthrough, and find out *before leaving* whether it
  will reconstruct. That is the whole reason the thing exists.
* **`lang: "en-GB"`** — the copy is British, and the app measures in metres.
* **`display: "standalone"`** — no browser chrome. The operator is holding the
  phone at arm's length in somebody's hallway; a URL bar is 60 pixels of
  nothing they need, and the back gesture belongs to the app.
* **`orientation: "portrait"`** — the frame is tall, so floor and ceiling are in
  shot together, which is what gives the reconstruction its vertical structure;
  and the phone is held one-handed. Mostly, though, it is so that the device
  does not rotate *during* a recording, which changes the framing halfway
  through a take that cannot be re-shot. Note what this is not: a guarantee.
  Android honours it in standalone display, iOS ignores it, so the app still
  has to cope with a rotated device — this only removes the accidental case.
* **`background_color` and `theme_color`, both `#19150F`** — the site's `--ink`,
  read from `index.html`, not invented. The splash screen is the icon drawn on
  `background_color`, and because the icons are ink-grounded too, the tile has
  no visible edge on it: the mark simply appears. `theme_color` puts the same
  ink behind the status bar.
* **`icons`** — see below. All four entries exist at the size they claim; that
  is checked by the validation at the end of this file.

## Regenerating the icons

```
python public/capture/icons.py
```

Pillow is the only requirement. The script reads `public/M.png` — the site's own
mark — and writes all four PNGs, printing each one's dimensions, byte count and
SHA-256 so a regeneration can be diffed against what is committed. It is
deterministic: two runs on the same `M.png` produce byte-identical files
(verified, 20 September 2026).

The design decisions, and the alternatives rejected, are argued in the script's
docstring. The short version: the artwork is the brand mark rather than a camera
glyph, it is paper on ink rather than the site's ink on paper so that it is
found by silhouette at 48dp and cannot be confused with a browser tab showing
m3xi.com, and the maskable variant fills 56% of the canvas because the largest
square that survives a circular Android mask is `0.8 / sqrt(2)` of the width,
not the 80% the usual advice quotes.

`apple-touch-icon-180.png` is listed in the manifest because it exists and is a
real 180×180 icon, but iOS does not read the manifest's icon array for the home
screen — it reads `<link rel="apple-touch-icon">`. Without that tag in the app
page, an installed capture app on an iPhone gets a screenshot of the page as its
icon.

## What the service worker will never do

Each of these is commented at its bypass in `sw.js`; they are collected here
because they are the constraints most likely to be broken by a well-meaning
change.

* **It never touches the resumable upload.** tus PATCHes carry the walkthrough
  and an offset the server owns. A cached offset writes the next chunk in the
  wrong place; a replayed PATCH writes the same chunk twice. Either is found out
  by the pipeline hours later, on a video nobody can re-shoot.
* **It never caches `/rest/v1`, `/auth/v1`, `/storage/v1` or `/functions/v1`.**
  A stale world list shows a property that was reassigned this morning; a stale
  auth response hands over a session the server has revoked. An error is
  recoverable, a confident lie is not.
* **It never caches the recording.** Refused by method, by `Range` header, by
  request destination, and finally by the allowlist — the cache only ever holds
  `/capture/*` and the hashed `/assets/*` files. This is a storage argument as
  much as a correctness one: the unsent walkthrough is the thing that must not
  be evicted.
* **It never calls `skipWaiting()`.** A new worker waits for every `/capture/`
  page to close. Swapping the cache under a running app means the next lazily
  loaded chunk is one only the old build had, which would end a capture
  mid-walk.

It also commits the shell **all or nothing**: a new document is only cached once
every file it names has been fetched. The obvious alternative — cache the
document now, let the assets follow — produces the worst failure this app can
have, which is a phone that boots the app to a blank screen, offline, in a
hallway.

## What is verified, and what is not

Verified on 20 September 2026:

* `sw.js` parses (`node --check`).
* `sw.js` was **driven in Node against a real HTTP server** serving a
  Rollup-shaped document and hashed assets, with a stand-in `CacheStorage`: 38
  assertions covering install, activate, the twelve request kinds that must pass
  through untouched, offline serving, a deploy, a deploy with a missing asset,
  the cold start, and the claim that nothing outside the two allowed prefixes is
  ever stored. All passed. The driver lives in the scratchpad, not in this repo,
  because `spatial/vitest.config.ts` does not cover `public/` and is not mine to
  change.
* `manifest.webmanifest` is valid JSON, `start_url` is inside `scope`, and every
  icon it names exists, is a PNG, and is exactly the size claimed.
* `icons.py` is deterministic across runs.
* `offline.html` was rendered at 375×812 and read at the size an operator sees.

Not verified, and honestly cannot be from here:

* **No real install.** Nothing has added this to a phone's home screen, so the
  icon has not been seen under a launcher's mask, the splash has not been seen,
  and `orientation` has not been observed being honoured or ignored.
* **No real service-worker registration.** This environment's browser pane
  refuses to register one (`An unknown error occurred when fetching the script`,
  with the script itself fetching fine at 200). The Node driver exercises the
  worker's logic, not the browser's lifecycle. What would settle it: open
  `https://www.m3xi.com/capture/` on a phone, install it, turn on flight mode,
  and open it from the home screen.
* **The asset discovery has never seen a real build of this app**, because
  `spatial/apps/capture/index.html` does not exist yet. It was driven against a
  document shaped like Rollup's output, including a worker chunk referenced only
  from inside the JavaScript. First real deploy: check the console for
  `[capture sw] shell updated`, and check the Cache Storage entries match the
  files in `dist/assets`.
* **`offline.html` makes a promise about the app**: that a finished walkthrough
  is held on the device and that an interrupted upload resumes rather than
  restarting. That is true of a tus-based upload and of the design, but it is
  not true of code that does not exist yet. If the app ever drops a recording on
  close, this page is lying to somebody at the worst possible moment — change
  the copy the same day.
