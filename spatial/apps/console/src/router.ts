/**
 * Hash routing.
 *
 * A hash router rather than the History API because the console is a static
 * page in a repo that is deployed by Vercel with no server-side rewrite for
 * it; a deep link under a path would 404 on a hard refresh. Every route is
 * therefore linkable, bookmarkable and survives reload, which matters for the
 * portfolio's filters more than anywhere else.
 */

export interface RouteMatch {
  readonly name: string;
  readonly params: readonly string[];
  /** Everything after `?` within the hash. */
  readonly query: string;
}

export const ROUTES = [
  'signin', 'portfolio', 'property', 'world', 'leads', 'analytics',
  'exports', 'usage', 'organisation', 'plans', 'permanence',
] as const;

export function parseHash(hash: string): RouteMatch {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = (pathPart ?? '').split('/').filter((s) => s.length > 0);
  const name = segments[0] ?? 'portfolio';
  return {
    name: (ROUTES as readonly string[]).includes(name) ? name : 'portfolio',
    params: segments.slice(1),
    query: queryPart,
  };
}

export function go(hash: string): void {
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}

export function onRoute(handler: (match: RouteMatch) => void): () => void {
  const fire = (): void => handler(parseHash(window.location.hash));
  window.addEventListener('hashchange', fire);
  fire();
  return () => window.removeEventListener('hashchange', fire);
}
