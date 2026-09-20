/**
 * Boot.
 *
 * Decide which backend this deployment has, restore a session if there is one,
 * build the shell, and route. Everything below this file is either a pure
 * decision (in `@m3xi/console-ui`) or a page that renders one.
 */

import {
  announce, ensureStyles, installLiveRegions, applyTheme, currentTheme, el, note, toast,
  type ApiClient, type MemberRole, type Membership,
} from '@m3xi/console-ui';
import { isConfigured, readConfig } from './config.js';
import { SupabaseApiClient } from './api/client.js';
import { FixtureApiClient } from './api/fixture.js';
import { go, onRoute, parseHash, type RouteMatch } from './router.js';
import { buildShell, errorPanel, pageFrame } from './shell.js';
import type { PageContext } from './pages/context.js';
import { renderSignIn } from './pages/signin.js';
import { renderPortfolio } from './pages/portfolio.js';
import { renderProperty } from './pages/property.js';
import { renderWorld } from './pages/world.js';
import { renderLeads } from './pages/leads.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderExports } from './pages/exports.js';
import { renderUsage } from './pages/usage.js';
import { renderOrganisation } from './pages/organisation.js';
import { renderPlans } from './pages/plans.js';
import { renderPermanence } from './pages/permanence.js';

const config = readConfig();

const api: ApiClient = isConfigured(config)
  ? new SupabaseApiClient(config.supabaseUrl!, config.supabaseAnonKey!)
  : new FixtureApiClient();

const root = document.getElementById('console');

async function main(): Promise<void> {
  if (!root) throw new Error('no #console element');
  ensureStyles();
  applyTheme(currentTheme());
  installLiveRegions();

  const session = await api.restore().catch(() => null);
  if (!session) { showSignIn(); return; }

  try {
    const all = await api.memberships();
    const membership = await api.useOrg(all[0]?.org.id ?? '');
    startConsole(membership);
  } catch (err) {
    // A valid session with no organisation is a real state: the account exists
    // but nobody has added it to an agency yet.
    root.replaceChildren(el('div', { style: 'max-width:560px;margin:80px auto;padding:0 24px' },
      el('h1', { style: 'font-size:20px' }, 'No organisation'),
      errorPanel(err),
      el('button', {
        class: 'c-btn', type: 'button',
        onclick: () => { void api.signOut().then(() => window.location.reload()); },
      }, 'Sign out'),
    ));
  }
}

function showSignIn(): void {
  if (!root) return;
  root.replaceChildren(renderSignIn({
    isFixture: api.isFixture,
    onSubmit: async ({ email, password }) => {
      await api.signIn(email, password);
      const all = await api.memberships();
      const membership = await api.useOrg(all[0]?.org.id ?? '');
      announce(`Signed in as ${membership.role} of ${membership.org.name}.`);
      startConsole(membership);
      go('#/portfolio');
    },
  }));
  document.title = 'Sign in — M3XI World Viewer';
}

function startConsole(membership: Membership): void {
  if (!root) return;
  const role: MemberRole = membership.role;
  const shell = buildShell({
    membership,
    email: api.session?.email ?? '',
    isFixture: api.isFixture,
    onSignOut: () => {
      void api.signOut().then(() => { window.location.hash = ''; window.location.reload(); });
    },
  });

  const skip = el('a', { class: 'c-skip', href: '#main' }, 'Skip to the main content');
  root.replaceChildren(skip, shell.root);

  let currentRoute: RouteMatch = parseHash(window.location.hash);
  let host: HTMLElement | null = null;

  const render = async (match: RouteMatch): Promise<void> => {
    currentRoute = match;
    shell.setActive(match.name);

    const ctx: PageContext = {
      api,
      config,
      membership,
      role,
      route: match,
      navigate: (hash) => go(hash),
      reload: () => { void render(parseHash(window.location.hash)); },
    };

    // Tell the previous page to let go of its timers and its WebGL context
    // before it is detached, or a build page keeps polling forever.
    host?.dispatchEvent(new CustomEvent('m3xi:teardown'));

    const frame = pageFrame({ title: 'Loading' });
    host = frame.root;

    try {
      const node = await pageFor(match, ctx);
      // A slower page that finished after the operator moved on must not
      // replace the page they are now looking at.
      if (currentRoute !== match) return;
      const container = shell.main.querySelector('[data-page]') ?? el('div', { 'data-page': '' });
      container.replaceChildren(node);
      if (!container.parentElement) shell.main.appendChild(container);
      host = node;

      // A new route starts at the top. Carrying the previous page's scroll
      // position over means arriving at a page already scrolled past its own
      // heading, which reads as missing content.
      window.scrollTo(0, 0);

      const heading = node.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        (heading as HTMLElement).focus({ preventScroll: true });
        document.title = `${heading.textContent} — M3XI World Viewer`;
      }
    } catch (err) {
      const container = shell.main.querySelector('[data-page]') ?? el('div', { 'data-page': '' });
      container.replaceChildren(errorPanel(err));
      if (!container.parentElement) shell.main.appendChild(container);
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  };

  onRoute((match) => { void render(match); });
}

function pageFor(match: RouteMatch, ctx: PageContext): Promise<HTMLElement> {
  switch (match.name) {
    case 'property': return renderProperty(ctx);
    case 'world': return renderWorld(ctx);
    case 'leads': return renderLeads(ctx);
    case 'analytics': return renderAnalytics(ctx);
    case 'exports': return renderExports(ctx);
    case 'usage': return renderUsage(ctx);
    case 'organisation': return renderOrganisation(ctx);
    case 'plans': return renderPlans(ctx);
    case 'permanence': return renderPermanence(ctx);
    case 'signin':
    case 'portfolio':
    default: return renderPortfolio(ctx);
  }
}

void main().catch((err: unknown) => {
  document.body.replaceChildren(el('div', { style: 'padding:40px;font:14px system-ui' },
    note('bad', 'The console did not start', err instanceof Error ? err.message : String(err))));
});
