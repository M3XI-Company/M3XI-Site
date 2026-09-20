/**
 * Accessibility audit of the BUILT console, in both themes.
 *
 * There is no accessibility overlay widget in this product and there will not
 * be one: the research on the installed base is that 2.4% of disabled users
 * find them effective, and they routinely fight the assistive technology the
 * user has already configured. The fix is the markup being right, which is
 * what this measures.
 *
 * It checks, per route, per theme:
 *   - WCAG 2.2 AA contrast (1.4.3), computed from the ACTUAL rendered colours
 *     rather than from the token file, walking up for the effective background;
 *   - target size (2.5.8), honouring the inline exception for a link inside a
 *     sentence and measuring the label when a checkbox is wrapped in one,
 *     because the label is the target;
 *   - that every form control has a programmatic label (1.3.1, 4.1.2);
 *   - one h1 per page and no skipped heading levels (1.3.1, 2.4.6);
 *   - landmarks and live regions exist (1.3.1, 4.1.3);
 *   - every table has a caption and every header cell a scope (1.3.1).
 *
 * Run:
 *   BASE_URL=http://127.0.0.1:8811/index.html node e2e/a11y.e2e.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:8811/index.html';
const EXECUTABLE = process.env['CHROMIUM_PATH'];

const ROUTES = ['#/portfolio', '#/usage', '#/plans', '#/analytics', '#/leads', '#/exports', '#/permanence'];

const AUDIT = `(() => {
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (rgb) => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x)); return p.length >= 3 ? p : null; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      const alpha = c && c.length === 4 ? c[3] : 1;
      if (c && alpha > 0.9) return c;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
  };

  const problems = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('p,span,td,th,label,a,button,li,dt,dd,h1,h2,h3,b,option,caption')) {
    const text = (el.textContent || '').trim();
    if (!text || el.children.length > 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    const key = cs.color + '|' + bg.join(',') + '|' + Math.round(size);
    if (r < need && !seen.has(key)) { seen.add(key);
      problems.push({ text: text.slice(0, 40), color: cs.color, bg: 'rgb(' + bg.slice(0,3).join(',') + ')', size, ratio: +r.toFixed(2), need });
    }
  }

  const noLabel = [];
  for (const c of document.querySelectorAll('input,select,textarea')) {
    const id = c.getAttribute('id');
    const labelled = (id && document.querySelector('label[for="' + id + '"]'))
      || c.closest('label') || c.getAttribute('aria-label') || c.getAttribute('aria-labelledby');
    if (!labelled) noLabel.push(c.outerHTML.slice(0, 90));
  }

  const smallTargets = [];
  for (const c of document.querySelectorAll('button,a[href],input,select')) {
    const target = (c.tagName === 'INPUT' && c.closest('label')) ? c.closest('label') : c;
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const inline = c.tagName === 'A' && c.parentElement
      && ['P', 'LI', 'SPAN'].includes(c.parentElement.tagName)
      && c.parentElement.textContent.trim().length > c.textContent.trim().length + 10;
    if (!inline && (r.width < 24 || r.height < 24)) {
      smallTargets.push(c.textContent.trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }

  const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i-1] > 1) skips++;

  return {
    contrast: problems,
    unlabelled: noLabel,
    smallTargets,
    h1Count: document.querySelectorAll('h1').length,
    headingSkips: skips,
    liveRegions: document.querySelectorAll('[aria-live]').length,
    main: document.querySelectorAll('main').length,
    nav: document.querySelectorAll('nav').length,
    tablesWithoutCaption: [...document.querySelectorAll('table')].filter((t) => !t.querySelector('caption')).length,
    thWithoutScope: [...document.querySelectorAll('thead th')].filter((t) => !t.getAttribute('scope')).length,
  };
})()`;

const browser = await chromium.launch({
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let issues = 0;
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'operator@ashworth.example');
  await page.fill('input[type="password"]', 'x');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.c-app');

  for (const route of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    const out = await page.evaluate(AUDIT);
    const bad = out.contrast.length + out.unlabelled.length + out.smallTargets.length
      + out.tablesWithoutCaption + out.thWithoutScope + out.headingSkips
      + (out.h1Count === 1 ? 0 : 1) + (out.liveRegions >= 2 ? 0 : 1)
      + (out.main === 1 ? 0 : 1) + (out.nav >= 1 ? 0 : 1);
    if (bad > 0) issues += bad;
    console.log(`${scheme} ${route}: ${bad === 0 ? 'CLEAN' : 'ISSUES'} `
      + `h1=${out.h1Count} skips=${out.headingSkips} live=${out.liveRegions} `
      + `main=${out.main} nav=${out.nav} noCaption=${out.tablesWithoutCaption} noScope=${out.thWithoutScope}`);
    if (out.contrast.length) console.log('   contrast:', JSON.stringify(out.contrast.slice(0, 5)));
    if (out.unlabelled.length) console.log('   unlabelled:', out.unlabelled.slice(0, 3));
    if (out.smallTargets.length) console.log('   small targets:', out.smallTargets.slice(0, 5));
  }
  await ctx.close();
}
await browser.close();

console.log(`\n${issues === 0 ? 'No issues found' : `${issues} issues`} across ${ROUTES.length * 2} route/theme combinations.`);
process.exit(issues === 0 ? 0 : 1);
