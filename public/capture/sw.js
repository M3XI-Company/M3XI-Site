/**
 * The capture app's shell cache.
 *
 * The operator is standing in a stranger's hallway. The lift has no signal,
 * the flat has one bar, and the walkthrough they are about to film is the only
 * one they will get. This worker exists for exactly one sentence of that: the
 * app must OPEN. Not sync, not queue, not retry -- open, with its code on the
 * phone, so the thing that tells them their walk is going wrong is running
 * before they find out it did.
 *
 * WHAT IT CACHES
 *
 *   The document at /capture/ and the build assets that document names. That
 *   is the whole list. Everything else on this origin is either somebody
 *   else's app (/view, /console, the marketing site) or data that must never
 *   be answered from a cache.
 *
 * WHAT IT MUST NOT TOUCH, AND WHY EACH ONE WOULD HURT
 *
 *   The resumable upload. Supabase Storage's resumable endpoint is tus: the
 *   client asks HEAD for the offset the SERVER believes it holds, then PATCHes
 *   the next chunk at that offset. Those PATCHes are the walkthrough -- one to
 *   three gigabytes of it. A worker that cached a tus response would hand back
 *   a stale offset and the next chunk would be written in the wrong place; a
 *   worker that replayed a PATCH would append the same chunk twice. Either way
 *   the corruption is discovered by the pipeline, hours later, on a video that
 *   cannot be reshot because the vendor has gone out. Bypassed three times
 *   over below: non-GET returns immediately, /storage/v1 is refused by path,
 *   and nothing outside the two cacheable prefixes is ever stored.
 *
 *   /rest/v1, /auth/v1, /storage/v1 and /functions/v1. A cached world list
 *   shows the operator a property that was reassigned this morning. A cached
 *   auth response hands them a session that the server has already revoked, or
 *   -- worse on a shared phone -- somebody else's. An error here is a screen
 *   that says something is wrong, which is recoverable; a stale success is a
 *   confident lie, which is not.
 *
 *   The recorded video. The file never reaches this worker anyway -- it lives
 *   in a blob: URL or OPFS handle, and the fetch event only fires for http(s)
 *   -- but the <video> element previewing it DOES issue ranged GETs, and a 206
 *   cannot legally go in a Cache anyway. It is refused by Range header, by
 *   destination, and again by the prefix allowlist. Beyond correctness this is
 *   a quota argument: the shell is a couple of megabytes and the operator's
 *   unsent walkthrough is a thousand. If this worker ever competes with that
 *   video for storage, the eviction that follows loses the job.
 *
 * WHAT IT CANNOT DO, STATED PLAINLY
 *
 *   There is no build-time precache manifest. The site is built by one Vite
 *   config that emits hashed filenames, and nothing writes that list into this
 *   folder -- this file is a hand-written static asset, not a generated one.
 *   So the shell is discovered by READING the document: fetch /capture/, pull
 *   the <script>/<link> URLs out of it, fetch those, and scan the JavaScript
 *   for the worker chunk that no HTML tag mentions. See `discoverShell`. It is
 *   regular expressions over machine-generated output, which is a bad idea
 *   everywhere else and a defensible one here, because the only consequence of
 *   a miss is that an asset is not precached -- it is still fetched and cached
 *   the first time it is genuinely used, online.
 *
 *   The first open must be online. Nothing can change that; a phone cannot
 *   hold what it has never been sent. The README says so and offline.html says
 *   so to the operator.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bump VERSION to abandon everything cached by the previous worker. That is a
 * blunt instrument -- it costs every installed operator one online open -- so
 * it is for changes to THIS FILE's logic, not for app deploys. App deploys are
 * handled by `updateShell`, which notices the document changed and swaps the
 * document and its assets together.
 */
const VERSION = 'v1';
const CACHE_PREFIX = 'm3xi-capture-shell-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

/**
 * The app document. `vercel.json` rewrites exactly /capture and /capture/ onto
 * spatial/apps/capture/index.html -- and NOT /capture/:path*, which is how the
 * console is routed. So there is no deeper route to serve a shell for, and
 * this worker deliberately does not invent one: a request for /capture/foo is
 * a genuine 404 and dressing it up as the app would hide a routing bug until
 * somebody is standing on a doorstep looking at it.
 */
