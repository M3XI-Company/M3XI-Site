/**
 * End-to-end checks against the BUILT console, driven with Playwright.
 *
 * These are not unit tests — the unit tests live in
 * packages/console-ui/src/__tests__ and cover the decisions. This drives the
 * real page in a real browser and asserts on what an operator would see: that
 * a failed build shows its downstream stages as blocked, that publish is
 * disabled with a readable reason on a world that did not pass, that a viewer
 * cannot reach a control they are not allowed to use, and that a hostile
 * agency name cannot escape the embed snippet.
 *
 * Run:
 *   npx vite build                     # from apps/console
 *   npx http-server dist -p 8811       # or any static server
 *   BASE_URL=http://127.0.0.1:8811/index.html node e2e/console.e2e.mjs
 *
 * It runs against the fixture backend (no VITE_SUPABASE_URL configured), which
 * is what makes the failure states reachable on demand.
 */

import { chromium } from 'playwright';

const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:8811/index.html';
const EXECUTABLE = process.env['CHROMIUM_PATH'];

const results = [];
const consoleErrors = [];
const missing = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function watch(page, tag) {
  page.on('console', (m) => {
    // A 404 is recorded separately and asserted on below; it is not a script
    // error, and lumping the two together hides real faults.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      consoleErrors.push(`${tag}: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
}

async function signIn(page, email) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'anything');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.c-app', { timeout: 15000 });
}

