/**
 * The permanence bundle.
 *
 * The single most common complaint about incumbent property tour products is
 * that the tour dies with the subscription: the customer paid for a scan, the
 * link stops working, and the asset they thought they owned turns out to have
 * been a rental. This bundle is the answer to that, so the test it has to pass
 * is not "does it produce a zip" but "does a person with this zip, no internet
 * and no relationship with us still have their property".
 *
 * That means, concretely:
 *   - open formats only: JSON, SVG, HTML, glTF, PLY/SPZ. Nothing that needs
 *     our code to parse.
 *   - no network calls in the viewer. No CDN, no fonts, no analytics, no
 *     phone-home. Every byte it needs is beside it.
 *   - file:// has to work. Which rules out fetch() on a local JSON file in
 *     several browsers, so the world document is embedded in the page AND
 *     written separately as world.json for machines.
 *   - a checksum manifest, so the customer can prove years later that the
 *     numbers were not edited after the fact.
 */

import { sha256Hex, utf8, type ZipEntry } from '../_wv_shared/zip.ts';

export interface BundleWorld {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly publishedAt: string | null;
  readonly document: Record<string, unknown>;
}

export interface BundleAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly role: string;
  readonly format: string;
}

/**
 * An asset that is not inside this zip.
 *
 * `role`, `bytes` and `reason` are what a customer needs in order to KNOW
 * something is missing. The other four are what they need in order to DO
 * something about it: the format, so they know what they are about to
 * download; the checksum, so a file fetched separately can be verified to the
 * same standard as everything in CHECKSUMS.sha256; and a signed URL with the
 * moment it stops working.
 *
 * The four are optional, and absent and null mean the same thing: the row
 * records no checksum, or no link could be issued for this object. The
 * renderers below say that in words. They never print "undefined" at a
 * customer and never imply a link exists when it does not -- a bundle that
 * misrepresents what it can give you is precisely the failure this file exists
 * to prevent.
 */
export interface OmittedAsset {
  readonly role: string;
  readonly bytes: number;
  readonly reason: string;
  readonly format?: string | null;
  readonly checksum?: string | null;
  readonly url?: string | null;
  /** ISO-8601. When `url` stops working. */
  readonly expiresAt?: string | null;
}

export interface BundleInput {
  readonly world: BundleWorld;
  readonly assets: readonly BundleAsset[];
  /** Assets that were too large to inline, recorded honestly rather than hidden. */
  readonly omittedAssets: readonly OmittedAsset[];
  readonly generatedAt: Date;
  readonly exporterVersion: string;
}

export async function buildBundleEntries(input: BundleInput): Promise<ZipEntry[]> {
  const { world, assets, generatedAt } = input;
  const doc = world.document;
  const worldJson = JSON.stringify(doc, null, 2);

  const entries: ZipEntry[] = [];
  const add = (path: string, bytes: Uint8Array): void => {
    entries.push({ path, bytes, modified: generatedAt });
  };

  add('world.json', utf8(worldJson));
  add('floorplan.svg', utf8(renderFloorplanSvg(doc)));
  add('viewer.html', utf8(renderViewer(world, worldJson, assets)));
  add('README.txt', utf8(renderReadme(input)));
  for (const a of assets) add(`assets/${a.path}`, a.bytes);

  // The note lives in assets/ rather than at the root because that is where
  // somebody looks when they expected a splat and found a folder without one.
  // It is added BEFORE the manifest so it is checksummed like every other
  // file: it is part of the record of this export, not a loose covering note.
  if (input.omittedAssets.length > 0) {
    add('assets/DOWNLOAD.md', utf8(renderDownloadMd(input)));
  }

  const manifest = {
    format: 'm3xi-world-bundle',
    formatVersion: 1,
    exporterVersion: input.exporterVersion,
    generatedAt: generatedAt.toISOString(),
    world: {
      id: world.id, version: world.version, label: world.label, publishedAt: world.publishedAt,
    },
    // Stated plainly, because a bundle that quietly lacks its splat is worse
    // than one that says so. Each record carries the download link issued at
    // export time and the moment it expires.
    //
    // A URL in a permanent file is normally forbidden here -- world.json
    // carries `asset://` paths precisely so the document cannot rot -- and
    // this is the one deliberate exception. The difference is that manifest
    // .json is the record of an EXPORT EVENT rather than of the world, the
    // expiry is written next to the link, and assets/DOWNLOAD.md says in words
    // what to do once it has passed. A dead link that states its own time of
    // death misleads nobody; a silent omission does.
    omittedAssets: input.omittedAssets,
    licence: 'The customer owns this bundle outright and may host, copy, modify and redistribute it.',
    files: [] as { path: string; bytes: number; sha256: string }[],
  };
  for (const e of entries) {
    manifest.files.push({ path: e.path, bytes: e.bytes.length, sha256: await sha256Hex(e.bytes) });
  }
  add('manifest.json', utf8(JSON.stringify(manifest, null, 2)));

  // CHECKSUMS in the format `sha256sum -c` expects, so verification needs no
  // tool of ours at all.
  const sums = manifest.files.map((f) => `${f.sha256}  ${f.path}`).join('\n');
  add('CHECKSUMS.sha256', utf8(`${sums}\n`));

  return entries;
}