const SHELL_PATH = '/capture/';
const OFFLINE_PATH = '/capture/offline.html';

/** Everything this worker serves lives under one of these two prefixes. */
const SCOPE_PREFIX = '/capture/';
const ASSET_PREFIX = '/assets/';

/**
 * Refused by path, whatever the method. The method check below already stops
 * the writes; this stops a GET world list, a GET session, a GET signed URL and
 * a GET of the uploaded video from ever being stored. Supabase Realtime is not
 * listed because it is a WebSocket and a WebSocket never reaches a fetch
 * handler.
 */
const NEVER_TOUCH = ['/rest/v1', '/auth/v1', '/storage/v1', '/functions/v1'];

/**
 * A ceiling on how many files one shell may consist of. The discovery below
 * follows string literals out of JavaScript, and a regular expression that
 * goes wrong must not be able to spend the operator's storage -- the same
 * storage the unsent walkthrough is sitting in. A Vite build of this app is
 * around a dozen files; 80 is far above any honest build and far below
 * anything that would hurt.
 */
const MAX_SHELL_ASSETS = 80;

const LOG = '[capture sw]';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(onInstall());
});

async function onInstall() {
  const cache = await caches.open(CACHE_NAME);

  // offline.html is the only FATAL part of installation. If it cannot be
  // stored, this worker has nothing honest to say when the network is gone, so
  // the install is allowed to reject: the previous worker (or none) stays, and
  // the browser logs the failure. Half an installation is worse than none --
  // it is a worker that intercepts requests and then cannot answer them.
  //
  // `cache: 'reload'` forces a trip to the network past the HTTP cache. Vercel
  // serves this folder with must-revalidate, but a phone that has been offline
  // for a week can still hold a stale copy, and precaching a stale copy of the
  // page whose entire job is to be correct when nothing else is would be a
  // poor joke.
  await cache.add(new Request(OFFLINE_PATH, { cache: 'reload' }));

  // The shell itself is BEST EFFORT. If the document or one of its assets is
  // unreachable during install -- a deploy in flight, a captive portal, a lift
  // -- we install anyway with offline.html and no shell. The next online
  // navigation goes to the network, works, and fills the cache properly. The
  // alternative (reject the install) would leave the operator with no worker
  // at all because of a blip, which is the worse of the two failures.
  try {
    await updateShell(cache);
  } catch (err) {
    console.error(`${LOG} shell not precached during install; will retry on first open`, err);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(onActivate());
});

async function onActivate() {
  const names = await caches.keys();
  await Promise.all(
    names
      // Prefix-matched, NOT a blanket delete. This origin also serves the
      // marketing site, /view and /console; if any of them ever opens a cache,
      // a `caches.keys().map(caches.delete)` here would quietly destroy it.
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name))
  );

  // Take over pages that are already open and were loaded without a
  // controller -- which is every page on the operator's very first visit.
  // Without this, installing the app and opening it would go: first open
  // registers the worker but is not controlled by it, second open finally is.
  // An operator who installs on the doorstep and walks straight in has exactly
  // one open before the signal goes.
  await self.clients.claim();
}