const browser = await chromium.launch({
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page, 'operator');

  // ---- sign in ------------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('sign-in page renders a real form', await page.locator('form').count() === 1);
  check('sign-in warns this is a fixture build',
    (await page.locator('.c-note--warn').first().innerText()).includes('fixture'));

  await signIn(page, 'operator@ashworth.example');
  check('operator lands in the console shell', await page.locator('.c-app').count() === 1);
  check('role is shown in the sidebar',
    (await page.locator('.c-side-foot').innerText()).includes('operator'));

  // ---- portfolio ----------------------------------------------------------
  await page.waitForSelector('table.c-table tbody tr', { timeout: 15000 });
  const rowCount = await page.locator('table.c-table tbody tr').count();
  check('portfolio renders a page of 50 rows', rowCount === 50, `got ${rowCount}`);
  const caption = await page.locator('table.c-table caption').innerText();
  check('caption states the server-side total', /of \d+/.test(caption), caption);

  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(400);
  const caption2 = await page.locator('table.c-table caption').innerText();
  check('next page changes the visible range', caption2 !== caption, `${caption} -> ${caption2}`);
  check('URL carries the page so it can be linked', page.url().includes('page=2'), page.url());

  await page.fill('input[type="search"]', 'Ash Grove');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const searched = await page.locator('table.c-table caption').innerText();
  check('search narrows the result set and returns to page 1',
    searched.includes('Ash Grove') && !page.url().includes('page=2'), searched);

  await page.fill('input[type="search"]', '');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.selectOption('select[aria-label="Filter by status"]', 'failed');
  await page.waitForTimeout(500);
  const statuses = await page.locator('table.c-table tbody tr .c-pill').allInnerTexts();
  check('status filter returns only that status',
    statuses.length > 0 && statuses.every((s) => s.trim() === 'failed'), statuses.slice(0, 5).join(','));

  // ---- a failed build -----------------------------------------------------
  await page.locator('table.c-table tbody tr a').first().click();
  await page.waitForSelector('h1', { timeout: 10000 });
  check('property page shows a version history',
    (await page.locator('h2').allInnerTexts()).some((t) => t.includes('Version history')));

  await page.locator('a[href^="#/world/"]').first().click();
  await page.waitForSelector('.c-tabs [role="tab"]', { timeout: 10000 });
  check('world workspace has six tabs', await page.locator('[role="tab"]').count() === 6);

  await page.waitForSelector('.c-stage', { timeout: 10000 });
  const stageStates = await page.locator('.c-stage .c-pill').allInnerTexts();
  check('build shows all thirteen stages', stageStates.length === 13, `got ${stageStates.length}`);
  check('the failed stage is shown as failed', stageStates[3] === 'failed', stageStates.join(','));
  check('stages after the failure are BLOCKED, not waiting',
    stageStates.slice(4).every((s) => s === 'blocked'), stageStates.slice(4).join(','));
  const errText = await page.locator('.c-stage-error').first().innerText();
  check('the worker error is shown verbatim', errText.includes('CUDA out of memory'), errText.slice(0, 40));
  check('the failure panel names the preserved stages',
    (await page.locator('.c-note--bad').first().innerText()).includes('stages already succeeded'));

  await page.getByRole('button', { name: /Resume from this stage/ }).click();
  await page.waitForSelector('[role="dialog"]');
  const dialog = await page.locator('[role="dialog"]').innerText();
  check('resume explains it keeps completed stages', /already succeeded and are kept/.test(dialog));
  check('resume states the GPU time preserved', /GPU time is kept/.test(dialog));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes the dialog', await page.locator('[role="dialog"]').count() === 0);

  // ---- quality gate -------------------------------------------------------
  await page.getByRole('tab', { name: 'Quality gate' }).click();
  await page.waitForTimeout(500);
  const qualityText = await page.locator('.c-body').innerText();
  check('quality page states the verdict', /fail/i.test(qualityText));
  const checkRows = await page.locator('table.c-table tbody tr').count();
  check('every check is listed with value and threshold', checkRows >= 7, `${checkRows} rows`);
  check('thresholds are shown with their direction', /[≥≤]/.test(qualityText));
  check('a failed world is routed to recapture, not correction',
    /capture itself is not good enough/i.test(qualityText));

  // ---- review / publish gate ---------------------------------------------
  await page.getByRole('tab', { name: 'Review and publish' }).click();
  await page.waitForSelector('text=Publish', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const publishBtn = page.getByRole('button', { name: /^Publish$/ });
  check('publish exists on a failing world', await publishBtn.count() === 1);
  check('publish is DISABLED on a failing world', await publishBtn.first().isDisabled());
  check('the disabled publish explains why',
    ((await publishBtn.first().getAttribute('title')) ?? '').length > 10);

  // ---- keyboard -----------------------------------------------------------
  await page.goto(`${BASE}#/plans`, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1');
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => document.activeElement?.className ?? '');
  check('the first tab stop is the skip link', firstFocus.includes('c-skip'), firstFocus);
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? getComputedStyle(el).outlineWidth : '';
  });
  check('focus is visible on the skip link', outline !== '' && outline !== '0px', outline);

  // ---- plans --------------------------------------------------------------
  const plansText = await page.locator('.c-body').innerText();
  check('all three prices are printed as numbers',
    plansText.includes('£5') && plansText.includes('£200') && plansText.includes('£500'));
  check('no enquire-style wording anywhere on the plans page',
    !/enquire|contact sales|price on request|custom pricing/i.test(plansText));
  check('AI metering is explained on the plans page', /metered/i.test(plansText));
  check('the absence of an annual plan is stated', /no annual plan/i.test(plansText));

  // ---- usage --------------------------------------------------------------
  await page.goto(`${BASE}#/usage`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[role="meter"]', { timeout: 15000 });
  check('both caps are drawn as meters', await page.locator('[role="meter"]').count() === 2);
  check('the meter carries a human sentence for screen readers',
    ((await page.locator('[role="meter"]').first().getAttribute('aria-valuetext')) ?? '').length > 20);
  check('the exchange rate used for the cap is stated',
    (await page.locator('.c-body').innerText()).includes('0.79'));

  // ---- permanence ---------------------------------------------------------
  await page.goto(`${BASE}#/permanence`, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1');
  const permText = await page.locator('.c-body').innerText();
  check('permanence page promises the tour outlives the subscription',
    /does not die with your subscription|You keep them/i.test(permText));
  check('the bundle contents are listed',
    permText.includes('CHECKSUMS.sha256') && permText.includes('viewer.html'));
  check('it states there are no network calls', /no network calls|makes no network calls/i.test(permText));

  // ---- dark mode ----------------------------------------------------------
  const darkCtx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  const dark = await darkCtx.newPage();
  watch(dark, 'dark');
  await signIn(dark, 'operator@ashworth.example');
  await dark.waitForSelector('table.c-table tbody tr');
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark mode is a real dark background', bg === 'rgb(15, 17, 19)', bg);
  await darkCtx.close();

  // ---- viewer role --------------------------------------------------------
  const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const viewer = await viewerCtx.newPage();
  watch(viewer, 'viewer');
  await signIn(viewer, 'viewer@ashworth.example');
  await viewer.waitForSelector('table.c-table tbody tr');

  const navLabels = await viewer.locator('.c-nav a').allInnerTexts();
  check('a viewer does not see the Organisation section',
    !navLabels.includes('Organisation'), navLabels.join(','));
  check('a viewer still sees Portfolio, Leads and Analytics',
    ['Portfolio', 'Leads', 'Analytics'].every((l) => navLabels.includes(l)));

  const addBtn = viewer.getByRole('button', { name: 'Add a property' });
  check('a viewer cannot add a property', await addBtn.first().isDisabled());
  check('the disabled add button explains the role',
    ((await addBtn.first().getAttribute('title')) ?? '').toLowerCase().includes('viewer'));

  await viewer.goto(`${BASE}#/portfolio?status=published`, { waitUntil: 'networkidle' });
  await viewer.waitForSelector('table.c-table tbody tr a');
  await viewer.locator('table.c-table tbody tr a').first().click();
  await viewer.waitForSelector('a[href^="#/world/"]');
  await viewer.locator('a[href^="#/world/"]').first().click();
  await viewer.waitForSelector('[role="tab"]');
  await viewer.getByRole('tab', { name: 'Review and publish' }).click();
  await viewer.waitForTimeout(2500);
  const vPublish = viewer.getByRole('button', { name: /Re-publish|^Publish$/ });
  check('a viewer cannot publish a PASSING world', await vPublish.first().isDisabled());
  check('and is told it is a role restriction, not a quality one',
    /cannot publish/i.test((await vPublish.first().getAttribute('title')) ?? ''));
  check('the correction editor absence is explained rather than crashing',
    (await viewer.locator('.c-body').innerText()).includes('not installed'));

  // ---- share --------------------------------------------------------------
  const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const op = await opCtx.newPage();
  watch(op, 'share');
  await signIn(op, 'operator@ashworth.example');
  await op.goto(`${BASE}#/portfolio?status=published`, { waitUntil: 'networkidle' });
  await op.waitForSelector('table.c-table tbody tr a');
  await op.locator('table.c-table tbody tr a').first().click();
  await op.waitForSelector('a[href^="#/world/"]');
  await op.locator('a[href^="#/world/"]').first().click();
  await op.waitForSelector('[role="tab"]');
  await op.getByRole('tab', { name: 'Share' }).click();
  await op.waitForSelector('pre.c-code', { timeout: 10000 });
  const snippet = await op.locator('pre.c-code').nth(1).innerText();
  check('the embed snippet is a single iframe with no script tag',
    snippet.includes('<iframe') && !snippet.includes('<script'));
  check('the snippet carries a title and lazy loading',
    snippet.includes('title=') && snippet.includes('loading="lazy"'));
  await op.fill('input[placeholder="Ashworth & Co"]', '"><img src=x onerror=alert(1)>');
  await op.waitForTimeout(400);
  const hostile = await op.locator('pre.c-code').nth(1).innerText();
  check('a hostile agency name cannot escape the snippet attribute',
    !hostile.includes('onerror=') && !hostile.includes('<img'));

  // ---- analytics ----------------------------------------------------------
  await op.goto(`${BASE}#/analytics`, { waitUntil: 'networkidle' });
  await op.waitForSelector('table.c-table', { timeout: 20000 });
  const analyticsText = await op.locator('.c-body').innerText();
  // innerText reflects the rendered text, and the table headers are
  // text-transform: uppercase, so these have to be case-insensitive.
  check('analytics shows room-level dwell',
    /total time/i.test(analyticsText) && /share of time/i.test(analyticsText));
  check('analytics shows revisits and exits',
    /went back/i.test(analyticsText) && /left from here/i.test(analyticsText));
  check('the most revisited room is called out in words', /most revisited room/i.test(analyticsText));

  // Two 404s are expected when the console is served on its own: the favicon,
  // and the Share tab's live preview, which points at the deployed viewer page.
  const expected404 = missing.every((u) => /favicon\.ico$/.test(u) || u.includes('/spatial/apps/view/'));
  check('the only 404s are the favicon and the viewer page this harness does not serve',
    expected404, missing.join(' | '));
  check('no uncaught JavaScript errors during the whole run',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await ctx.close(); await viewerCtx.close(); await opCtx.close();
} finally {
  await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
