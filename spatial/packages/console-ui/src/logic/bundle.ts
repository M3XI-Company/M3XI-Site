/**
 * What the permanence bundle actually contains, stated in the console.
 *
 * The most common complaint about incumbent property tours is that the tour
 * dies with the subscription: the agency paid for a scan, the link stops
 * working, and the asset they thought they owned turns out to have been a
 * rental. This is the answer to that, so the console says what is in the zip
 * before anyone downloads it, in the same words the exporter uses.
 *
 * The file list mirrors `buildBundleEntries` in
 * supabase/functions/wv-export/bundle.ts. If that changes, this is wrong.
 */

export interface BundleFile {
  readonly path: string;
  readonly what: string;
  readonly why: string;
}

export const BUNDLE_CONTENTS: readonly BundleFile[] = [
  {
    path: 'viewer.html',
    what: 'The walkthrough, as a single page.',
    why: 'Opens by double-clicking it. No server, no internet, no account. The world is embedded in the page, because several browsers refuse to fetch a local JSON file from file://.',
  },
  {
    path: 'world.json',
    what: 'The complete world document.',
    why: 'Every room, surface, opening, object, camera pose and measurement, with the standard and tolerance each dimension was measured to, and where each fact came from.',
  },
  {
    path: 'floorplan.svg',
    what: 'A true-to-scale plan. One metre is 100 units.',
    why: 'Opens in any vector editor and can be measured directly. Rooms are shaded by provenance, so an inferred room does not look identical to one a camera saw.',
  },
  {
    path: 'assets/',
    what: 'The 3D data: splats, proxy mesh, point cloud, floorplan and cover image.',
    why: 'Open formats only. Nothing in here needs our code to read. Anything too large for the packager to carry is not in this folder, and the note below names it rather than leaving a gap.',
  },
  {
    path: 'assets/DOWNLOAD.md',
    what: 'Only when something did not fit: the files that are missing from assets/, and how to fetch them.',
    why: 'Each one is named with its size, its SHA-256 and a direct link to storage that lasts 24 hours, and the note says what to do once that has lapsed — export again. An assets folder quietly missing the splat somebody paid for is exactly the failure this bundle exists to rule out.',
  },
  {
    path: 'manifest.json',
    what: 'What is in the bundle, when it was made, and what was left out.',
    why: 'Including anything the exporter could not fit, named and explained, with the link issued for it and the moment that link stops working. A bundle that quietly lacks its splat is worse than one that says so.',
  },
  {
    path: 'CHECKSUMS.sha256',
    what: 'A SHA-256 for every file, in the format `sha256sum -c` expects.',
    why: 'Verifiable years later with a standard tool, so the numbers can be proved unedited without us.',
  },
  {
    path: 'README.txt',
    what: 'Plain-text instructions and the licence.',
    why: 'The customer owns the bundle outright and may host, copy, modify and redistribute it.',
  },
];

export const PERMANENCE_PROMISE: readonly string[] = [
  'It works with no internet connection. Open viewer.html from a memory stick on a train.',
  'It makes no network calls. No CDN, no fonts, no analytics, nothing phoning home.',
  'It does not check a licence, an account or a subscription, because there is nothing in it that could.',
  'It keeps working if this company stops existing. That is the whole point of the format.',
];

/**
 * The honest limit: an edge function cannot hold a five-bedroom splat in
 * memory. Mirrors `INLINE_ASSET_BUDGET_BYTES` in
 * supabase/functions/wv-export/handler.ts, which is the number that actually
 * decides what goes in the zip. If that changes, this is wrong.
 *
 * Nothing waits on this budget any more. The bundle is built and returned on
 * the spot whatever the size, and an asset that does not fit travels as a
 * signed link in manifest.json, README.txt and assets/DOWNLOAD.md instead of
 * as bytes in the archive.
 *
 * This used to say an oversize property was queued to a worker, and the
 * console said so to the customer. It was never true: the queued job named a
 * stage `wv-jobs` does not hand out, so the row was unclaimable, nothing
 * packaged anything, and somebody was told their bundle was on its way to
 * them. A link that expires in a day is a smaller promise than that one, and
 * unlike it, it is kept.
 */
export const INLINE_EXPORT_BUDGET_BYTES = 180 * 1024 * 1024;

/**
 * How long a link to an omitted asset lasts, mirroring
 * `OMITTED_ASSET_URL_TTL_SECONDS` in wv-export/handler.ts. The same 24 hours
 * as the link to the bundle itself, and short on purpose: a scan of a home is
 * personal data, and a URL that never expired would be a permanent way in for
 * anyone who ever saw it.
 *
 * Stated as a number rather than written into a sentence because the console
 * has to say it in more than one place and two different figures on one page
 * would be worse than none.
 */
export const OMITTED_ASSET_LINK_TTL_HOURS = 24;

/**
 * True when this world is certain to have at least one asset behind a link
 * rather than inside the zip. For warning an operator before they click, so
 * the DOWNLOAD.md in the bundle is expected rather than alarming.
 *
 * One-directional, and nothing may invert it into "everything will fit".
 * Above the budget at least one asset must miss the zip, because the inlined
 * total can never exceed the budget. Below it, an asset can still end up
 * linked: `assetBytes` sums every `wv_asset` row while the exporter packages
 * only the bundle roles, the sizes are the ones recorded on the rows rather
 * than measured now, and a row with no stored file or an object storage will
 * not hand over is omitted at any size. What actually happened is in the
 * `omittedAssets` the export returns, which is the only thing that knows.
 */
export function willLinkAssets(assetBytes: number): boolean {
  return assetBytes > INLINE_EXPORT_BUDGET_BYTES;
}