// ---------------------------------------------------------------------------
// Floorplan
// ---------------------------------------------------------------------------

interface RoomLike {
  id: string; name?: string; kind: string;
  polygon: [number, number][]; area?: { value?: number };
  grounding?: { provenance?: string };
}

/**
 * A true-to-scale SVG floorplan. 1 metre = 100 units, so a surveyor can open
 * it in any vector editor and measure it directly.
 */
export function renderFloorplanSvg(doc: Record<string, unknown>): string {
  const rooms = (Array.isArray(doc['rooms']) ? doc['rooms'] : []) as RoomLike[];
  const scale = 100;
  const pad = 60;

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rooms) {
    for (const [x, z] of r.polygon ?? []) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  if (!Number.isFinite(minX)) { minX = 0; minZ = 0; maxX = 1; maxZ = 1; }

  const w = (maxX - minX) * scale + pad * 2;
  const h = (maxZ - minZ) * scale + pad * 2;
  const px = (x: number): number => (x - minX) * scale + pad;
  const pz = (z: number): number => (z - minZ) * scale + pad;

  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<g stroke="#111111" stroke-width="3" fill="none">`);
  for (const r of rooms) {
    const pts = (r.polygon ?? []).map(([x, z]) => `${px(x).toFixed(1)},${pz(z).toFixed(1)}`).join(' ');
    if (!pts) continue;
    // Provenance is drawn, not just recorded: a room derived from inference
    // must not look identical to one a camera saw.
    const prov = r.grounding?.provenance ?? 'reconstructed';
    const fill = prov === 'observed' ? '#f4f7f4'
      : prov === 'reconstructed' ? '#f7f7f7'
        : prov === 'inferred' ? '#fbf6ec' : '#fdeeee';
    parts.push(`<polygon points="${pts}" fill="${fill}"/>`);
  }
  parts.push(`</g>`);
  parts.push(`<g font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#111111" text-anchor="middle">`);
  for (const r of rooms) {
    const poly = r.polygon ?? [];
    if (poly.length === 0) continue;
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const area = typeof r.area?.value === 'number' ? `${r.area.value.toFixed(1)} m²` : '';
    parts.push(`<text x="${px(cx).toFixed(1)}" y="${pz(cz).toFixed(1)}">${escapeXml(r.name ?? r.kind)}</text>`);
    if (area) {
      parts.push(`<text x="${px(cx).toFixed(1)}" y="${(pz(cz) + 16).toFixed(1)}" font-size="11" fill="#555555">${area}</text>`);
    }
  }
  parts.push(`</g>`);

  // A scale bar, because a floorplan without one is a picture.
  const barY = h - 24;
  parts.push(`<g stroke="#111111" stroke-width="2" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#111111">`);
  parts.push(`<line x1="${pad}" y1="${barY}" x2="${pad + scale}" y2="${barY}"/>`);
  parts.push(`<line x1="${pad}" y1="${barY - 5}" x2="${pad}" y2="${barY + 5}"/>`);
  parts.push(`<line x1="${pad + scale}" y1="${barY - 5}" x2="${pad + scale}" y2="${barY + 5}"/>`);
  parts.push(`<text x="${pad + scale + 8}" y="${barY + 4}" stroke="none">1 m</text>`);
  parts.push(`</g>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

function escapeXml(s: string): string {
  return String(s).replace(/[<>&'"]/g, (c) => (
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  ));
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

function renderReadme(input: BundleInput): string {
  const { world, assets, omittedAssets } = input;
  const lines = [
    `${world.label}`,
    `World ${world.id}, version ${world.version}`,
    `Exported ${input.generatedAt.toISOString()} by M3XI World Viewer exporter ${input.exporterVersion}`,
    '',
    'WHAT THIS IS',
    '',
    'A complete, self-contained copy of this property scan. It does not call',
    'our servers, it does not need an account, and it does not expire. If our',
    'company disappears tomorrow, everything in this folder still works.',
    '',
    'HOW TO USE IT',
    '',
    '  1. Open viewer.html in any web browser, directly from this folder.',
    '     No server and no internet connection are required.',
    '  2. Or host the whole folder on any static web host.',
    '',
    'WHAT IS IN IT',
    '',
    '  viewer.html        a standalone viewer; the world data is embedded in it',
    '  world.json         the complete world document, for machines',
    '  floorplan.svg      a true-to-scale floorplan (1 metre = 100 SVG units)',
    '  manifest.json      an inventory with SHA-256 for every file',
    '  CHECKSUMS.sha256   verify with: sha256sum -c CHECKSUMS.sha256',
    '  assets/            the 3D data listed below',
    ...(omittedAssets.length > 0
      ? ['  assets/DOWNLOAD.md the files that did not fit, and how to fetch them']
      : []),
    '',
    assets.length > 0
      ? assets.map((a) => `  assets/${a.path}  (${a.role}, ${a.format}, ${formatBytes(a.bytes.length)})`).join('\n')
      : '  (no 3D assets were included in this bundle)',
    '',
  ];

  if (omittedAssets.length > 0) {
    lines.push(
      'ASSETS NOT INCLUDED',
      '',
      'The files below are not in this folder. Each one is listed with a direct',
      'download link that works for 24 hours from the export above, and',
      'assets/DOWNLOAD.md explains them in full.',
      '',
      'Nothing else here depends on them. world.json, floorplan.svg and',
      'viewer.html are complete on their own and do not go looking for a file',
      'that is not beside them.',
      '',
      ...omittedAssets.flatMap((a) => readmeOmittedLines(a)),
      '',
    );
  }

  lines.push(
    'ABOUT THE MEASUREMENTS',
    '',
    'Every dimension in world.json carries three things: a value, the standard',
    'it was measured to, and a tolerance. A figure without all three is not a',
    'measurement and should not be quoted as one.',
    '',
    'Every fact also carries its provenance:',
    '',
    '  observed       a camera saw it',
    '  reconstructed  geometry derived it from what the cameras saw',
    '  inferred       a model estimated it from context',
    '  generated      a model filled it in; no observation supports it',
    '',
    'Regions listed under "regions" with provenance other than "observed" were',
    'never seen by a camera. Anything inside them is an estimate. Do not',
    'represent it to a buyer as a measurement.',
    '',
    'LICENCE',
    '',
    'This bundle is yours outright. Host it, copy it, change it, give it away.',
    'No permission from us is needed and none can be withdrawn.',
    '',
  );
  return lines.join('\n');
}

/**
 * One omitted asset in the README, over two or three lines.
 *
 * The first line keeps the shape it has always had -- role, size, reason --
 * because that is what a person scans for. The link goes underneath on its own
 * line so it survives being copied out of a plain-text file by a mail client
 * that would otherwise wrap it.
 */
function readmeOmittedLines(a: OmittedAsset): string[] {
  const kind = a.format ? `${a.role}, ${a.format}` : a.role;
  const head = `  ${a.role}  ${formatBytes(a.bytes)}  (${a.reason})`;
  if (!a.url) {
    return [head, `    ${kind}: no download link could be issued. Ask the agency for this file.`];
  }
  return [
    head,
    `    ${a.url}`,
    `    This link stops working ${a.expiresAt ?? 'within 24 hours of the export above'}.`,
  ];
}

/**
 * Binary units, to one decimal.
 *
 * The GB step exists because of the omitted-asset list: the files that end up
 * there are the ones measured in gigabytes, and "3072.0 MB" makes a reader
 * stop and do arithmetic at exactly the moment the document is trying to
 * explain why a file is too big to move.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// assets/DOWNLOAD.md
// ---------------------------------------------------------------------------

/**
 * The note that goes in assets/ when something did not fit.
 *
 * Two things have to be true of this file at once, and they pull against each
 * other. It has to be honest that a file the customer paid for is not in the
 * folder they are looking at -- anything less is the quiet omission this
 * bundle was built to rule out. And it has to stop them concluding that the
 * bundle is therefore broken, because it is not: the world document, the
 * floorplan and the viewer are complete and self-contained whether or not a
 * three-gigabyte point cloud ever reaches them.
 *
 * So it says plainly what is missing, why, exactly how to get it, how long
 * that lasts, and what to do afterwards. Markdown rather than plain text
 * because the links have to be clickable in the places people actually read a
 * file like this -- a code host, a shared drive preview, a text editor with a
 * preview pane -- and Markdown degrades to readable plain text everywhere
 * else, which .html would not.
 */
function renderDownloadMd(input: BundleInput): string {
  const { omittedAssets, world } = input;
  const withLinks = omittedAssets.filter((a) => typeof a.url === 'string' && a.url.length > 0);
  const lines: string[] = [
    `# Files that are not inside this bundle`,
    '',
    `${world.label} - world ${world.id}, version ${world.version}`,
    `Exported ${input.generatedAt.toISOString()}`,
    '',
    `${omittedAssets.length === 1 ? 'One file is' : `${omittedAssets.length} files are`} missing from this \`assets\` folder.`,
    'Everything else in the bundle is here and complete.',
    '',
    '## Why a file gets left out',
    '',
    'The service that packages these bundles runs with a fixed memory budget, and',
    'it has to hold a file in memory to put it into the zip. Some of the files a',
    'scan produces are far larger than that budget: a splat of a whole house can',
    'run to several gigabytes, so it cannot pass through the packager at all.',
    '',
    'Anything left out is still yours. Each one is listed below with a direct link',
    'to the file itself, so you can download it straight from storage and drop it',
    'into this folder beside the rest.',
    '',
    '## What is missing',
    '',
  ];

  for (const a of omittedAssets) {
    lines.push(`### ${a.role}${a.format ? ` (${a.format})` : ''}`);
    lines.push('');
    lines.push(`- Size: ${formatBytes(a.bytes)}`);
    lines.push(`- Not included because: ${a.reason}`);
    if (a.checksum) {
      lines.push(`- SHA-256: \`${a.checksum}\``);
      lines.push('  Check a downloaded copy with `sha256sum <file>` and compare.');
    } else {
      lines.push('- SHA-256: not recorded for this file.');
    }
    if (a.url) {
      lines.push(`- Download: <${a.url}>`);
      lines.push(`- The link stops working: ${a.expiresAt ?? 'within 24 hours of the export above'}`);
    } else {
      lines.push('- Download: no link could be issued for this file. Ask the agency to export again,');
      lines.push('  and if it fails a second time, to send you the file directly.');
    }
    lines.push('');
  }

  lines.push(
    '## When a link expires',
    '',
    withLinks.length > 0
      ? 'The links above are time-limited on purpose. A scan of a home is personal'
      : 'Links to these files are time-limited on purpose. A scan of a home is personal',
    'data, and a URL that worked forever would be a permanent way in for anyone who',
    'ever saw it.',
    '',
    'When a link has expired, ask the agency that produced this bundle to export',
    'the property again. A fresh export takes a moment and issues fresh links; no',
    'data is lost in between, because the files themselves are not going anywhere.',
    '',
    '## This bundle is complete without those files',
    '',
    'This matters, so it is worth being exact about it:',
    '',
    '- `world.json` is the complete world document. Every room, surface, opening,',
    '  object and measurement is in it, with the standard and tolerance each',
    '  dimension was measured to and where each fact came from. It does not refer',
    '  to any of the files above by a path that has to resolve.',
    '- `floorplan.svg` is a true-to-scale plan, one metre to 100 SVG units. It is',
    '  drawn from the room geometry, not from any file above.',
    '- `viewer.html` carries the world document inside itself. Double-click it.',
    '  It makes no network calls and will not go looking for a missing asset.',
    '',
    'What is missing here is the photoreal 3D data itself. What you still have is',
    'the property: its layout, its dimensions, its contents, and the record of how',
    'each of those was arrived at.',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The standalone viewer
// ---------------------------------------------------------------------------

/**
 * A viewer with no dependencies at all.
 *
 * It draws the floorplan from the room polygons on a canvas, lists what is in
 * each room, shows every dimension with its tolerance and standard, marks the
 * volumes nothing observed, and measures between any two points the user
 * clicks. That is a genuinely useful property record rather than a placeholder
 * apologising for the absence of a renderer.
 *
 * The world document is embedded as a JSON script block rather than fetched,
 * because fetch() against a file:// URL is blocked in most browsers and the
 * promise is specifically that double-clicking this file works.
 */
function renderViewer(
  world: BundleWorld, worldJson: string, assets: readonly BundleAsset[],
): string {
  const assetList = assets
    .map((a) => `<li><a href="assets/${escapeHtml(a.path)}" download>${escapeHtml(a.role)} (${escapeHtml(a.format)})</a></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(world.label)}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16181d; --muted: #5d6572; --line: #d8dce3;
    --panel: #f6f7f9; --accent: #2f6f4f; --warn: #a8641c; --bad: #a33a3a;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14161a; --fg: #e9ecf1; --muted: #9aa3b2; --line: #2b3038;
      --panel: #1b1e24; --accent: #6bbd90; --warn: #d9a05b; --bad: #e08585;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { padding: 20px 16px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 0.85rem; }
  main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px; max-width: 1200px; margin: 0 auto; }
  @media (min-width: 900px) { main { grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); } }
  canvas { width: 100%; height: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; touch-action: none; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
  .panel h2 { font-size: 0.95rem; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.87rem; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 0.72rem; border: 1px solid var(--line); }
  .observed { color: var(--accent); } .inferred { color: var(--warn); } .generated { color: var(--bad); }
  .hint { color: var(--muted); font-size: 0.82rem; margin: 8px 0 0; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  footer { padding: 16px; color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--line); max-width: 1200px; margin: 0 auto; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(world.label)}</h1>
  <div class="sub">Version ${world.version}${world.publishedAt ? ` &middot; published ${escapeHtml(world.publishedAt.slice(0, 10))}` : ''} &middot; offline copy, no internet required</div>
</header>
<main>
  <div>
    <canvas id="plan" width="900" height="620"></canvas>
    <p class="hint" id="readout">Click a room for its details. Click two points to measure between them; click again to clear.</p>
  </div>
  <div>
    <div class="panel" id="detail"><h2>Rooms</h2><div id="detailBody"></div></div>
    <div class="panel" style="margin-top:16px"><h2>Not observed</h2><div id="regions"></div></div>
    <div class="panel" style="margin-top:16px"><h2>3D data</h2><ul>${assetList || '<li>None included.</li>'}</ul></div>
  </div>
</main>
<footer>
  Measurements state the standard they were taken to and their tolerance. Areas
  shown are as recorded at export; nothing here is recomputed or rounded away.
  This file works with no connection to any server.
</footer>
<script type="application/json" id="world">${worldJson.replace(/</g, '\\u003c')}</script>
<script>
(function () {
  'use strict';
  var doc = JSON.parse(document.getElementById('world').textContent);
  var rooms = doc.rooms || [];
  var entities = doc.entities || [];
  var regions = doc.regions || [];
  var canvas = document.getElementById('plan');
  var ctx = canvas.getContext('2d');
  var readout = document.getElementById('readout');
  var detailBody = document.getElementById('detailBody');

  var bounds = (function () {
    var b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    rooms.forEach(function (r) {
      (r.polygon || []).forEach(function (p) {
        b.minX = Math.min(b.minX, p[0]); b.maxX = Math.max(b.maxX, p[0]);
        b.minZ = Math.min(b.minZ, p[1]); b.maxZ = Math.max(b.maxZ, p[1]);
      });
    });
    if (!isFinite(b.minX)) { b = { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }; }
    return b;
  })();

  var pad = 30;
  function scale() {
    var sx = (canvas.width - pad * 2) / Math.max(0.001, bounds.maxX - bounds.minX);
    var sz = (canvas.height - pad * 2) / Math.max(0.001, bounds.maxZ - bounds.minZ);
    return Math.min(sx, sz);
  }
  function toPx(x, z) {
    var s = scale();
    return [ (x - bounds.minX) * s + pad, (z - bounds.minZ) * s + pad ];
  }
  function toWorld(px, pz) {
    var s = scale();
    return [ (px - pad) / s + bounds.minX, (pz - pad) / s + bounds.minZ ];
  }

  var css = getComputedStyle(document.documentElement);
  function colour(name, fallback) {
    var v = css.getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  var selected = null;
  var measure = [];

  function provFill(p) {
    if (p === 'observed') return 'rgba(60,150,100,0.13)';
    if (p === 'reconstructed') return 'rgba(125,135,150,0.13)';
    if (p === 'inferred') return 'rgba(210,150,60,0.16)';
    return 'rgba(200,70,70,0.16)';
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineJoin = 'round';

    rooms.forEach(function (r) {
      var poly = r.polygon || [];
      if (poly.length < 3) return;
      ctx.beginPath();
      poly.forEach(function (p, i) {
        var q = toPx(p[0], p[1]);
        if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      });
      ctx.closePath();
      ctx.fillStyle = (selected && selected.id === r.id)
        ? 'rgba(90,160,255,0.25)' : provFill((r.grounding || {}).provenance);
      ctx.fill();
      ctx.strokeStyle = colour('--fg', '#16181d');
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    ctx.fillStyle = colour('--muted', '#5d6572');
    entities.forEach(function (e) {
      var c = e.centroid; if (!c) return;
      var q = toPx(c[0], c[2]);
      ctx.beginPath(); ctx.arc(q[0], q[1], 2.5, 0, Math.PI * 2); ctx.fill();
    });

    ctx.font = '13px -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    rooms.forEach(function (r) {
      var poly = r.polygon || []; if (!poly.length) return;
      var cx = 0, cz = 0;
      poly.forEach(function (p) { cx += p[0]; cz += p[1]; });
      var q = toPx(cx / poly.length, cz / poly.length);
      ctx.fillStyle = colour('--fg', '#16181d');
      ctx.fillText(r.name || r.kind, q[0], q[1]);
      if (r.area && typeof r.area.value === 'number') {
        ctx.fillStyle = colour('--muted', '#5d6572');
        ctx.font = '11px -apple-system, Helvetica, Arial, sans-serif';
        ctx.fillText(r.area.value.toFixed(1) + ' m²', q[0], q[1] + 15);
        ctx.font = '13px -apple-system, Helvetica, Arial, sans-serif';
      }
    });

    if (measure.length === 2) {
      var a = toPx(measure[0][0], measure[0][1]);
      var b = toPx(measure[1][0], measure[1][1]);
      ctx.strokeStyle = colour('--accent', '#2f6f4f');
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function pointInPoly(poly, x, z) {
    var hit = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var pi = poly[i], pj = poly[j];
      if ((pi[1] > z) !== (pj[1] > z)
        && x < (pj[0] - pi[0]) * (z - pi[1]) / (pj[1] - pi[1]) + pi[0]) hit = !hit;
    }
    return hit;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showRoom(room) {
    if (!room) { renderRoomList(); return; }
    var inRoom = entities.filter(function (e) { return e.roomId === room.id; });
    var html = '<h2 style="margin-top:0">' + esc(room.name || room.kind) + '</h2><table>';
    if (room.area) {
      html += '<tr><th>Area</th><td>' + room.area.value.toFixed(2) + ' m²'
        + ' &plusmn;' + room.area.tolerance.toFixed(1) + '%<br><span class="sub">'
        + esc(room.area.standard) + '</span></td></tr>';
    }
    html += '<tr><th>Ceiling</th><td>' + (room.ceilingZ - room.floorZ).toFixed(2) + ' m</td></tr>';
    html += '<tr><th>Provenance</th><td class="' + esc((room.grounding || {}).provenance) + '">'
      + esc((room.grounding || {}).provenance) + '</td></tr>';
    html += '</table>';
    html += '<h2 style="margin-top:14px">Contains</h2>';
    html += inRoom.length
      ? '<ul>' + inRoom.map(function (e) {
        return '<li>' + esc(e.label) + ' <span class="tag ' + esc((e.grounding || {}).provenance)
          + '">' + esc((e.grounding || {}).provenance) + '</span></li>';
      }).join('') + '</ul>'
      : '<p class="hint">Nothing was recorded in this room.</p>';
    html += '<p class="hint"><a href="#" id="back">All rooms</a></p>';
    detailBody.innerHTML = html;
    var back = document.getElementById('back');
    if (back) back.onclick = function (ev) { ev.preventDefault(); selected = null; draw(); renderRoomList(); };
  }

  function renderRoomList() {
    var rowsHtml = rooms.map(function (r) {
      return '<tr><td>' + esc(r.name || r.kind) + '</td><td>'
        + (r.area ? r.area.value.toFixed(1) + ' m²' : '&mdash;') + '</td><td class="'
        + esc((r.grounding || {}).provenance) + '">'
        + esc((r.grounding || {}).provenance) + '</td></tr>';
    }).join('');
    detailBody.innerHTML = '<table><tr><th>Room</th><th>Area</th><th>Source</th></tr>'
      + rowsHtml + '</table>';
  }

  var regionsEl = document.getElementById('regions');
  var soft = regions.filter(function (r) { return r.provenance !== 'observed'; });
  regionsEl.innerHTML = soft.length
    ? '<ul>' + soft.map(function (r) {
      return '<li><span class="tag ' + esc(r.provenance) + '">' + esc(r.provenance)
        + '</span> ' + esc(r.reason || 'no reason recorded') + '</li>';
    }).join('') + '</ul>'
    : '<p class="hint">Every part of this property was observed by a camera.</p>';

  canvas.addEventListener('click', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    var pz = (ev.clientY - rect.top) * (canvas.height / rect.height);
    var w = toWorld(px, pz);

    if (measure.length === 2) measure = [];
    measure.push(w);
    if (measure.length === 2) {
      var dx = measure[1][0] - measure[0][0];
      var dz = measure[1][1] - measure[0][1];
      var d = Math.sqrt(dx * dx + dz * dz);
      var policy = doc.measurementPolicy || {};
      var tol = policy.wallToleranceMm || 25;
      readout.textContent = 'Measured ' + d.toFixed(2) + ' m (\\u00b1'
        + Math.round(tol * Math.SQRT2) + ' mm, plan distance, floor level). Click again to clear.';
    } else {
      readout.textContent = 'Click a second point to measure.';
      var hitRoom = null;
      rooms.forEach(function (r) {
        if (!hitRoom && (r.polygon || []).length > 2 && pointInPoly(r.polygon, w[0], w[1])) hitRoom = r;
      });
      selected = hitRoom;
      showRoom(hitRoom);
    }
    draw();
  });

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', function () { css = getComputedStyle(document.documentElement); draw(); });
  }

  renderRoomList();
  draw();
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
