/*
  /api/tour — share previews and clean URLs for property tours.

  A buyer (or a link unfurler at WhatsApp, iMessage, LinkedIn, Google) asks for
  https://www.m3xi.com/tour/<slug>. vercel.json rewrites that to
  /api/tour?slug=<slug> (see docs/TOUR_API.md, "Clean URLs"). This function:

    1. asks m3ix-spatial for the tour's share card  ({ action: "og" })
    2. fetches the static viewer shell, public/tour/index.html, and keeps it in
       memory for five minutes
    3. injects <title>, Open Graph / Twitter tags and a tiny
       window.__M3IX_TOUR = { slug, vk } script into the shell's <head>
    4. returns the HTML with a short public cache

  The browser's address bar keeps /tour/<slug>, so the viewer cannot read
  ?t=<slug>; it reads window.__M3IX_TOUR instead (see docs).

  If anything upstream fails, the shell still goes out — with only the slug
  script injected — and the viewer shows its own error to the buyer.

  Runs on Vercel's Node runtime (package.json is "type": "module", so ESM).
  No dependencies: global fetch + AbortSignal.timeout (Node 18+).
*/

const SUPABASE_URL = "https://tnlcuptfldwxtxajudoq.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRubGN1cHRmbGR3eHR4YWp1ZG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0ODcxNDEsImV4cCI6MjEwMDA2MzE0MX0.mgS1gDa7qeBsTCaXmefpogg02kw7tCzn0uEYPAAuC90";
const SPATIAL_FN = `${SUPABASE_URL}/functions/v1/m3ix-spatial`;

const SITE = "https://www.m3xi.com";
const SHELL_PATH = "/tour/index.html";
const SHELL_TTL_MS = 5 * 60 * 1000; // five minutes in memory
const UPSTREAM_TIMEOUT_MS = 6000;
const CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const OG_MARKER = "<!-- og -->";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/* ---------- shell cache (survives across warm invocations) ---------- */

const shellCache = new Map(); // url -> { html, at }

