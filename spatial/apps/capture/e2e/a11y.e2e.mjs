/**
 * Accessibility audit of the BUILT capture app, in both themes, at phone size.
 *
 * There is no accessibility overlay in this product and there will not be one:
 * the research on the installed base is that 2.4% of disabled users find them
 * effective and they routinely fight the assistive technology the user has
 * already configured. The fix is the markup being right, which is what this
 * measures — the same audit the console runs, at a viewport that matches the
 * device this app is actually used on.
 *
 * WHAT IT CHECKS, PER SCREEN, PER THEME:
 *   - WCAG 2.2 AA contrast (1.4.3), from the ACTUAL rendered colours, walking
 *     up the tree for the effective background;
 *   - target size (2.5.8), with the inline exception for a link inside a
 *     sentence and measuring the label where a radio is wrapped in one;
 *   - every form control has a programmatic label (1.3.1, 4.1.2);
 *   - one h1 per screen and no skipped heading levels (1.3.1, 2.4.6);
 *   - a main landmark and a live region exist (1.3.1, 4.1.3);
 *   - no horizontal overflow at 390px, because a control that is off the side
 *     of a phone is a control that does not exist.
 *
 * WHAT IT CANNOT CHECK, AND WHY. The walking screen and the go/no-go screen
 * are past a camera permission and a five-minute recording, so no headless
 * browser reaches them: Chromium's fake device produces a synthetic pattern
 * that the analyser reads as a static wall, and the verdict computed from it
 * would be a verdict about nothing. Those two screens are audited by hand on a
 * real phone. This file covers everything before them, and that limitation is
 * stated here rather than left for somebody to assume the opposite.
 *
 * Run:
 *   BASE_URL=http://127.0.0.1:8812/index.html node e2e/a11y.e2e.mjs
 *
 * With no credentials it audits the unconfigured notice and the sign-in
 * screen. With CAPTURE_EMAIL and CAPTURE_PASSWORD set — and a build carrying a
 * real VITE_SUPABASE_URL — it signs in and audits the picker and the planning
 * screen as well.
 */

import { chromium } from 'playwright';

const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:8812/index.html';
const EXECUTABLE = process.env['CHROMIUM_PATH'];
const EMAIL = process.env['CAPTURE_EMAIL'] ?? null;
const PASSWORD = process.env['CAPTURE_PASSWORD'] ?? null;

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

  const contrast = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('p,span,td,th,label,a,button,li,dt,dd,h1,h2,h3,b,strong,option,summary')) {
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
      contrast.push({ text: text.slice(0, 40), color: cs.color, size, ratio: +r.toFixed(2), need });
    }
  }

  const unlabelled = [];
  for (const c of document.querySelectorAll('input,select,textarea')) {
    const id = c.getAttribute('id');
    const labelled = (id && document.querySelector('label[for="' + id + '"]'))
      || c.closest('label') || c.getAttribute('aria-label') || c.getAttribute('aria-labelledby');
    if (!labelled) unlabelled.push(c.outerHTML.slice(0, 90));
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
      smallTargets.push((c.textContent || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }

  const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i-1] > 1) skips++;

  return {
    contrast, unlabelled, smallTargets,
    h1Count: document.querySelectorAll('h1').length,
    headingSkips: skips,
    liveRegions: document.querySelectorAll('[aria-live]').length,
    main: document.querySelectorAll('main').length,
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
})()`;

function report(label, out) {
  const bad = out.contrast.length + out.unlabelled.length + out.smallTargets.length
    + out.headingSkips + (out.h1Count === 1 ? 0 : 1) + (out.liveRegions >= 1 ? 0 : 1)
    + (out.main === 1 ? 0 : 1) + (out.overflow > 0 ? 1 : 0);
  console.log(`${label}: ${bad === 0 ? 'CLEAN' : 'ISSUES'} `
    + `h1=${out.h1Count} skips=${out.headingSkips} live=${out.liveRegions} `
    + `main=${out.main} overflowPx=${out.overflow}`);
  if (out.contrast.length) console.log('   contrast:', JSON.stringify(out.contrast.slice(0, 5)));
  if (out.unlabelled.length) console.log('   unlabelled:', out.unlabelled.slice(0, 3));
  if (out.smallTargets.length) console.log('   small targets:', out.smallTargets.slice(0, 5));
  return bad;
}

const browser = await chromium.launch({
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let issues = 0;
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({
    colorScheme: scheme,
    // A phone, because that is the only device this app is used on.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  issues += report(`${scheme} first screen`, await page.evaluate(AUDIT));

  if (EMAIL && PASSWORD && (await page.locator('input[type="email"]').count()) > 0) {
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);
    issues += report(`${scheme} property picker`, await page.evaluate(AUDIT));

    const walk = page.locator('button', { hasText: 'Walk this property' }).first();
    if (await walk.count()) {
      await walk.click();
      await page.waitForTimeout(800);
      issues += report(`${scheme} planning`, await page.evaluate(AUDIT));
    } else {
      console.log(`${scheme} planning: SKIPPED — this account has no walkable property.`);
    }
  } else {
    console.log(`${scheme} picker/planning: SKIPPED — set CAPTURE_EMAIL and CAPTURE_PASSWORD.`);
  }

  await ctx.close();
}
await browser.close();

console.log(`\n${issues === 0 ? 'No issues found' : `${issues} issues`}.`);
console.log('The walking screen and the go/no-go screen are NOT covered here: they need a real '
  + 'camera and a real walk. Audit those two by hand on a phone.');
process.exit(issues === 0 ? 0 : 1);
