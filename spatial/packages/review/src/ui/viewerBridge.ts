import type { WorldDocument } from '@m3xi/world-core';
import { el, replace, uniqueId } from './dom.js';

/**
 * THE 3D VIEW, IF IT IS THERE AND IF IT IS ASKED FOR
 * ==================================================
 *
 * The floorplan is the pick surface. The viewer is the second opinion, for the
 * two or three questions a plan genuinely cannot answer: is that panel a
 * mirror, is that ceiling really that low, is that wardrobe actually in the
 * alcove.
 *
 * It is loaded with a dynamic `import()` and nothing else in this package
 * refers to it, for a reason that has a test attached:
 *
 *   IMPORTING `@m3xi/review` IN NODE MUST NOT PULL IN THREE.JS.
 *
 * The console mounts this editor through a runtime seam, the correction model
 * runs in tests and could run on a server, and `@m3xi/viewer` drags in three.js
 * and Spark -- megabytes of WebGL that a correction list has no use for. A
 * static import at the top of this file would make every consumer of the
 * correction model pay for a renderer they never open. `src/__tests__/
 * nodeImport.test.ts` walks this package's own static import graph and fails if
 * `three`, `@sparkjsdev/spark` or the viewer's root entry ever appears in it.
 *
 * The specifier goes through a variable on purpose. It keeps TypeScript from
 * resolving the module here -- so this package does not compile against
 * three.js's types either -- and it matches what `apps/console/src/seams.ts`
 * does for the same reason.
 *
 * WHEN IT IS NOT THERE. The viewer needs WebGL2 and a GPU. On a locked-down
 * agency laptop, in a remote desktop session, or with hardware acceleration
 * off, it will not start. That is not treated as a failure of the editor: the
 * plan, the panels and the save path all keep working, and this panel says in
 * plain words what is unavailable and what is still true without it. It never
 * renders a placeholder that looks like a property.
 */

export interface ViewerBridgeOptions {
  /** The corrected world, read at the moment the operator opens the view. */
  doc(): WorldDocument;
}

export interface ViewerBridgeHandle {
  readonly root: HTMLElement;
  /** True once a viewer has been started, so a re-render does not restart it. */
  readonly open: boolean;
  destroy(): void;
}

/** What `@m3xi/viewer`'s root entry must look like for this to use it. */
interface ViewerModule {
  mount(container: HTMLElement, options: { doc: WorldDocument; mode?: string }): Promise<{
    destroy?: () => void;
    dispose?: () => void;
  }>;
}

function readViewerModule(mod: unknown): ViewerModule | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const fn = (mod as Record<string, unknown>)['mount'];
  return typeof fn === 'function' && fn.length >= 2 ? (mod as unknown as ViewerModule) : null;
}

export function mountViewerBridge(opts: ViewerBridgeOptions): ViewerBridgeHandle {
  const headingId = uniqueId('rv-viewer-h');
  const root = el('section', { class: 'rv-panel', 'aria-labelledby': headingId });
  const stage = el('div', { style: 'min-height:0' });
  let started: { destroy?: () => void; dispose?: () => void } | null = null;
  let open = false;

  const status = (tone: 'info' | 'bad', heading: string, body: string): void => {
    replace(stage, el('div', { class: `rv-note rv-note--${tone}`, role: 'status' },
      el('strong', {}, heading), body));
  };

  const start = async (): Promise<void> => {
    if (open) return;
    open = true;
    status('info', 'Starting the 3D view', 'Loading the renderer. The plan stays usable while it loads.');
    const specifier = '@m3xi/viewer';
    let mod: unknown;
    try {
      mod = await import(/* @vite-ignore */ specifier);
    } catch (err) {
      open = false;
      status('bad', 'The 3D view is not installed in this build',
        `${message(err)}. Everything on this screen still works: the plan is drawn from the same document the viewer would read, `
        + 'and the measurements beside it are the same figures.');
      return;
    }

    const viewer = readViewerModule(mod);
    if (!viewer) {
      open = false;
      status('bad', 'The installed viewer does not export what this editor expects',
        'That is a version mismatch, not a fault in this world. The plan and the panels are unaffected.');
      return;
    }

    const host = el('div', { style: 'height:420px' });
    replace(stage, host);
    try {
      started = await viewer.mount(host, { doc: opts.doc(), mode: 'operator' });
    } catch (err) {
      open = false;
      status('bad', 'The 3D view could not start',
        `${message(err)}. This usually means WebGL is unavailable on this machine. `
        + 'The plan is not a preview of the 3D view -- it is drawn from the same document -- so nothing here is missing because of it.');
    }
  };

  replace(root,
    el('h3', { id: headingId }, 'Second opinion'),
    el('p', { class: 'rv-hint' },
      'The plan answers most questions faster. Open the 3D view for the ones it cannot: whether a panel is a mirror, '
      + 'whether a ceiling really is that low. It loads only when you ask for it.'),
    el('div', { class: 'rv-row' },
      el('button', { type: 'button', class: 'rv-btn', onclick: () => { void start(); } },
        'Open the 3D view')),
    stage);

  return {
    root,
    get open() { return open; },
    destroy: () => {
      try {
        started?.destroy?.();
        started?.dispose?.();
      } catch {
        // A renderer that throws on teardown must not take the editor's own
        // teardown with it; the container is dropped below regardless.
      }
      started = null;
      open = false;
      replace(root);
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
