import { mount, optionsFromUrl } from '@m3xi/viewer';
import { StubAgent } from '@m3xi/viewer';
import type { ViewerEvent } from '@m3xi/viewer';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import type { Asset, WorldDocument } from '@m3xi/world-core';

/**
 * The World Viewer page.
 *
 * Query parameters, all optional:
 *   ?slug=<name>    a PUBLISHED property, by the link name the console shows.
 *                   This is what a share link and an embed carry, and it is
 *                   resolved against wv-view rather than against a file.
 *   ?world=<url>    a WorldDocument as JSON. Defaults to the demo flat.
 *   ?splat=<url>    attach a real .spz / .sog / .ply to the demo world.
 *   ?embed=1        white-label visitor mode for an agency's own site.
 *   ?operator=1     internal review: diagnostics and unsurveyed space enterable.
 *   ?theme=         light | dark. Defaults to the visitor's system setting.
 *   ?at=<nodeId>    start at a nav node other than the entrance.
 *   ?brand= &logo= &accent= &listing=   embed branding.
 *
 * `?slug=` wins over `?world=` when both are present: one is a customer's
 * property and the other is a debugging affordance.
 *
 * This page is also the only thing that reports a tour. @m3xi/viewer emits what
 * the visitor did and knows nothing about HTTP; the session, the batching and
 * the flushing all live here, because a self-hosted document and an exported
 * bundle run the same viewer with nowhere to report to. See `TourReport`.
 *
 * Note what happens with no `?splat`: the splat assets are REMOVED rather than
 * left pointing at a file that is not there. A loading bar that can never
 * finish is a lie, and the proxy-only shell is a real product state -- it is
 * what an operator reviews before a capture is published. That removal applies
 * to the DEMO only: a document fetched from a URL or a slug lists the assets
 * that genuinely exist for it, signed and ready to load.
 */

const boot = document.getElementById('boot');
const host = document.getElementById('viewer');

/**
 * Which Supabase project serves wv-view.
 *
 * A host page may set it, a build may set it, and failing both it is the
 * project this repository deploys to -- pinned as `project_id` in
 * supabase/config.toml. The constant is there so that a share link an agency
 * has already sent a buyer keeps working whether or not a build-time variable
 * was set on the day the site was deployed; an agency on its own backend
 * overrides it from the host page.
 *
 * Nothing secret is involved. wv-view is declared `verify_jwt = false` because
 * it is the one endpoint anonymous traffic touches, so no key is sent with
 * this request and none is needed.
 */
const DEFAULT_API_BASE = 'https://tnlcuptfldwxtxajudoq.supabase.co';

interface ViewerGlobal { supabaseUrl?: string }

declare global {
  interface Window { __M3XI_VIEWER__?: ViewerGlobal }
}

async function main(): Promise<void> {
  if (!host) throw new Error('no #viewer element');
  const url = new URL(window.location.href);
  const options = optionsFromUrl(url);

  const doc = await loadWorld(
    publishedWorldUrl(url) ?? options.worldUrl,
    url.searchParams.get('splat'),
  );
  const world = World.fromDocument(doc);

  // Only a published property has anywhere to report to, and only a visitor
  // who has not asked to be left alone is reported. Both decisions are made
  // BEFORE the viewer is mounted, because the way this page declines to track
  // somebody is by never handing the viewer an `onEvent` at all.
  const slug = url.searchParams.get('slug');
  const report = slug && !telemetryDeclined()
    ? new TourReport(apiBase(), slug)
    : undefined;

  const viewer = await mount(host, {
    doc,
    mode: options.mode,
    theme: options.theme,
    branding: options.branding,
    ...(options.startNodeId ? { startNodeId: options.startNodeId } : {}),
    ...(report ? { onEvent: report.handle } : {}),
    locale: navigator.language || 'en-GB',
    // The agent layer. `@m3xi/agent` plugs in here via `adaptM3xiAgent`; until
    // a model client is configured for this deployment, the offline stub
    // answers from the spatial engine alone.
    agent: new StubAgent(world, { locale: navigator.language || 'en-GB' }),
    resolveAssetUrl: (assetUrl) => (
      assetUrl.startsWith('asset://')
        ? `/worlds/${doc.id}/${assetUrl.slice('asset://'.length).split('/').slice(1).join('/')}`
        : assetUrl
    ),
  });

  boot?.remove();
  document.title = `${doc.label} — World Viewer`;

  // Operator diagnostics are reachable from the console as well as the panel,
  // because the first thing anyone asks about a viewer is "what is the frame
  // rate on the device in my hand".
  Object.defineProperty(window, 'm3xiViewer', { value: viewer, configurable: true });

  // The session is minted AFTER the tour is walkable and is never awaited.
  // Analytics is not a precondition for showing somebody a property: if this
  // request is slow the visitor never knows, if it fails the tour is unaffected,
  // and the events the viewer emitted in the meantime are already queued.
  report?.open();

  window.addEventListener('pagehide', () => {
    // dispose() first: it is what produces the `exit` event, and the flush
    // immediately after it is the last chance that event has to be sent. Both
    // are safe to run twice -- the viewer exits once, and a flush with an
    // empty queue does nothing.
    viewer.dispose();
    report?.finish();
  }, { once: true });

  // A tab being hidden is not a departure -- people check a message and come
  // back, and ending the session here would close it server-side and refuse
  // everything they do afterwards. It IS the last reliable moment on iOS, where
  // pagehide is not guaranteed, so the queue is emptied without being closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') report?.flushOnHide();
  });
}

