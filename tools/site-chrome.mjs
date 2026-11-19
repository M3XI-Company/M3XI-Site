/*
 * m3xi.com — the one header and footer, stamped into every root page.
 *
 *   node tools/site-chrome.mjs        rewrite the <header class="m3-head"> and
 *                                     <footer class="m3-foot"> of every page below
 *
 * The pages are plain HTML (Vite bundles them as they are), so the chrome is
 * copied into each one. Change the nav HERE and run the script, rather than
 * editing sixteen files by hand. tools/build-team.mjs imports header() and
 * footer() for the pages it generates.
 *
 * Nav: Products (Software products: Breeze, CallMe; then CallMe's Create and
 * Events), Team, Careers, Help. The logo is the way home (the M3XI homepage). The button on the right is "Get CallMe" on
 * CallMe's pages and "Join the waitlist" (Breeze) everywhere else.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// path: the page's own URL. cta: which button the header carries.
export const PAGES = {
  "index.html": { path: "/", cta: "breeze" },
  "breeze/index.html": { path: "/breeze/", cta: "breeze" },
  "callme/index.html": { path: "/callme/", cta: "callme" },
  "design/index.html": { path: "/design/", cta: "callme" },
  "events/index.html": { path: "/events/", cta: "callme" },
  "e/index.html": { path: "/e/", cta: "callme" },
  "j/index.html": { path: "/j/", cta: "callme" },
  "questions/index.html": { path: "/questions/", cta: "callme" },
  "safety/index.html": { path: "/safety/", cta: "callme" },
  "delete-account/index.html": { path: "/delete-account/", cta: "breeze" },
  "child-safety/index.html": { path: "/child-safety/", cta: "breeze" },
  "privacy/index.html": { path: "/privacy/", cta: "breeze" },
  "terms/index.html": { path: "/terms/", cta: "breeze" },
  "contact/index.html": { path: "/contact/", cta: "breeze" },
  "jobs/index.html": { path: "/jobs/", cta: "breeze" },
};

const PRODUCTS = ["/breeze/", "/callme/", "/design/", "/events/", "/e/", "/j/"];
const HELP = ["/questions/", "/safety/", "/contact/"];

const cur = (href, path) => (href === path ? ' aria-current="page"' : "");

export function header({ path, cta = "breeze", section }) {
  // `section` lets a generated page (a team profile) light up a top-level entry
  // that is not its own URL.
  const here = section || path;
  const inProducts = PRODUCTS.includes(here);
  const inHelp = HELP.includes(here);
  const button = cta === "callme"
    ? '<a class="m3-get" href="https://play.google.com/store/apps/details?id=com.m3xi.callme" rel="noopener">Get CallMe</a>'
    : '<a class="m3-get m3-get--breeze" href="/breeze/#waitlist">Join the waitlist</a>';
  return `<header class="m3-head"><div class="m3-bar">
  <a class="m3-brand" href="/"><img src="/M.png" alt="" width="30" height="30"> M3XI <span class="m3-jp" aria-hidden="true">三X一</span></a>
  <nav class="m3-nav" aria-label="Main">
    <ul class="m3-links">
      <li class="m3-prod">
        <details class="m3-drop${inProducts ? " m3-here" : ""}">
          <summary>Products</summary>
          <div class="m3-menu m3-menu--left">
            <p class="m3-menu-h">Software products</p>
            <ul>
              <li><a href="/breeze/"${cur("/breeze/", path)}><b>Breeze</b><small>Your AI fitness coach. Join the waitlist</small></a></li>
              <li><a href="/callme/"${cur("/callme/", path)}><b>CallMe</b><small>Video call new people</small></a></li>
            </ul>
            <p class="m3-menu-h">More from CallMe</p>
            <ul>
              <li><a href="/design/"${cur("/design/", path)}><b>Create</b><small>Design your own cards</small></a></li>
              <li><a href="/events/"${cur("/events/", path)}><b>Events</b><small>What&rsquo;s on</small></a></li>
            </ul>
          </div>
        </details>
      </li>
      <li><a href="/team/"${cur("/team/", here)}>Team</a></li>
      <li><a href="/jobs/"${cur("/jobs/", here)}>Careers</a></li>
      <li class="m3-help">
        <details class="m3-drop${inHelp ? " m3-here" : ""}">
          <summary>Help</summary>
          <ul class="m3-menu">
            <li><a href="/questions/"${cur("/questions/", path)}><b>Questions</b><small>The short answers about CallMe</small></a></li>
            <li><a href="/safety/"${cur("/safety/", path)}><b>Safety</b><small>How we keep calls safe</small></a></li>
            <li><a href="/contact/"${cur("/contact/", path)}><b>Contact</b><small>Write to a person at M3XI</small></a></li>
          </ul>
        </details>
      </li>
    </ul>
  </nav>
  ${button}
</div></header>`;
}

export function footer({ path, cta = "breeze" }) {
  const a = (href, label) => `<li><a href="${href}"${cur(href, path)}>${label}</a></li>`;
  // CallMe's pages get the two store cards under the logo (site-chrome.js adds
  // them); the company and Breeze pages do not.
  const stores = cta === "callme" ? "" : ' data-stores="off"';
  return `<footer class="m3-foot"${stores}><div class="m3-footin">
  <div>
    <a class="m3-brand" href="/"><img src="/M.png" alt="" width="26" height="26"> M3XI</a>
    <p class="m3-tag">We are connected.</p>
    <p class="m3-copy">&copy; <span id="year">2026</span> M3XI LTD &middot; London, United Kingdom</p>
  </div>
  <nav class="m3-footnav" aria-label="Footer">
    <div><p class="m3-fh">Products</p><ul>
      ${a("/breeze/", "Breeze")}
      ${a("/callme/", "CallMe")}
      ${a("/design/", "CallMe Create")}
      ${a("/events/", "CallMe Events")}
    </ul></div>
    <div><p class="m3-fh">Help</p><ul>
      ${a("/questions/", "Questions")}
      ${a("/safety/", "Safety")}
      ${a("/contact/", "Contact")}
      ${a("/delete-account/", "Delete account")}
    </ul></div>
    <div><p class="m3-fh">M3XI</p><ul>
      ${a("/", "About M3XI")}
      ${a("/team/", "Team")}
      ${a("/jobs/", "Careers")}
    </ul></div>
    <div><p class="m3-fh">Legal</p><ul>
      ${a("/privacy/", "Policies")}
      ${a("/terms/", "Terms")}
      ${a("/child-safety/", "Child safety")}
    </ul></div>
  </nav>
</div></footer>`;
}

const HEAD_RE = /<header class="m3-head">[\s\S]*?<\/header>/;
const FOOT_RE = /<footer class="m3-foot"[^>]*>[\s\S]*?<\/footer>/;

export function stamp(html, opts) {
  if (!HEAD_RE.test(html) || !FOOT_RE.test(html)) throw new Error("no shared header/footer found");
  return html.replace(HEAD_RE, () => header(opts)).replace(FOOT_RE, () => footer(opts));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, opts] of Object.entries(PAGES)) {
    const p = resolve(root, file);
    let html;
    try { html = readFileSync(p, "utf8"); } catch { console.warn("skip (missing): " + file); continue; }
    const old = html.match(FOOT_RE);
    if (old && /data-store=/.test(old[0])) console.warn("note: " + file + " had its own store badges in the footer");
    const next = stamp(html, opts);
    if (next !== html) { writeFileSync(p, next); console.log("stamped " + file); }
  }
}
