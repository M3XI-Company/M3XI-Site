/**
 * The embed snippet generator.
 *
 * The output of this function is pasted, unread, into somebody else's website
 * by somebody who is not a developer. So the two things under test are that it
 * produces a working embed, and that nothing a user typed can escape an
 * attribute and start executing on the agency's page.
 */

import { describe, expect, it } from 'vitest';
import {
  EmbedError, bareIframeSnippet, embedSnippet, embedUrl, escapeAttribute, isValidSlug,
  portalLink, safeAccent, safeHttpUrl, shareUrl, slugify,
} from '../logic/embed.js';

const BASE = 'https://m3xi.com/spatial/apps/view/';

describe('share link', () => {
  it('points at the viewer with the published link name', () => {
    expect(shareUrl(BASE, 'two-bed-flat-demo'))
      .toBe('https://m3xi.com/spatial/apps/view/?slug=two-bed-flat-demo');
  });

  it('refuses a link name the server would refuse', () => {
    expect(() => shareUrl(BASE, 'Two Bed Flat')).toThrow(EmbedError);
    expect(() => shareUrl(BASE, 'a')).toThrow(EmbedError);
    expect(() => shareUrl(BASE, '-leading-hyphen')).toThrow(EmbedError);
    expect(() => shareUrl(BASE, 'trailing-')).toThrow(EmbedError);
  });

  it('refuses a viewer address that is not http(s)', () => {
    expect(() => shareUrl('javascript:alert(1)', 'ok-slug')).toThrow(EmbedError);
    expect(() => shareUrl('', 'ok-slug')).toThrow(EmbedError);
  });

  it('is the same URL a portal listing gets', () => {
    expect(portalLink({ viewerBaseUrl: BASE, slug: 'ok-slug' })).toBe(shareUrl(BASE, 'ok-slug'));
  });
});

describe('embed URL', () => {
  it('sets the parameters the viewer’s optionsFromUrl actually reads', () => {
    const url = new URL(embedUrl({
      viewerBaseUrl: BASE,
      slug: 'ok-slug',
      theme: 'dark',
      startNodeId: 'n_kitchen_a',
      branding: {
        name: 'Ashworth & Co',
        logoUrl: 'https://ashworth.example/logo.svg',
        accent: '#2E5C8A',
        listingUrl: 'https://ashworth.example/listing/44',
      },
    }));
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('slug')).toBe('ok-slug');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(url.searchParams.get('brand')).toBe('Ashworth & Co');
    expect(url.searchParams.get('accent')).toBe('#2e5c8a');
    expect(url.searchParams.get('at')).toBe('n_kitchen_a');
    expect(url.searchParams.get('listing')).toBe('https://ashworth.example/listing/44');
  });

  it('omits a system theme rather than sending theme=system', () => {
    const url = new URL(embedUrl({ viewerBaseUrl: BASE, slug: 'ok-slug', theme: 'system' }));
    expect(url.searchParams.has('theme')).toBe(false);
  });

  it('drops a logo URL that is not http(s)', () => {
    const url = new URL(embedUrl({
      viewerBaseUrl: BASE, slug: 'ok-slug',
      branding: { logoUrl: 'javascript:alert(document.cookie)' },
    }));
    expect(url.searchParams.has('logo')).toBe(false);
  });

  it('drops an accent that is not a hex colour', () => {
    const url = new URL(embedUrl({
      viewerBaseUrl: BASE, slug: 'ok-slug',
      branding: { accent: 'red; background:url(//evil)' },
    }));
    expect(url.searchParams.has('accent')).toBe(false);
  });

  it('keeps a base URL that already carries a path and a query', () => {
    const url = new URL(embedUrl({ viewerBaseUrl: 'https://tours.agency.example/w/?v=2', slug: 'ok-slug' }));
    expect(url.pathname).toBe('/w/');
    expect(url.searchParams.get('v')).toBe('2');
    expect(url.searchParams.get('slug')).toBe('ok-slug');
  });
});

describe('snippet', () => {
  const snippet = embedSnippet({
    viewerBaseUrl: BASE,
    slug: 'two-bed-flat-demo',
    title: '2 bed flat, Ash Grove',
    branding: { name: 'Ashworth & Co' },
  });

  it('is one iframe in a ratio box that survives a phone', () => {
    expect(snippet).toContain('<iframe');
    expect(snippet).toContain('aspect-ratio:16/9');
    expect(snippet).toContain('min-height:320px');
    expect(snippet.match(/<iframe/g)).toHaveLength(1);
  });

  it('carries a title, lazy loading and fullscreen permission', () => {
    expect(snippet).toContain('title="2 bed flat, Ash Grove"');
    expect(snippet).toContain('loading="lazy"');
    expect(snippet).toContain('allow="fullscreen; xr-spatial-tracking"');
  });

  it('needs no script tag at all', () => {
    expect(snippet).not.toContain('<script');
  });

  it('escapes the ampersand an agency name puts in the URL', () => {
    expect(snippet).toContain('brand=Ashworth+%26+Co');
    expect(snippet).not.toMatch(/src="[^"]*&(?!amp;|#)/);
  });

  it('cannot be escaped by a hostile title', () => {
    const hostile = embedSnippet({
      viewerBaseUrl: BASE, slug: 'ok-slug',
      title: '"><script>alert(1)</script>',
    });
    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('cannot be escaped by a hostile brand name', () => {
    const hostile = embedSnippet({
      viewerBaseUrl: BASE, slug: 'ok-slug',
      branding: { name: '" onload="alert(1)' },
    });
    expect(hostile).not.toMatch(/\sonload=/);
  });

  it('offers a bare iframe for a CMS that strips wrappers', () => {
    const bare = bareIframeSnippet({ viewerBaseUrl: BASE, slug: 'ok-slug' });
    expect(bare.startsWith('<iframe')).toBe(true);
    expect(bare).toContain('max-width:100%');
  });

  it('falls back to a sane ratio when given nonsense', () => {
    const s = embedSnippet({ viewerBaseUrl: BASE, slug: 'ok-slug', aspect: { w: 0, h: -3 } });
    expect(s).toContain('aspect-ratio:16/9');
  });
});

describe('helpers', () => {
  it('escapes every character that can break out of an attribute', () => {
    expect(escapeAttribute(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('accepts only http and https', () => {
    expect(safeHttpUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(safeHttpUrl('http://a.example/x')).toBe('http://a.example/x');
    expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(safeHttpUrl('  ')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it('accepts three- and six-digit hex accents only', () => {
    expect(safeAccent('#abc')).toBe('#abc');
    expect(safeAccent('#AABBCC')).toBe('#aabbcc');
    expect(safeAccent('rgb(1,2,3)')).toBeNull();
    expect(safeAccent('#abcd')).toBeNull();
  });

  it('suggests a link name from a property label', () => {
    expect(slugify('Flat 2, Elm Court, SW19')).toBe('flat-2-elm-court-sw19');
    expect(slugify('14 Ash Grove')).toBe('14-ash-grove');
    expect(isValidSlug(slugify('Flat 2, Elm Court, SW19'))).toBe(true);
  });

  it('gives back nothing rather than an invalid suggestion', () => {
    expect(slugify('—')).toBe('');
    expect(slugify('a')).toBe('');
  });
});
