import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { buildCertificate, referenceFrom } from '../model/certificate.js';
import { buildChecklist } from '../model/checklist.js';
import { buildPrivacyAudit } from '../model/privacy.js';
import { renderDocument, renderStandaloneHtml } from '../ui/render.js';
import { COMPLIANCE_CSS } from '../ui/styles.js';
import { escapeAttr, h, hx, toHtml, toText } from '../render/vnode.js';
import { PROPERTY, WORLD_FACTS, redaction } from './fixtures.js';

const ISSUED = '2026-03-04T09:00:00.000Z';
const world = World.fromDocument(FLAT);
const reference = referenceFrom(FLAT, PROPERTY, WORLD_FACTS);
const certificate = buildCertificate({
  world, reference, measurementsAvailable: false, issuedAt: ISSUED,
});

describe('the element tree', () => {
  it('escapes text, so a detector name off a row cannot become markup', () => {
    const html = toHtml(h('td', {}, '<img src=x onerror="alert(1)">'));
    expect(html).toBe('<td>&lt;img src=x onerror="alert(1)"&gt;</td>');
  });

  it('escapes attributes, including quotes', () => {
    expect(escapeAttr('a "b" & <c>')).toBe('a &quot;b&quot; &amp; &lt;c&gt;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(toHtml(h('p', {}, '&lt;'))).toBe('<p>&amp;lt;</p>');
  });

  it('writes a void element without a closing tag', () => {
    expect(toHtml(h('input', { type: 'text', value: '' })))
      .toBe('<input type="text" value="">');
  });

  it('renders a true attribute bare and drops a false one', () => {
    expect(toHtml(h('button', { disabled: true }))).toBe('<button disabled></button>');
    // `disabled="false"` disables a control, which is the bug this prevents.
    expect(toHtml(h('button', { disabled: false }))).toBe('<button></button>');
    expect(toHtml(h('button', { disabled: null }))).toBe('<button></button>');
  });

  it('drops absent children so a conditional block is safe', () => {
    expect(toHtml(h('p', {}, null, false, undefined, 'kept'))).toBe('<p>kept</p>');
  });

  it('ignores listeners when serialising, and keeps them for the DOM', () => {
    const node = hx('button', {}, { click: () => undefined }, 'Approve');
    expect(toHtml(node)).toBe('<button>Approve</button>');
    expect(node.on?.['click']).toBeTypeOf('function');
  });

  it('reads block elements as separate lines, so two cells never fuse', () => {
    const table = h('tr', {}, h('td', {}, '4.50'), h('td', {}, 'm'));
    expect(toText(table)).not.toContain('4.50m');
  });
});

/**
 * The DOM path, against the smallest possible stand-in for a document.
 *
 * This workspace runs its tests in Node with no jsdom and may take no new
 * dependency, so the alternative to this was shipping `toDom` untested --
 * and `toDom` is the only path the console ever takes. The fake records what
 * was asked of it and nothing more: it is not a DOM implementation and it is
 * not pretending to be one, which is why the assertions below are about the
 * CALLS `toDom` makes rather than about a rendered tree.
 */
interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
  children: (FakeElement | { text: string })[];
  listeners: Record<string, unknown>;
}

function fakeDocument(): { doc: Document; root: () => FakeElement | null } {
  let last: FakeElement | null = null;
  const doc = {
    createElement(tag: string): FakeElement {
      const node: FakeElement = { tag, attrs: {}, children: [], listeners: {} };
      const api = {
        ...node,
        setAttribute(key: string, value: string) { node.attrs[key] = value; },
        appendChild(child: FakeElement | { text: string }) { node.children.push(child); },
        addEventListener(event: string, fn: unknown) { node.listeners[event] = fn; },
      };
      Object.assign(node, api);
      last = node;
      return node;
    },
    createTextNode(text: string) { return { text }; },
  } as unknown as Document;
  return { doc, root: () => last };
}

