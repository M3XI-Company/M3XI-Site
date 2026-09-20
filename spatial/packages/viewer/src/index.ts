/**
 * @m3xi/viewer
 *
 * The browser experience a prospective tenant or buyer enters instead of
 * travelling to a property.
 *
 * Two entry points:
 *   - `mount()` / `WorldViewer` need a DOM and WebGL2.
 *   - everything under `./headless` is pure computation over a `WorldDocument`
 *     and runs in Node: the constraint solver, the measurement formatter, the
 *     narrative generator, the provenance classifier and the chunk planner.
 *     That split is why most of this package is testable without a GPU.
 */

export { WorldViewer } from './ui/viewer.js';
export { VIEWER_CSS, ensureStyles } from './ui/styles.js';
export { Floorplan } from './ui/floorplan.js';
export { renderNarrative, quantityBlock } from './ui/narrativeView.js';

export { SceneRig, defaultResolveAssetUrl, isMobileViewport } from './render/scene.js';
export { Controls } from './render/controls.js';
export { ProxyLayer } from './render/proxy.js';
export { SplatLayer } from './render/splats.js';
export { OverlayLayer } from './render/overlays.js';
export {
  DARK_THEME, LIGHT_THEME, createSurfaceMaterial, themeFor,
} from './render/materials.js';
export type { ThemeColours } from './render/materials.js';

export * from './headless.js';

import { WorldViewer } from './ui/viewer.js';
import type { ViewerOptions } from './types.js';

/**
 * One-step mount. Returns once the world is walkable, which is before every
 * splat chunk has arrived -- the remaining rooms stream in behind the visitor.
 */
export async function mount(
  container: HTMLElement, options: ViewerOptions,
): Promise<WorldViewer> {
  const viewer = new WorldViewer(container, options);
  await viewer.start();
  return viewer;
}

/**
 * Reads viewer options out of a URL. `?embed=1` is the white-label mode an
 * agency drops onto their own site: no operator controls, their branding, one
 * script tag and one iframe.
 */
export function optionsFromUrl(url: URL): {
  mode: import('./types.js').ViewerMode;
  theme: import('./types.js').ViewerTheme;
  branding: import('./types.js').ViewerBranding;
  worldUrl: string | undefined;
  startNodeId: string | undefined;
} {
  const embed = url.searchParams.get('embed') === '1';
  const operator = !embed && url.searchParams.get('operator') === '1';
  const theme = url.searchParams.get('theme');
  const branding: import('./types.js').ViewerBranding = {
    ...(url.searchParams.get('brand') ? { name: url.searchParams.get('brand')! } : {}),
    ...(url.searchParams.get('logo') ? { logoUrl: url.searchParams.get('logo')! } : {}),
    ...(url.searchParams.get('accent') ? { accent: url.searchParams.get('accent')! } : {}),
    ...(url.searchParams.get('listing') ? { listingUrl: url.searchParams.get('listing')! } : {}),
  };
  return {
    mode: embed ? 'embed' : operator ? 'operator' : 'visitor',
    theme: theme === 'dark' || theme === 'light' ? theme : 'system',
    branding,
    worldUrl: url.searchParams.get('world') ?? undefined,
    startNodeId: url.searchParams.get('at') ?? undefined,
  };
}