// ---------------------------------------------------------------------------
// Reporting the tour
// ---------------------------------------------------------------------------

/** wv-view refuses a 33rd event in one request, and says so with a 413. */
const MAX_EVENTS_PER_REQUEST = 32;

/**
 * Far below the endpoint's 60-events-per-rolling-minute ceiling for a real
 * tour, and short enough that a visitor who closes the tab from the app
 * switcher -- where no unload event of any kind fires -- has still reported
 * most of what they did.
 */
const FLUSH_INTERVAL_MS = 15_000;

/**
 * Enough for several minutes of walking with the network down, and a bound on
 * what this page will hold in memory for a session that never arrives.
 */
const MAX_QUEUED_EVENTS = 128;

/**
 * DO NOT TRACK AND GLOBAL PRIVACY CONTROL ARE HONOURED, BOTH OF THEM.
 *
 * This is telemetry about a member of the public looking round somebody's
 * home: which rooms held them, how long, what they asked about. It is the
 * agency's data and it is also the visitor's afternoon, and a person who has
 * set either signal has said plainly that they do not want to be measured.
 *
 * Honouring it means no session is minted and no event is sent -- not "sent
 * anonymously", not "kept locally in case". The viewer is handed no `onEvent`,
 * so nothing is even produced, and the tour is identical in every other
 * respect. DNT is deprecated in some browsers and GPC is not implemented in
 * others; both are checked because the cost of checking a signal nobody sends
 * is nothing, and the cost of ignoring one somebody did send is a promise
 * broken.
 */
function telemetryDeclined(): boolean {
  const nav = navigator as Navigator & {
    doNotTrack?: string | null;
    msDoNotTrack?: string | null;
    globalPrivacyControl?: boolean;
  };
  const legacy = (window as Window & { doNotTrack?: string | null }).doNotTrack;
  const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? legacy;
  return nav.globalPrivacyControl === true || dnt === '1' || dnt === 'yes';
}

/**
 * Which Supabase project serves wv-view: the host page's setting, then the
 * build's, then the project this repository deploys to. See DEFAULT_API_BASE.
 */
function apiBase(): string {
  return (window.__M3XI_VIEWER__?.supabaseUrl
    ?? env('VITE_SUPABASE_URL')
    ?? DEFAULT_API_BASE).replace(/\/+$/, '');
}

/**
 * The session, the queue and the flushing.
 *
 * WHY THE QUEUE EXISTS AT ALL. The viewer emits `enter` while it is still
 * mounting, before any session could have been minted, and posting one request
 * per event would be both rude to the endpoint and useless on an unreliable
 * phone connection. So events accumulate and leave in batches of at most 32,
 * which is the endpoint's own limit and roughly a visitor who walked the whole
 * flat between two flushes.
 *
 * WHY A FAILED BATCH IS DROPPED RATHER THAN RETRIED. A retry queue on a dead
 * network grows without bound in a stranger's browser, and the thing being
 * retried is a room-dwell figure. Analytics is best-effort by construction:
 * the tour is the product, and nothing here is allowed to cost the visitor
 * memory, battery or a single frame.
 *
 * WHAT ENDS IT PERMANENTLY. A 404 (this session is not ours, or the world was
 * unpublished mid-tour) and a 409 (the session has already been closed by an
 * exit) are both final, so reporting stops rather than retrying into a wall. A
 * 429 is not final -- the rolling window reopens -- so the batch is dropped and
 * the next flush tries again.
 */