/**
 * Note what is NOT here: `skipWaiting()`. A new worker waits until every
 * /capture/ page is closed before it activates, on purpose. Activating mid-walk
 * would swap the cache under a running app, and the moment that app asked for
 * a lazily-loaded chunk it would be asking the new cache for a file only the
 * old build contained. The cost of waiting is that an update lands on the next
 * fresh open. The cost of not waiting is a capture that dies in the middle.
 */

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Writes. tus PATCH, tus HEAD, every RPC and every sign-in. Returning
  // without calling respondWith leaves the request entirely alone -- the
  // browser performs it as if this worker did not exist.
  if (request.method !== 'GET') return;

  // Belt and braces: per spec the fetch event only fires for http(s), so a
  // blob: preview of the recording cannot arrive here. One comparison is
  // cheaper than relying on a reader knowing that.
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // Cross-origin: Supabase, fonts, anything else. A cross-origin response is
  // opaque unless it opted into CORS, and an opaque response has status 0 --
  // a cached 404 and a cached font are indistinguishable, so caching one is
  // gambling that the operator's offline open is not the one that got the
  // error. The shell must not depend on a third-party origin at all.
  if (url.origin !== self.location.origin) return;

  if (NEVER_TOUCH.some((prefix) => url.pathname.startsWith(prefix))) return;

  // A ranged GET is a media element seeking. The response is a 206, which the
  // Cache API refuses outright, and the thing being seeked is the operator's
  // recording.
  if (request.headers.has('range')) return;
  if (request.destination === 'video' || request.destination === 'audio') return;

  if (request.mode === 'navigate') {
    if (url.pathname === SHELL_PATH) {
      event.respondWith(serveShell(event));
    } else if (url.pathname === OFFLINE_PATH) {
      event.respondWith(serveStatic(event, { revalidate: false }));
    }
    // Any other navigation -- including /capture (no trailing slash), which is
    // outside this worker's scope and therefore never arrives here anyway --
    // goes to the network untouched.
    return;
  }

  // The allowlist. This, rather than the individual refusals above, is the
  // actual guarantee that nothing else is ever stored: two prefixes, both of
  // them static files this repo emits.
  if (url.pathname.startsWith(ASSET_PREFIX)) {
    // Hashed by Rollup, so the URL changes whenever the bytes do. Revalidating
    // an immutable file is a network request that can only ever confirm what
    // is already true.
    event.respondWith(serveStatic(event, { revalidate: false }));
    return;
  }

  if (url.pathname.startsWith(SCOPE_PREFIX)) {
    // This folder: the manifest, the icons, offline.html. Unhashed, so a
    // deploy changes them in place and they are worth revalidating quietly
    // after serving.
    event.respondWith(serveStatic(event, { revalidate: true }));
  }
});

/**
 * The app document: cache first, revalidate afterwards, offline.html if there
 * is nothing cached and no network.
 */
async function serveShell(event) {
  const cache = await caches.open(CACHE_NAME);

  // Matched against the CONSTANT, not against event.request. /capture/?from=sms
  // and /capture/ are the same document, and matching the request would also
  // drag the navigation's Accept header into a Vary comparison against the
  // plain request this was stored under.
  const cached = await cache.match(SHELL_PATH, { ignoreVary: true });
  if (cached) {
    event.waitUntil(updateShellQuietly(cache));
    return cached;
  }

  try {
    const response = await fetch(event.request);
    // Fill the cache properly in the background rather than storing this
    // response: the shell is only worth caching together with its assets, and
    // `updateShell` is the one place that knows how to do that. It costs one
    // extra fetch of a two-kilobyte document, once, on a connection that is by
    // definition working.
    event.waitUntil(updateShellQuietly(cache));
    return response;
  } catch (err) {
    // Warn, not error: this is the case this worker was written for, not a
    // fault. The loud, legible failure is the page the operator is about to
    // get, which explains itself in words rather than in a console nobody on
    // a doorstep can open.
    console.warn(`${LOG} shell unreachable and not cached; serving the offline page`, err);
    const offline = await cache.match(OFFLINE_PATH, { ignoreVary: true });
    if (offline) return offline;
    return lastResort();
  }
}

/** Cache first for static files, with an optional quiet refresh afterwards. */
async function serveStatic(event, { revalidate }) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request, { ignoreVary: true });

  if (cached) {
    if (revalidate) event.waitUntil(refresh(cache, event.request));
    return cached;
  }

  // No catch. If this rejects the browser shows its own network error for the
  // subresource, which is the truth: the file is not on the phone and the
  // network is gone. Substituting something that looks like the file would be
  // worse than a broken image.
  const response = await fetch(event.request);
  if (isStorable(response)) await cache.put(event.request, response.clone());
  return response;
}

async function refresh(cache, request) {
  try {
    const response = await fetch(new Request(request.url, { cache: 'reload' }));
    if (isStorable(response)) await cache.put(request, response);
  } catch (err) {
    // Offline. Expected, and not worth a line in the console every time the
    // operator opens the app in a basement.
  }
}

/**
 * The only HTML this file contains, for the case where even offline.html is
 * missing -- which means the operator (or the OS, reclaiming space) cleared
 * this site's storage. It exists because a blank white screen on a doorstep
 * tells somebody nothing at all, and this at least tells them the truth.
 */