describe('materialising into a DOM', () => {
  it('sets attributes, attaches listeners and never touches innerHTML', async () => {
    const { toDom } = await import('../render/vnode.js');
    const { doc } = fakeDocument();
    let clicked = 0;
    const node = toDom(
      hx('button', { class: 'cp-btn', disabled: true, hidden: false },
        { click: () => { clicked += 1; } }, 'Approve'),
      doc,
    ) as unknown as FakeElement;

    expect(node.tag).toBe('button');
    expect(node.attrs['class']).toBe('cp-btn');
    // A bare `true` becomes a present attribute; a `false` is absent entirely.
    expect(node.attrs['disabled']).toBe('');
    expect('hidden' in node.attrs).toBe(false);
    expect(node.children).toEqual([{ text: 'Approve' }]);

    (node.listeners['click'] as () => void)();
    expect(clicked).toBe(1);
  });

  it('calls a ref with the element it created', async () => {
    const { href, toDom } = await import('../render/vnode.js');
    const { doc } = fakeDocument();
    let seen: unknown = null;
    toDom(href('div', { id: 'x' }, (element) => { seen = element; }), doc);
    expect((seen as FakeElement).attrs['id']).toBe('x');
  });
});

describe('table semantics', () => {
  // The certificate is a schedule of blocks, not a table, because its entries
  // carry prose. The tables left in this package are the privacy report's,
  // where every cell is short -- so that is what the table rules are tested
  // against.
  const audit = buildPrivacyAudit({
    reference,
    issuedAt: ISSUED,
    available: true,
    detections: [redaction()],
    cameraCount: FLAT.cameras.length,
    canReview: true,
  });
  const html = toHtml(renderDocument(audit.document));

  it('gives every table a caption and scoped headers', () => {
    const tables = html.split('<table').length - 1;
    expect(tables).toBeGreaterThan(0);
    expect(html.split('<caption>').length - 1).toBe(tables);
    expect(html).toContain('<th scope="col">');
    expect(html).toContain('<th scope="row">');
  });
});

describe('a certified figure', () => {
  const html = toHtml(renderDocument(certificate.document));

  it('keeps the value, the tolerance and the standard together', () => {
    // Split across cells or across a page, a value becomes a bare number. The
    // three parts sit inside one element, so nothing can separate them.
    const cell = html.match(/<dd><span><span class="cp-figure-value">[^<]+<\/span> <span class="cp-figure-tol">[^<]+<\/span> · <span class="cp-figure-tol">[^<]+<\/span>/);
    expect(cell).not.toBeNull();
  });

  it('prints the confidence and the provenance beside it', () => {
    const area = certificate.figures.find((f) => f.id === 'room:r_hall:area')!;
    expect(area.confidence).toBeGreaterThan(0);
    expect(html).toContain(`Confidence ${area.confidence.toFixed(2)}, ${area.provenanceLabel}.`);
  });

  it('prints what produced it', () => {
    expect(html).toContain('Computed from the room outline');
  });

  it('never breaks across a page', () => {
    expect(html).toContain('class="cp-figure"');
    expect(COMPLIANCE_CSS).toMatch(/\.cp-note, \.cp-item, \.cp-facts, \.cp-figure \{ break-inside: avoid-page/);
  });

  it('expands every figure for a screen reader, with no symbols', () => {
    expect(html).toContain('class="cp-sr"');
    expect(html).toContain('square metres');
    expect(html).toContain('plus or minus');
  });
});

describe('nothing carries meaning by colour', () => {
  it('states every status as a word', () => {
    const text = toText(renderDocument(certificate.document));
    expect(text).toContain('MEASURED');
    expect(text).toContain('INDICATIVE');
  });

  it('says why a figure is indicative in the same cell as the word', () => {
    const indicative = certificate.figures.find((f) => f.presentation === 'indicative')!;
    const html = toHtml(renderDocument(certificate.document));
    // The first occurrence of the word is in the standing statement, which
    // explains what it means. The one that matters is the status span itself.
    const at = html.indexOf('class="cp-status-word cp-status--indicative"');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at, at + 600)).toContain(indicative.reason!.slice(0, 30));
  });

  it('defines no colour that is not also a word or a rule', () => {
    // The palette is ink on paper plus one muted accent, inherited from the
    // console where there is one. Anything that looked like a severity ramp
    // would be meaning carried by hue.
    expect(COMPLIANCE_CSS).not.toMatch(/linear-gradient|radial-gradient/);
    expect(COMPLIANCE_CSS).not.toMatch(/#(ff0000|f00|00ff00|0f0)\b/i);
  });
});

