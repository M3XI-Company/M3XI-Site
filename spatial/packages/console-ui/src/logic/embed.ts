/**
 * Share links and the one-step embed.
 *
 * The agency's side of this has to be one paste. They are not going to install
 * a package, and the person doing it is usually the one who also writes the
 * property descriptions. So: an iframe, an explicit title, a fixed aspect
 * ratio that does not collapse on a phone, and nothing that needs a script tag.
 *
 * Every value that reaches an attribute is escaped here rather than at the
 * call site. A snippet generator that interpolates an agency's name straight
 * into HTML is a stored-XSS generator on somebody else's website.
 *
 * The query parameters are exactly the ones `optionsFromUrl` in
 * `@m3xi/viewer` reads: embed, theme, brand, logo, accent, listing, at.
 */

/** The server's own slug rule, from `_wv_shared/http.ts`. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;
const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface Branding {
  /** Agency name, shown in embed mode. Plain text. */
  readonly name?: string | null;
  readonly logoUrl?: string | null;
  readonly accent?: string | null;
  readonly listingUrl?: string | null;
}

export interface EmbedOptions {
  /** Origin plus path of the deployed viewer page, e.g. https://m3xi.com/w/ */
  readonly viewerBaseUrl: string;
  readonly slug: string;
  readonly theme?: 'light' | 'dark' | 'system';
  readonly branding?: Branding;
  /** Nav node to start at, for "open at the kitchen". */
  readonly startNodeId?: string | null;
  readonly title?: string;
  /** Width/height of the embed box. 16/9 by default. */
  readonly aspect?: { readonly w: number; readonly h: number };
}

export class EmbedError extends Error {}

/** Escapes text for an HTML attribute in a double-quoted context. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only http(s) survives. A `javascript:` logo URL pasted into an agency's page
 * is the whole attack, and "they would not do that" is not a control.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function safeAccent(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOUR.test(trimmed) ? trimmed.toLowerCase() : null;
}

function base(viewerBaseUrl: string): URL {
  const url = safeHttpUrl(viewerBaseUrl);
  if (!url) throw new EmbedError('The viewer address must be an http or https URL.');
  return new URL(url);
}

/** The public link an agency puts in a listing or an email. */
export function shareUrl(viewerBaseUrl: string, slug: string): string {
  if (!SLUG.test(slug)) {
    throw new EmbedError('A share link needs a published link name (lower-case letters, numbers and hyphens).');
  }
  const url = base(viewerBaseUrl);
  url.searchParams.set('slug', slug);
  return url.toString();
}

/** The same world in white-label embed mode, with the agency's branding. */
export function embedUrl(options: EmbedOptions): string {
  if (!SLUG.test(options.slug)) {
    throw new EmbedError('An embed needs a published link name (lower-case letters, numbers and hyphens).');
  }
  const url = base(options.viewerBaseUrl);
  url.searchParams.set('slug', options.slug);
  url.searchParams.set('embed', '1');

  if (options.theme && options.theme !== 'system') url.searchParams.set('theme', options.theme);

  const b = options.branding ?? {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
  if (name) url.searchParams.set('brand', name);

  const logo = safeHttpUrl(b.logoUrl ?? null);
  if (logo) url.searchParams.set('logo', logo);

  const accent = safeAccent(b.accent ?? null);
  if (accent) url.searchParams.set('accent', accent);

  const listing = safeHttpUrl(b.listingUrl ?? null);
  if (listing) url.searchParams.set('listing', listing);

  if (options.startNodeId) url.searchParams.set('at', options.startNodeId.slice(0, 64));

  return url.toString();
}

/**
 * The paste.
 *
 * `loading="lazy"` so a listing page with six of these does not download six
 * worlds; `allow="fullscreen; xr-spatial-tracking"` because the viewer offers
 * both; `referrerpolicy` left at the default so the referrer still reaches
 * `wv-view` and the agency can see where their traffic came from.
 */
export function embedSnippet(options: EmbedOptions): string {
  const src = embedUrl(options);
  const aspect = options.aspect ?? { w: 16, h: 9 };
  const title = (options.title ?? 'Property walkthrough').slice(0, 120);

  const w = Number.isFinite(aspect.w) && aspect.w > 0 ? aspect.w : 16;
  const h = Number.isFinite(aspect.h) && aspect.h > 0 ? aspect.h : 9;

  return [
    `<div style="position:relative;width:100%;aspect-ratio:${w}/${h};min-height:320px">`,
    `  <iframe`,
    `    src="${escapeAttribute(src)}"`,
    `    title="${escapeAttribute(title)}"`,
    `    loading="lazy"`,
    `    allow="fullscreen; xr-spatial-tracking"`,
    `    style="position:absolute;inset:0;width:100%;height:100%;border:0"`,
    `  ></iframe>`,
    `</div>`,
  ].join('\n');
}

/** For a CMS that only accepts a bare iframe. Same URL, no wrapper. */
export function bareIframeSnippet(options: EmbedOptions): string {
  const src = embedUrl(options);
  const title = (options.title ?? 'Property walkthrough').slice(0, 120);
  return `<iframe src="${escapeAttribute(src)}" title="${escapeAttribute(title)}" width="960" height="540" loading="lazy" allow="fullscreen; xr-spatial-tracking" style="border:0;max-width:100%"></iframe>`;
}

/**
 * Rightmove, Zoopla and OnTheMarket accept a virtual-tour URL but not HTML,
 * so the plain link is a first-class output rather than a fallback.
 */
export function portalLink(options: EmbedOptions): string {
  return shareUrl(options.viewerBaseUrl, options.slug);
}

/** Suggest a link name from a property label, matching the server's rule. */
export function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 110);
  if (base.length < 3) return '';
  return SLUG.test(base) ? base : '';
}

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}