function lastResort() {
  const body =
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>M3XI Capture is not available offline</title>' +
    '<style>body{margin:0;padding:32px 24px;background:#19150F;color:#F0E8D8;' +
    'font:400 20px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    'h1{font:500 30px/1.25 Georgia,serif;margin:0 0 16px}</style></head><body>' +
    '<h1>This phone has nothing saved</h1>' +
    '<p>M3XI Capture has no connection and no copy of itself on this phone. ' +
    'Move to where there is signal and open it again.</p>' +
    '<p>Anything you have already recorded is still on the phone. It is not ' +
    'lost by this screen.</p></body></html>';
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Keeping the shell current
// ---------------------------------------------------------------------------

/**
 * One update at a time. Several navigations can be in flight at once (an
 * operator tapping the icon twice), and two updates racing would fetch every
 * asset twice and could interleave their commits. The flag is per worker
 * instance and the worker can be killed between events, so this is a
 * best-effort guard against the common case, not a lock.
 */
let updating = false;

async function updateShellQuietly(cache) {
  if (updating) return;
  updating = true;
  try {
    const changed = await updateShell(cache);
    if (changed) console.info(`${LOG} shell updated`);
  } catch (err) {
    console.error(`${LOG} shell update abandoned; the cached shell is untouched`, err);
  } finally {
    updating = false;
  }
}

/**
 * Fetch the document, work out what it needs, and store all of it or none of
 * it.
 *
 * ALL OR NOTHING is the point of this function. The obvious implementation --
 * cache the new document as soon as it arrives, let the assets arrive when
 * they arrive -- produces the nastiest failure this app can have: a cached
 * document that names hashed files nobody has, which boots to a blank screen,
 * offline, with no way to fix it from the hallway. So the new document is only
 * committed once every file it names is in hand.
 *
 * Holding those files in memory until the commit is the cost. The alternative
 * -- staging them in a second cache and swapping -- doubles peak storage, and
 * storage is what the unsent walkthrough is living in. MAX_SHELL_ASSETS bounds
 * the memory instead.
 *
 * @returns {Promise<boolean>} true when the shell was replaced.
 */
async function updateShell(cache) {
  let response;
  try {
    response = await fetch(new Request(SHELL_PATH, { cache: 'reload' }));
  } catch (err) {
    // No network. In an offline-first worker that is a condition, not a
    // fault, and it happens on every open in a lift -- so it returns rather
    // than throwing, and the caller does not log it as a broken deploy. Every
    // failure below this line IS a fault and is treated as one.
    return false;
  }

  if (!isStorable(response)) {
    throw new Error(`document fetch returned ${response.status} ${response.type}`);
  }

  const html = await response.clone().text();

  const previous = await cache.match(SHELL_PATH, { ignoreVary: true });
  if (previous && (await previous.text()) === html) return false;

  const { required, base } = entryAssets(html, response.url);
  const files = await discoverShell(required, base);

  for (const [href, file] of files) await cache.put(href, file);
  await cache.put(SHELL_PATH, response);

  const keep = new Set(files.keys());
  await prune(cache, keep);
  return true;
}

/**
 * The URLs the document itself names: entry script, stylesheet, modulepreloads.
 *
 * A regular expression over HTML, which is normally indefensible. It is
 * defensible here for one reason: this HTML is emitted by Rollup, not written
 * by a person, so the shape is fixed -- double-quoted attributes, no attribute
 * values containing `>`, no script or link inside a comment. If that ever
 * stops being true the match comes back short, `discoverShell` throws on the
 * missing entry, and the update is abandoned with the working shell intact.
 */
function entryAssets(html, documentUrl) {
  const base = new URL(documentUrl);
  const pattern = /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*"([^"]+)"/gi;
  const required = new Set();

  for (const match of html.matchAll(pattern)) {
    const href = sameOriginAsset(match[1], base);
    if (href) required.add(href);
  }

  // A document with no /assets/ file in it is treated as a PARSE FAILURE
  // rather than as a self-contained page, because those two look identical
  // from here and only one of them is survivable. This asserts a property of
  // the Vite build -- the entry module is always emitted as its own hashed
  // file, never inlined -- so if that ever changes, change this with it.
  if (required.size === 0) {
    throw new Error('the capture document named no /assets/ files; refusing to cache it as a shell');
  }
  return { required, base };
}