describe('the print stylesheet is real', () => {
  it('sets a page size and margins', () => {
    expect(COMPLIANCE_CSS).toContain('@media print');
    expect(COMPLIANCE_CSS).toContain('@page { size: A4');
  });

  it('repeats a table header across pages and never breaks a row', () => {
    expect(COMPLIANCE_CSS).toContain('.cp-table thead { display: table-header-group; }');
    expect(COMPLIANCE_CSS).toContain('.cp-table tr { break-inside: avoid-page;');
  });

  it('never leaves a heading at the foot of a page', () => {
    expect(COMPLIANCE_CSS).toMatch(/\.cp-doc h2 \{[^}]*break-after: avoid-page/);
  });

  it('breaks between sections, where a document is meant to break', () => {
    expect(COMPLIANCE_CSS).toContain('.cp-section--break { break-before: page;');
  });

  it('hides the controls, so what prints is the document', () => {
    expect(COMPLIANCE_CSS).toContain('.cp-toolbar, .cp-tabs, .cp-actions, .cp-addform, .cp-noprint { display: none !important; }');
  });

  it('prints an unanswered field as a line to write on', () => {
    expect(COMPLIANCE_CSS).toMatch(/\.cp-input, \.cp-select, \.cp-textarea \{\s*border: 0; border-bottom/);
  });

  it('forces ink on paper, so nothing depends on a colour printer', () => {
    expect(COMPLIANCE_CSS).toContain('background: #fff; color: #000;');
  });
});

describe('the standalone file', () => {
  const file = renderStandaloneHtml(certificate.document);

  it('is a complete document with the stylesheet inlined and no scripts', () => {
    expect(file.startsWith('<!doctype html>')).toBe(true);
    expect(file).toContain('<html lang="en-GB">');
    expect(file).toContain('@media print');
    expect(file).not.toContain('<script');
    expect(file).not.toContain('http://');
    expect(file).not.toContain('https://');
  });

  it('carries the identifiers a reader needs three years from now', () => {
    expect(file).toContain(FLAT.id);
    expect(file).toContain(String(FLAT.version));
    expect(file).toContain(PROPERTY.label);
  });

  it('keeps the answers an agent typed into the checklist', () => {
    const checklist = buildChecklist({
      world, reference, figures: certificate.figures, issuedAt: ISSUED,
    });
    const saved = renderStandaloneHtml(checklist.document, {
      checklistValues: new Map([['a-price', '385,000']]),
    });
    expect(saved).toContain('value="385,000"');
    // And still says UNANSWERED, because typing into a page does not answer
    // the item in any record this system keeps.
    expect(saved).toContain('UNANSWERED');
  });

  it('marks its own controls as unusable when opened away from the console', () => {
    const audit = buildPrivacyAudit({
      reference,
      issuedAt: ISSUED,
      available: true,
      detections: [redaction()],
      cameraCount: FLAT.cameras.length,
      canReview: true,
    });
    const saved = renderStandaloneHtml(audit.document);
    expect(saved).toContain('This is a saved copy of the report');
    expect(saved).toContain('aria-disabled="true"');
  });
});