async function fetchShellOnce(url) {
  const hit = shellCache.get(url);
  if (hit && Date.now() - hit.at < SHELL_TTL_MS) return hit.html;
  try {
    const r = await fetch(url, {
      headers: { accept: "text/html", "user-agent": "m3xi-tour-share/1" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const html = r.ok ? await r.text() : "";
    if (html && /<head[\s>]/i.test(html)) {
      shellCache.set(url, { html, at: Date.now() });
      return html;
    }
  } catch {
    /* fall through to stale copy or null */
  }
  return hit ? hit.html : null; // a stale shell beats no shell
}

/* Try each candidate origin in turn (own origin first outside production, then
   the live site) and return the first shell that looks like a page. */
async function getShell(urls) {
  for (const url of urls) {
    const html = await fetchShellOnce(url);
    if (html) return html;
  }
  return null;
}

/* ---------- og lookup ---------- */

async function fetchOg(slug, vk) {
  try {
    const r = await fetch(SPATIAL_FN, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ action: "og", slug, view_key: vk || undefined }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }
    return { status: r.status, data };
  } catch {
    return { status: 0, data: null }; // network / timeout: treat as upstream failure
  }
}

/* ---------- helpers ---------- */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// U+2028 / U+2029 built from char codes so no editor or transport can mangle them.
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

function jsLiteral(obj) {
  // Safe inside a <script>: "<" can never start a closing tag, and the two
  // Unicode line separators never break the JS string.
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATORS, (c) => "\\u" + c.charCodeAt(0).toString(16));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function prettyDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function describe(og) {
  const rooms = Number(og.rooms) || 0;
  const nodes = Number(og.nodes) || 0;
  let s = `Walk through ${plural(rooms, "room", "rooms")} from ${plural(nodes, "standpoint", "standpoints")}`;
  const when = prettyDate(og.photographed_at);
  if (when) s += ` — photographed ${when}`;
  s += ".";
  if (og.agency) s += ` Tour by ${og.agency}.`;
  return s;
}

function meta(prop, content, attr = "property") {
  return `<meta ${attr}="${esc(prop)}" content="${esc(content)}">`;
}

/* Build the <head> block for one tour. `og` is the m3ix-spatial payload, or
   null when the tour is unknown / not open to this caller. */
function headBlock({ slug, vk, og, noindex, failed }) {
  const lines = [];
  lines.push(`<script>window.__M3IX_TOUR=${jsLiteral({ slug, vk: vk || "" })}</script>`);
  if (failed) return lines.join("\n"); // upstream down: shell stays otherwise unmodified

  const url = `${SITE}/tour/${encodeURIComponent(slug)}`;
  const title = og ? String(og.address || og.title || "Property tour") : "Property tour";
  const description = og
    ? describe(og)
    : "This tour is not available. Ask the estate agent for a current link.";

  lines.push(`<title>${esc(title)}</title>`);
  lines.push(meta("og:title", title));
  lines.push(meta("og:description", description));
  lines.push(meta("description", description, "name"));
  if (og && og.image) lines.push(meta("og:image", og.image));
  lines.push(meta("og:type", "website"));
  lines.push(meta("og:url", url));
  lines.push(meta("og:site_name", "M3XI"));
  lines.push(meta("twitter:card", "summary_large_image", "name"));
  if (noindex) lines.push(`<meta name="robots" content="noindex">`);
  else lines.push(`<link rel="canonical" href="${esc(url)}">`);
  return lines.join("\n");
}

/* Put the block into the shell: at the <!-- og --> marker if the shell has one,
   otherwise straight after <head> (or its leading <meta charset>). The shell's
   own <title> is removed so the injected one is the only title the browser
   sees. */
function inject(shell, block, { replaceTitle }) {
  let html = shell;
  if (replaceTitle) html = html.replace(/<title>[\s\S]*?<\/title>\s*/i, "");
  if (html.includes(OG_MARKER)) return html.replace(OG_MARKER, block);
  // After <meta charset> when it is the first thing in <head>, so the charset
  // declaration stays inside the first 1024 bytes browsers scan for it.
  const m = html.match(/<head[^>]*>(\s*<meta\s+charset=[^>]*>)?/i);
  if (m) return html.slice(0, m.index + m[0].length) + "\n" + block + html.slice(m.index + m[0].length);
  return block + html; // no <head> at all — still make the slug reachable
}

/* Minimal page used only when the real shell cannot be fetched at all: send
   the buyer on to the static viewer, which reads ?t= itself. */
function emergencyShell(slug, vk) {
  const q = `t=${encodeURIComponent(slug)}${vk ? `&vk=${encodeURIComponent(vk)}` : ""}`;
  const target = `/tour/?${q}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Property tour</title>` +
    `<meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${esc(target)}">` +
    `<script>window.__M3IX_TOUR=${jsLiteral({ slug, vk: vk || "" })};location.replace(${jsLiteral(target)})</script>` +
    `</head><body style="font-family:system-ui;padding:24px">Opening the tour… <a href="${esc(target)}">Continue</a></body></html>`;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function readQuery(req) {
  const q = req.query || {};
  let slug = first(q.slug);
  let vk = first(q.vk);
  if (slug === undefined || vk === undefined) {
    try {
      const u = new URL(req.url || "/", "http://x");
      if (slug === undefined) slug = u.searchParams.get("slug");
      if (vk === undefined) vk = u.searchParams.get("vk");
    } catch {
      /* ignore */
    }
  }
  slug = String(slug ?? "").trim().toLowerCase();
  vk = String(vk ?? "").trim();
  return { slug, vk };
}

/* Where to fetch the shell from. In production, always the live site. Anywhere
   else (vercel preview, local runner) try the request's own origin first so a
   preview deployment shows its own shell, then fall back to the live site. */
function shellUrls(req) {
  const live = SITE + SHELL_PATH;
  if (process.env.VERCEL_ENV === "production") return [live];
  const h = req.headers || {};
  const host = first(h["x-forwarded-host"]) || first(h.host);
  if (!host) return [live]; // local runner with no headers
  const proto = first(h["x-forwarded-proto"]) || (/^(localhost|127\.)/.test(host) ? "http" : "https");
  const own = `${proto}://${host}${SHELL_PATH}`;
  return own === live ? [live] : [own, live];
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const { slug, vk } = readQuery(req);
  const validSlug = SLUG_RE.test(slug);

  // Shell and share card in parallel; neither blocks the other.
  const [shell, og] = await Promise.all([
    getShell(shellUrls(req)),
    validSlug ? fetchOg(slug, vk) : Promise.resolve({ status: 404, data: null }),
  ]);

  const ok = og.status === 200 && og.data && !og.data.error;
  const notOpen = og.status === 403 || og.status === 404;
  const failed = !ok && !notOpen; // 0 (network), 5xx, 4xx we did not expect
  // Preview links (vk) are unlisted by definition — never let a crawler keep one.
  const noindex = notOpen || Boolean(vk);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", failed ? "no-store" : CACHE_CONTROL);
  if (noindex) res.setHeader("X-Robots-Tag", "noindex");

  if (!shell) {
    res.setHeader("Cache-Control", "no-store");
    return res.end(method === "HEAD" ? undefined : emergencyShell(slug, vk));
  }

  const block = headBlock({ slug, vk, og: ok ? og.data : null, noindex, failed });
  const html = inject(shell, block, { replaceTitle: !failed });
  return res.end(method === "HEAD" ? undefined : html);
}