class TourReport {
  private readonly endpoint: string;
  private queue: ViewerEvent[] = [];
  private session: { readonly id: string; readonly viewerKey: string } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(apiOrigin: string, private readonly slug: string) {
    this.endpoint = `${apiOrigin}/functions/v1/wv-view`;
  }

  /**
   * Bound on construction because it is handed to the viewer as a plain
   * function: `ViewerOptions.onEvent` takes a sink, not an object.
   */
  readonly handle = (event: ViewerEvent): void => {
    if (this.stopped) return;
    this.queue.push(event);
    // Over the cap, the OLDEST go: what has to survive a long outage is the
    // end of the tour -- the rooms they were in last and the one they left
    // from -- not the first minute of walking.
    if (this.queue.length > MAX_QUEUED_EVENTS) {
      this.queue.splice(0, this.queue.length - MAX_QUEUED_EVENTS);
    }
    if (event.kind === 'exit') this.finish();
    else if (this.queue.length >= MAX_EVENTS_PER_REQUEST) this.flush();
  };

  /**
   * Mint the session this tour reports against.
   *
   * POSTing the wv-view root returns the whole public manifest and the session
   * alongside it; only the session is wanted here, because the world document
   * this page renders came from `/world.json`. That is a real cost -- a second
   * copy of the property's rows -- and it is paid rather than avoided because
   * the session is the ONLY write capability the events endpoint accepts, and
   * this is the one route that issues one. A lean `session-only` mode on
   * wv-view would remove it; that function is not this page's to change.
   */
  open(): void {
    if (this.stopped || this.session) return;
    void (async (): Promise<void> => {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: this.slug, device: deviceShape() }),
        });
        if (!res.ok) return this.stop();
        const body = await res.json() as { session?: { id?: unknown; viewerKey?: unknown } };
        const id = body.session?.id;
        const viewerKey = body.session?.viewerKey;
        // A manifest without a usable session is not an error the visitor
        // should ever hear about, but it is the end of reporting: without both
        // halves every event would be refused as unauthenticated.
        if (typeof id !== 'string' || typeof viewerKey !== 'string' || !id || !viewerKey) {
          return this.stop();
        }
        // The visitor can leave while this request is in flight -- a tour that
        // lasted four seconds is exactly the kind an agency wants to know
        // about. There is nothing to send by then and nothing to send it with,
        // but a timer started here would outlive the tour it was reporting.
        if (this.stopped) return;
        this.session = { id, viewerKey };
        this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
        this.flush();
      } catch {
        // Offline, blocked by an extension, refused by CORS: all the same
        // answer. The tour carries on and says nothing.
        this.stop();
      }
    })();
  }

  /** The timer, and anything else that just wants the queue emptied. */
  flush(): void {
    this.send('timer');
  }

  /**
   * The tab is being hidden. The tour is NOT over -- the visitor may be back
   * in ten seconds -- but this is the last moment on a phone at which anything
   * is guaranteed to be sent, because a frozen page's in-flight fetch is
   * simply dropped. So the queue leaves by beacon and the session stays open.
   */
  flushOnHide(): void {
    this.send('hidden');
  }

  /**
   * The tour is over: send the tail of the queue, and stop.
   *
   * The TAIL rather than the head, and this is the one place the difference
   * matters. If more than 32 events are outstanding at the end, the last 32
   * are the ones carrying the exit -- the event that names the room the
   * visitor left from, which is the single most useful row the console reads,
   * and the one that is most often lost because it happens as the page dies.
   */
  finish(): void {
    this.send('final');
    this.stop();
  }

  private send(kind: 'timer' | 'hidden' | 'final'): void {
    if (this.stopped || !this.session || this.queue.length === 0) return;
    const final = kind === 'final';
    const batch = final
      ? this.queue.slice(-MAX_EVENTS_PER_REQUEST)
      : this.queue.slice(0, MAX_EVENTS_PER_REQUEST);
    this.queue = final ? [] : this.queue.slice(batch.length);

    const body = JSON.stringify({
      // The credentials travel in the BODY, not in a header, because a beacon
      // cannot set headers -- and the endpoint reads them from the body for
      // exactly that reason.
      sessionId: this.session.id,
      viewerKey: this.session.viewerKey,
      // Mapped field by field rather than posted as-is, so that adding a field
      // to the viewer's event union never silently starts sending it.
      events: batch.map((e) => ({
        kind: e.kind,
        at: e.at,
        ...(e.roomId ? { roomId: e.roomId } : {}),
        payload: e.payload,
      })),
    });

    // A beacon is handed to the browser and outlives the document, which is
    // the whole reason to use one -- and it returns nothing, so the reply
    // cannot be read. That trade is right when the page is going away and
    // wrong the rest of the time: the timer flush uses fetch precisely so that
    // a 404 or a 409 is noticed and reporting stops.
    if (kind !== 'timer' && sendBeacon(`${this.endpoint}/events`, body)) return;

    void fetch(`${this.endpoint}/events`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Racing the page's own teardown; keepalive is what lets the request
      // outlive the document when sendBeacon was unavailable or refused.
      keepalive: kind !== 'timer',
    }).then((res) => {
      if (res.status === 404 || res.status === 409) this.stop();
    }).catch(() => { /* best effort, by design */ });
  }

  private stop(): void {
    this.stopped = true;
    this.queue = [];
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * `sendBeacon`, where the browser has it.
 *
 * The body is a text/plain Blob on purpose. A beacon cannot perform a CORS
 * preflight, and `application/json` is not a safelisted content type, so a
 * JSON beacon to another origin is a beacon that never arrives. wv-view reads
 * the raw body and parses it as JSON whatever the header says, so text/plain
 * is both truthful about what is on the wire and the only thing that works.
 *
 * Returns false when there is no beacon, or when the browser refuses it
 * (usually its own queue being full), so the caller can fall back to fetch.
 */
function sendBeacon(url: string, body: string): boolean {
  try {
    const send = navigator.sendBeacon?.bind(navigator);
    if (!send) return false;
    return send(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
  } catch {
    return false;
  }
}

/**
 * What the session row records about the device.
 *
 * Viewport and pixel ratio, because "this property is toured on phones" is a
 * fact an agency can act on. Deliberately NOT the user agent string or the GPU
 * renderer, which wv-view would accept: both are fingerprinting surfaces, and
 * neither changes a decision anybody makes about a listing.
 */
function deviceShape(): Record<string, number> {
  return {
    dpr: window.devicePixelRatio || 1,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * Turn `?slug=` into the URL of a WorldDocument.
 *
 * The console generates share links of the form `?slug=<link name>`, and
 * `optionsFromUrl` in @m3xi/viewer only knows `?world=<url>`. Translating
 * between them is this page's job and not the package's: the package renders a
 * document and has no business knowing what a Supabase project is, which is
 * also what lets it be embedded by someone who hosts their own.
 *
 * Returns undefined when there is no slug, so `?world=` and the demo are
 * untouched.
 */
function publishedWorldUrl(page: URL): string | undefined {
  const slug = page.searchParams.get('slug');
  if (!slug) return undefined;
  // The same origin the session is minted against. Two different answers here
  // would mean a tour of one project reporting into another's analytics.
  const base = apiBase();
  // Built with URL rather than string concatenation so that a slug carrying
  // anything exotic is encoded rather than injected. The server re-validates
  // it against a closed charset in any case.
  const endpoint = new URL(`${base}/functions/v1/wv-view/world.json`);
  endpoint.searchParams.set('slug', slug);
  return endpoint.toString();
}

function env(key: string): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return meta.env?.[key];
}

async function loadWorld(worldUrl: string | undefined, splatUrl: string | null): Promise<WorldDocument> {
  let doc: WorldDocument = FLAT;
  if (worldUrl) {
    const response = await fetch(worldUrl, { credentials: 'omit' });
    if (!response.ok) throw new Error(`world ${worldUrl}: HTTP ${response.status}`);
    doc = (await response.json()) as WorldDocument;
    if (doc.formatVersion !== 1) throw new Error(`unsupported world format ${doc.formatVersion}`);
  }

  if (splatUrl) {
    const asset: Asset = {
      id: 'a_splat_override',
      role: 'splat',
      format: splatUrl.split('.').pop()?.toLowerCase() ?? 'spz',
      url: splatUrl,
    };
    return { ...doc, assets: [...doc.assets.filter((a) => a.role !== 'splat' && a.role !== 'splat_chunk'), asset] };
  }
  if (worldUrl) return doc;
  return { ...doc, assets: doc.assets.filter((a) => a.role !== 'splat' && a.role !== 'splat_chunk') };
}

main().catch((err: unknown) => {
  console.error('[world-viewer]', err);
  if (!boot) return;
  // A failure states what failed and what the visitor can still do. It does
  // not show a spinner forever and it does not blame them.
  boot.textContent = 'This property tour could not be loaded. The written particulars from the agent still have the room dimensions.';
  boot.setAttribute('role', 'alert');
});