/**
 * Fetch the entry assets, then follow the `/assets/...` strings inside the
 * JavaScript one level at a time.
 *
 * The second half of that exists because of the analysis worker. The capture
 * app scores frames on a worker thread, Vite emits it as its own chunk, and
 * the only place its URL appears is inside a `new URL('/assets/....js',
 * import.meta.url)` in the bundle -- no HTML tag mentions it. An app that
 * opens offline and then cannot measure blur is not an app that opened.
 *
 * The two halves have deliberately different failure modes:
 *
 *   entry assets   REQUIRED. The document cannot run without them, so a
 *                  failure throws and abandons the whole update.
 *   followed URLs  BEST EFFORT. They were found by pattern-matching string
 *                  literals, so some of them will be false positives -- a path
 *                  in a comment, a string that is not a URL. A 404 on one of
 *                  those must not be allowed to block every future update; it
 *                  is logged and skipped, and any genuine miss is cached the
 *                  first time the running app actually asks for it.
 */
async function discoverShell(required, base) {
  const files = new Map();
  const queue = [...required];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const href = queue.shift();
    const isRequired = required.has(href);

    let response;
    try {
      response = await fetch(new Request(href, { cache: 'reload' }));
    } catch (err) {
      if (isRequired) throw new Error(`shell asset ${href} could not be fetched: ${String(err)}`);
      console.warn(`${LOG} skipping ${href}: ${String(err)}`);
      continue;
    }

    if (!isStorable(response)) {
      if (isRequired) throw new Error(`shell asset ${href} returned ${response.status}`);
      continue;
    }

    // Read the text from a clone; the original keeps its body for the cache.
    const type = response.headers.get('Content-Type') || '';
    const text = type.includes('javascript') ? await response.clone().text() : null;
    files.set(href, response);

    if (!text) continue;
    for (const found of followAssets(text, base)) {
      if (seen.has(found)) continue;
      if (seen.size >= MAX_SHELL_ASSETS) {
        console.warn(`${LOG} stopped following assets at ${MAX_SHELL_ASSETS}; shell is larger than expected`);
        queue.length = 0;
        break;
      }
      seen.add(found);
      queue.push(found);
    }
  }

  return files;
}

/** `/assets/...` string literals inside a built JavaScript file. */
function followAssets(text, base) {
  const pattern = /["'`](\/assets\/[A-Za-z0-9][\w.-]*)["'`]/g;
  const found = new Set();
  for (const match of text.matchAll(pattern)) {
    const href = sameOriginAsset(match[1], base);
    if (href) found.add(href);
  }
  return found;
}

/** An absolute URL string if this is one of our build assets, else null. */
function sameOriginAsset(raw, base) {
  let url;
  try {
    url = new URL(raw, base);
  } catch (err) {
    return null;
  }
  if (url.origin !== self.location.origin) return null;
  if (!url.pathname.startsWith(ASSET_PREFIX)) return null;
  url.hash = '';
  return url.href;
}

/**
 * Drop build assets the new shell does not reference.
 *
 * Only /assets/ entries are considered. The handful of files in /capture/ --
 * the manifest, four icons, offline.html -- are unhashed and are replaced in
 * place by `refresh`, so sweeping them here would delete offline.html the
 * moment a deploy changed the app's entry hash.
 */
async function prune(cache, keep) {
  const entries = await cache.keys();
  await Promise.all(
    entries
      .filter((request) => {
        const path = new URL(request.url).pathname;
        return path.startsWith(ASSET_PREFIX) && !keep.has(request.url);
      })
      .map((request) => cache.delete(request))
  );
}

/**
 * Worth storing?
 *
 * `type === 'basic'` excludes opaque cross-origin responses, which report
 * status 0 whether they succeeded or failed. `status === 200` excludes
 * redirects and, importantly, 206 partial content, which `cache.put` rejects
 * with a TypeError rather than a warning.
 */
function isStorable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic';
}
