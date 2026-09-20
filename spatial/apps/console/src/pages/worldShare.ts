/**
 * Share and embed.
 *
 * One link for a portal, one paste for the agency's own site, and a live
 * preview of exactly what a visitor will see with the branding applied. The
 * preview is the same iframe the snippet produces, so what is previewed is
 * what is pasted — not an approximation of it.
 */

import {
  button, copyBlock, el, embedSnippet, embedUrl, field, isValidSlug, note, portalLink, safeAccent,
  safeHttpUrl, shareUrl, slugify, toast, type Branding, type WorldDetail,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { section } from '../shell.js';

export function renderShare(ctx: PageContext, detail: WorldDetail, propertyLabel: string): HTMLElement {
  const root = el('div', {});

  if (detail.world.status !== 'published') {
    root.appendChild(note('warn', 'This version is not live',
      'A share link only exists once a world is published. Publish it from the Review tab first.'));
    return root;
  }

  const slug = detail.world.slug;
  if (!slug || !isValidSlug(slug)) {
    root.appendChild(note('warn', 'This version has no link name',
      'It was published without one, so it has no public address. Re-publish it from the Review tab with a link name.'));
    return root;
  }

  let branding: Branding = {};
  let theme: 'light' | 'dark' | 'system' = 'system';

  const output = el('div', {});
  const preview = el('div', {});

  const nameField = field({
    label: 'Agency name',
    hint: 'Shown in the corner of the embedded viewer. Plain text.',
    placeholder: 'Ashworth & Co',
    onInput: (value) => { branding = { ...branding, name: value }; redraw(); },
  });
  const logoField = field({
    label: 'Logo URL',
    hint: 'An https address for an image, rendered 24 pixels tall. Anything else is ignored.',
    placeholder: 'https://your-agency.co.uk/logo.svg',
    onInput: (value) => { branding = { ...branding, logoUrl: value }; redraw(); },
  });
  const accentField = field({
    label: 'Accent colour',
    hint: 'A hex colour such as #2e5c8a. Contrast is checked by the viewer at runtime.',
    placeholder: '#2e5c8a',
    onInput: (value) => { branding = { ...branding, accent: value }; redraw(); },
  });
  const listingField = field({
    label: 'Listing URL',
    hint: 'Where the viewer’s “view listing” link goes on your own site.',
    placeholder: 'https://your-agency.co.uk/property/1234',
    onInput: (value) => { branding = { ...branding, listingUrl: value }; redraw(); },
  });

  const themeSelect = el('select', {
    class: 'c-select', 'aria-label': 'Embedded theme', style: 'max-width:200px',
    onchange: (e: Event) => { theme = (e.target as HTMLSelectElement).value as typeof theme; redraw(); },
  },
  el('option', { value: 'system' }, 'Follow the visitor’s system'),
  el('option', { value: 'light' }, 'Always light'),
  el('option', { value: 'dark' }, 'Always dark'),
  );

  function redraw(): void {
    const options = {
      viewerBaseUrl: ctx.config.viewerBaseUrl,
      slug: slug!,
      theme,
      branding,
      title: `${propertyLabel} — walkthrough`,
    };

    const warnings: string[] = [];
    if (branding.logoUrl && !safeHttpUrl(branding.logoUrl)) {
      warnings.push('That logo address is not an http or https URL, so it has been left out of the snippet.');
    }
    if (branding.accent && !safeAccent(branding.accent)) {
      warnings.push('That accent is not a hex colour such as #2e5c8a, so it has been left out of the snippet.');
    }
    if (branding.listingUrl && !safeHttpUrl(branding.listingUrl)) {
      warnings.push('That listing address is not an http or https URL, so it has been left out of the snippet.');
    }

    const snippet = embedSnippet(options);
    output.replaceChildren(
      ...warnings.map((w) => note('warn', null, w)),
      el('h3', { style: 'font-size:13px;margin:12px 0 4px' }, 'Paste this into your page'),
      copyBlock(snippet, 'Embed snippet'),
      el('h3', { style: 'font-size:13px;margin:16px 0 4px' }, 'Or just the address'),
      copyBlock(embedUrl(options), 'Embed address'),
    );

    const frame = el('iframe', {
      src: embedUrl(options),
      title: `Preview of ${propertyLabel}`,
      loading: 'lazy',
      allow: 'fullscreen; xr-spatial-tracking',
      style: 'position:absolute;inset:0;width:100%;height:100%;border:0',
    });
    preview.replaceChildren(el('div', {
      style: 'position:relative;width:100%;aspect-ratio:16/9;min-height:320px;border:1px solid var(--line);border-radius:3px;overflow:hidden',
    }, frame));
  }

  redraw();

  const publicLink = shareUrl(ctx.config.viewerBaseUrl, slug);

  root.append(
    section('The public link',
      'One address. Put it in a listing, an email or a portal’s virtual-tour field.',
      copyBlock(publicLink, 'Public link'),
      el('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' },
        button({
          label: 'Open it',
          onClick: () => window.open(publicLink, '_blank', 'noopener'),
        }),
        button({
          label: 'Copy for a portal',
          onClick: () => {
            void navigator.clipboard?.writeText(portalLink({ viewerBaseUrl: ctx.config.viewerBaseUrl, slug }))
              .then(() => toast('Portal link copied.', 'ok'))
              .catch(() => toast('Could not reach the clipboard.', 'bad'));
          },
        }),
      ),
      el('p', { class: 'c-hint', style: 'margin-top:8px' },
        'Rightmove, Zoopla and OnTheMarket accept a virtual-tour URL rather than HTML, so the plain link is what those fields want.'),
    ),

    section('White-label embed',
      'Your branding, no M3XI chrome, one paste. Everything below is optional.',
      el('div', { style: 'display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))' },
        nameField.root, logoField.root, accentField.root, listingField.root,
        el('div', { class: 'c-field' }, el('label', {}, 'Theme'), themeSelect),
      ),
      output,
    ),

    section('Live preview',
      'This is the snippet above, running. What you see here is what the agency’s visitors will see.',
      preview),

    section('What the embed does not do',
      undefined,
      note('info', null,
        'It loads nothing from a third party: no fonts, no analytics, no tag manager. It does not set a cookie on your visitors. It is one iframe, and the only thing it talks to is this world.'),
    ),
  );

  return root;
}

/** Used by the world header to suggest a link name for a world without one. */
export function suggestSlug(label: string): string {
  return slugify(label);
}
