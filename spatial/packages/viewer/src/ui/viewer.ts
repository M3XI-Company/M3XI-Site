import type { Room, Vec3 } from '@m3xi/world-core';
import { World, type PathResult } from '@m3xi/spatial-engine';

import { planChunks, type ChunkPlan } from '../assets/chunks.js';
import { AgentBridge } from '../agent/bridge.js';
import type { AgentTarget, ViewerContext } from '../agent/contract.js';
import { ViewerEventRecorder } from '../events/session.js';
import { CameraConstraint } from '../nav/constraints.js';
import { buildCameraPath, pitchTo, yawTo, type CameraPath } from '../nav/path.js';
import { formatQuantity } from '../measure/format.js';
import { COMMON_FITS, MeasurementSession, type MeasureTool } from '../measure/session.js';
import { deviceProfile, PerfMonitor, type PerfReport } from '../perf/instrument.js';
import {
  classifyEntity, classifyPoint, coverageSummary, DISPLAY_STYLE,
} from '../provenance/classify.js';
import { Controls } from '../render/controls.js';
import { defaultResolveAssetUrl, isMobileViewport, SceneRig } from '../render/scene.js';
import { buildNarrative, type Narrative } from '../text/narrative.js';
import {
  EMPTY_OVERLAY, poseQuat,
  type BlockReason, type CameraPose, type MeasurementOverlay, type ViewerMode, type ViewerOptions,
} from '../types.js';
import { button, clear, el, focusFirst, ICONS, LiveRegion } from './dom.js';
import { Floorplan } from './floorplan.js';
import { quantityBlock, renderNarrative } from './narrativeView.js';
import { ensureStyles } from './styles.js';

type PanelId = 'rooms' | 'measure' | 'ask' | 'floorplan' | 'text' | 'info' | 'diagnostics';
type Tool = 'move' | 'measure' | 'inspect';

/** Chrome fades after this long without input, if nothing has focus inside it. */
const CHROME_IDLE_MS = 4500;

const BLOCK_MESSAGE: Record<BlockReason, string> = {
  collision: 'Blocked.',
  mirror: 'That is a mirror. The space behind it is a reflection, not a room.',
  unsurveyed: 'You have reached the edge of what the cameras saw. There is nothing surveyed beyond this point.',
  clearance: 'Too narrow to walk through.',
  offgraph: 'There is no walkable floor that way.',
  invalid: 'Cannot move there.',
};

export class WorldViewer {
  readonly world: World;
  readonly narrative: Narrative;

  private readonly container: HTMLElement;
  private readonly mode: ViewerMode;
  private readonly locale: string;
  private readonly reducedMotion: boolean;
  private readonly perf = new PerfMonitor();
  private readonly profile = deviceProfile();
  private readonly events: ViewerEventRecorder;

  private readonly canvas: HTMLCanvasElement;
  private readonly labelHost: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly panelTitle: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly loadingTitle: HTMLElement;
  private readonly loadingDetail: HTMLElement;
  private readonly live = new LiveRegion('polite');
  private readonly railButtons = new Map<PanelId, HTMLButtonElement>();

  private rig!: SceneRig;
  private controls!: Controls;
  private constraint!: CameraConstraint;
  private floorplan!: Floorplan;
  private session!: MeasurementSession;
  private bridge: AgentBridge | undefined;

  private pose: CameraPose = { position: [0, 1.6, 0], yaw: 0, pitch: 0 };
  private tool: Tool = 'move';
  private activePanel: PanelId | undefined;
  private lastFocusBeforePanel: HTMLElement | undefined;
  private flight: { path: CameraPath; startedAt: number; resolve: (ok: boolean) => void } | undefined;
  private plan: ChunkPlan | undefined;
  private rafId = 0;
  private lastTick = 0;
  private lastInputAt = Date.now();
  private currentRoomId: string | undefined;
  private overlays = new Map<string, MeasurementOverlay>();
  private resizeObserver: ResizeObserver | undefined;
  private themeQuery: MediaQueryList | undefined;
  private disposed = false;
  private bytesByAsset = new Map<string, number>();

  constructor(container: HTMLElement, private readonly opts: ViewerOptions) {
    this.container = container;
    this.mode = opts.mode ?? 'visitor';
    this.locale = opts.locale ?? 'en-GB';
    this.reducedMotion = opts.reducedMotion ?? prefersReducedMotion();
    this.world = World.fromDocument(opts.doc);
    this.narrative = buildNarrative(this.world, { locale: this.locale, imperial: true });
    this.events = new ViewerEventRecorder({
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      mode: this.mode,
    });

    ensureStyles(document);
    container.classList.add('m3xi-viewer');
    container.setAttribute('data-mode', this.mode);
    container.setAttribute('data-tool', this.tool);
    if (matchesCoarsePointer()) container.setAttribute('data-coarse', 'true');
    clear(container);

    this.canvas = el('canvas', {
      class: 'm3xi-canvas',
      tabindex: '0',
      role: 'application',
      'aria-roledescription': '3D property walkthrough',
      'aria-label': `${opts.doc.label}. Walk with the arrow keys or W A S D. Turn with the left and right arrows. Press Enter to inspect what is in front of you, V for the next viewpoint, R to return to the entrance, and question mark for all controls.`,
    });
    this.labelHost = el('div', { class: 'm3xi-labels', 'aria-hidden': 'true' });
    this.panel = el('div', { class: 'm3xi-panel', role: 'region', hidden: true, tabindex: '-1' });
    this.panelTitle = el('h2', { id: 'm3xi-panel-title' });
    this.panelBody = el('div', { class: 'm3xi-panel-body' });
    this.rail = el('div', { class: 'm3xi-rail', role: 'toolbar', 'aria-label': 'Viewer tools' });
    this.loadingTitle = el('h2', { text: 'Preparing the property' });
    this.loadingDetail = el('p', { text: 'Building the walkable layout.' });
    this.progressBar = el('span');
    this.loading = el('div', {
      class: 'm3xi-loading', role: 'status', 'aria-live': 'polite',
    }, [
      this.loadingTitle,
      el('div', { class: 'm3xi-progress', role: 'presentation' }, [this.progressBar]),
      this.loadingDetail,
    ]);

    this.mount();
  }

  // =========================================================================
  // Mounting
  // =========================================================================

  private mount(): void {
    const skip = el('a', {
      class: 'm3xi-skip',
      href: '#',
      text: 'Skip the 3D view and read the written tour',
    });
    skip.addEventListener('click', (e) => {
      e.preventDefault();
      this.openPanel('text');
    });
    this.container.appendChild(skip);
    this.container.appendChild(this.canvas);
    this.container.appendChild(this.labelHost);
    this.container.appendChild(el('div', { class: 'm3xi-crosshair', 'aria-hidden': 'true' }));

    const summary = coverageSummary(this.world);
    const coverageChip = el('button', {
      type: 'button',
      class: 'm3xi-coverage',
      'aria-label': `Survey coverage. ${summary.headline} Open the property information panel.`,
    }, [
      el('span', { class: 'm3xi-swatch', 'aria-hidden': 'true' }),
      el('span', { text: coverageChipText(summary.observedFraction, summary.unsurveyedRegions.length) }),
    ]);
    coverageChip.addEventListener('click', () => this.openPanel('info'));

    this.container.appendChild(el('div', { class: 'm3xi-head' }, [
      el('h1', { class: 'm3xi-title' }, [
        this.opts.doc.label,
        el('small', { text: this.subtitle() }),
      ]),
      coverageChip,
    ]));

    if (this.mode === 'embed') this.container.appendChild(this.brandingStrip());

    this.panel.setAttribute('aria-labelledby', 'm3xi-panel-title');
    const close = el('button', {
      type: 'button', class: 'm3xi-close', 'aria-label': 'Close panel', text: '×',
    });
    close.addEventListener('click', () => this.closePanel());
    this.panel.appendChild(el('div', { class: 'm3xi-panel-head' }, [this.panelTitle, close]));
    this.panel.appendChild(this.panelBody);
    this.container.appendChild(this.panel);

    this.container.appendChild(this.touchPad());
    this.buildRail();
    this.container.appendChild(this.rail);
    this.container.appendChild(this.live.node);
    this.container.appendChild(this.loading);

    this.container.addEventListener('keydown', (e) => this.onContainerKeyDown(e));
    for (const type of ['pointerdown', 'keydown', 'wheel', 'focusin'] as const) {
      this.container.addEventListener(type, () => { this.lastInputAt = Date.now(); });
    }

    // `pagehide` is the end of the tour that actually happens: most visitors
    // close the tab or follow the listing link, and nobody calls dispose() on
    // their way out. Without this the exit event -- the one that says WHICH
    // ROOM they left from, which is the single most actionable number in the
    // room table -- is the event that never arrives.
    //
    // `visibilitychange` is deliberately NOT treated as an ending. A backgrounded
    // tab is somebody checking a message, and ending the session there would
    // close the session row server-side and 409 every event they produce when
    // they come back. The host page still FLUSHES on visibilitychange, which is
    // the part that matters: flushing early loses nothing, ending early loses
    // the rest of the tour.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  private readonly onPageHide = (): void => { this.events.exit(); };

  private subtitle(): string {
    const rooms = this.world.doc.rooms.length;
    const doc = this.world.doc;
    const published = doc.publishedAt ? new Date(doc.publishedAt) : new Date(doc.createdAt);
    const when = Number.isNaN(published.getTime())
      ? ''
      : ` · surveyed ${published.toLocaleDateString(this.locale, { month: 'long', year: 'numeric' })}`;
    return `${rooms} surveyed ${rooms === 1 ? 'room' : 'rooms'}${when}`;
  }

  private brandingStrip(): HTMLElement {
    const b = this.opts.branding ?? {};
    const children: Array<Node | string> = [];
    if (b.logoUrl) children.push(el('img', { src: b.logoUrl, alt: b.name ? `${b.name} logo` : 'Agency logo' }));
    else if (b.name) children.push(el('span', { text: b.name }));
    if (b.listingUrl) {
      children.push(el('a', { href: b.listingUrl, text: 'View the listing', rel: 'noopener' }));
    }
    children.push(el('span', { text: 'Powered by M3XI' }));
    const strip = el('div', { class: 'm3xi-brand' }, children);
    if (b.accent) strip.style.setProperty('--accent', b.accent);
    return strip;
  }

  private touchPad(): HTMLElement {
    const pad = el('div', { class: 'm3xi-pad', role: 'group', 'aria-label': 'Movement controls' });
    const make = (label: string, glyph: string, f: number, s: number, t: number): HTMLElement => {
      const b = el('button', { type: 'button', 'aria-label': label, text: glyph });
      const start = (e: Event): void => { e.preventDefault(); this.controls?.setTouchIntent(f, s, t); };
      const stop = (): void => this.controls?.setTouchIntent(0, 0, 0);
      b.addEventListener('pointerdown', start);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
      // Keyboard users get the same buttons: hold via keydown/keyup.
      b.addEventListener('keydown', (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === 'Enter' || ev.key === ' ') start(ev);
      });
      b.addEventListener('keyup', stop);
      b.addEventListener('blur', stop);
      return b;
    };
    pad.appendChild(make('Turn left', '↰', 0, 0, 1));
    pad.appendChild(make('Walk forward', '↑', 1, 0, 0));
    pad.appendChild(make('Turn right', '↱', 0, 0, -1));
    pad.appendChild(make('Step left', '←', 0, -1, 0));
    pad.appendChild(make('Walk back', '↓', -1, 0, 0));
    pad.appendChild(make('Step right', '→', 0, 1, 0));
    return pad;
  }

  private buildRail(): void {
    const add = (id: PanelId, label: string, icon: string): void => {
      const b = button({
        label, icon, expanded: false,
        onClick: () => (this.activePanel === id ? this.closePanel() : this.openPanel(id)),
      });
      this.railButtons.set(id, b);
      this.rail.appendChild(b);
    };
    add('rooms', 'Rooms', ICONS.rooms);
    add('measure', 'Measure', ICONS.measure);
    if (this.opts.agent) add('ask', 'Ask', ICONS.ask);
    add('floorplan', 'Floorplan', ICONS.plan);
    add('text', 'Written tour', ICONS.text);
    add('info', 'Information', ICONS.info);
    // Diagnostics is an operator tool. An agency embedding this on their own
    // site gets the property, not our instrumentation.
    if (this.mode === 'operator') add('diagnostics', 'Diagnostics', ICONS.diag);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    this.constraint = new CameraConstraint(this.world, {
      allowUnsurveyed: this.mode === 'operator',
    });
    const spawn = this.constraint.spawn(this.opts.startNodeId);
    this.pose = { position: spawn.position, yaw: spawn.yaw, pitch: spawn.pitch };
    this.currentRoomId = this.world.roomAt(this.pose.position)?.id;

    // The tour opens here, not when the last splat lands: this is the moment
    // the visitor can stand somewhere and look, and a session that only began
    // once the photography arrived would drop every visitor who left during
    // the download -- exactly the ones an agency most needs to know about.
    this.events.start(this.currentRoomId);

    const hasSplat = this.world.doc.assets.some((a) => a.role === 'splat' || a.role === 'splat_chunk');
    const mobile = isMobileViewport();

    this.rig = new SceneRig({
      canvas: this.canvas,
      world: this.world,
      dark: this.isDark(),
      // With no splat published yet, the proxy IS the view, and an operator is
      // reviewing geometry rather than looking at a photograph.
      shell: !hasSplat,
      mobile,
      splats: {
        resolveUrl: this.opts.resolveAssetUrl ?? defaultResolveAssetUrl,
        enableLod: !mobile,
        onProgress: (e) => {
          this.bytesByAsset.set(e.asset.id, e.bytesLoaded);
          this.perf.setAssetBytes(e.asset.id, e.bytesLoaded);
          this.updateLoading(e.asset.chunkKey, e.bytesLoaded, e.bytesTotal);
        },
        onChunkReady: (asset) => {
          this.perf.setSplatsResident(this.rig.splats.residentSplats);
          if (asset.chunkKey) {
            const room = this.world.room(asset.chunkKey);
            this.live.say(`${room?.name ?? asset.chunkKey} is now in full detail.`);
          }
        },
        onIdle: () => {
          this.perf.markFullyLoaded();
          this.perf.setSplatsResident(this.rig.splats.residentSplats);
          this.perf.collectPageBytes();
          this.perf.collectTransferSizes(this.rig.splats.fetchedUrls);
          this.setLoadingVisible(false);
        },
        onError: (asset, err) => {
          console.error('[m3xi/viewer] chunk failed', asset.id, err);
          this.live.say('One part of the property could not be downloaded. The rest of the tour still works, and the written tour has its dimensions.');
        },
      },
    });

    this.rig.setPose(this.pose);
    this.session = new MeasurementSession(this.world, { locale: this.locale, imperial: true });
    this.floorplan = new Floorplan(this.world, {
      locale: this.locale,
      imperial: true,
      onSelectRoom: (roomId) => { void this.goToRoom(roomId); },
    });

    this.controls = new Controls(this.canvas, this.constraint, this.pose, {
      reducedMotion: this.reducedMotion,
      onBlocked: (reason, by) => this.announceBlock(reason, by),
      onMoved: (pose, roomChanged) => {
        this.pose = pose;
        if (roomChanged) this.onRoomChanged();
      },
      onPick: (x, y) => this.onPick(x, y),
      onCommand: (c) => this.onCommand(c),
    });

    if (this.opts.agent) {
      this.bridge = new AgentBridge(this.opts.agent, this.commands());
    }

    this.observeResize();
    this.watchTheme();

    this.plan = planChunks(this.world.doc, {
      ...(this.currentRoomId ? { currentRoomId: this.currentRoomId } : {}),
      splatBudget: this.opts.splatBudget ?? this.profile.splatBudget,
    });

    // The world is walkable the moment the proxy and the constraint solver
    // exist. Waiting for a splat before letting anyone move would make an
    // honest loading state into a 6-second blank screen.
    this.startLoop();
    this.perf.markInteractive();
    this.setLoadingVisible(this.plan.strategy !== 'proxy-only');

    if (this.plan.strategy === 'proxy-only') {
      this.live.say(
        'This world has no photographic detail yet. You are looking at the measured geometry only.',
      );
      this.perf.markFullyLoaded();
    } else {
      // Spark and the first chunk are fetched together, after the world is
      // already walkable, so the splat renderer is never on the critical path
      // to the first frame.
      await this.rig.enableSplats();
      await this.rig.splats.loadPlan(this.plan);
      this.setLoadingVisible(false);
    }

    this.live.say(`${this.opts.doc.label}. ${this.locationSentence()}`);
  }

  private startLoop(): void {
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tick);
      const dt = this.lastTick === 0 ? 1 / 60 : Math.min(0.1, (now - this.lastTick) / 1000);
      this.lastTick = now;

      if (this.flight) this.advanceFlight(now);
      else this.pose = this.controls.update(dt);

      this.rig.setPose(this.pose);
      this.rig.render();
      this.perf.frame();

      this.positionLabels();
      this.floorplan.setPosition(this.pose.position);
      this.updateChromeVisibility();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Before anything is torn down, while the current room is still known.
    // The recorder makes this exactly once however the tour ended, so a host
    // that disposes after a pagehide does not report two departures.
    this.events.exit();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    cancelAnimationFrame(this.rafId);
    this.flight?.resolve(false);
    this.flight = undefined;
    this.bridge?.dispose();
    this.controls?.dispose();
    this.floorplan?.dispose();
    this.rig?.dispose();
    this.resizeObserver?.disconnect();
    this.themeQuery?.removeEventListener?.('change', this.onThemeChange);
    this.live.dispose();
    clear(this.container);
    this.container.classList.remove('m3xi-viewer');
  }

  metrics(): PerfReport {
    this.perf.collectPageBytes();
    this.perf.setRenderInfo(this.rig.renderStats());
    this.perf.setSplatsResident(this.rig.splats.residentSplats);
    return this.perf.report(this.profile.name);
  }

  // =========================================================================
  // Navigation
  // =========================================================================

  async goToRoom(roomId: string): Promise<boolean> {
    return this.goTo({ kind: 'room', roomId }, {});
  }

  /**
   * Walks the camera somewhere. The route is `World.findPath`, so the camera
   * goes through the doorways a person would use; the spline is validated
   * against the same constraint solver the keyboard uses, so an agent asking
   * for a walk cannot achieve what a visitor cannot.
   */
  async goTo(
    target: AgentTarget,
    opts: { lookAt?: AgentTarget; style?: 'walk' | 'cut'; speedMps?: number },
  ): Promise<boolean> {
    const destination = this.resolveTarget(target);
    if (!destination) return false;
    const path = this.findPathTo(destination.navKey);
    if (!path) return false;

    const lookAtPoint = opts.lookAt ? this.resolveTarget(opts.lookAt)?.point : destination.lookAt;
    const instant = opts.style === 'cut' || this.reducedMotion;

    const cameraPath = buildCameraPath(path, this.pose.yaw, {
      eyeHeight: this.constraint.eyeHeight,
      reducedMotion: instant,
      ...(opts.speedMps ? { speedMps: opts.speedMps } : {}),
      ...(lookAtPoint ? { lookAt: lookAtPoint } : {}),
      validate: (p) => this.constraint.canStand(p).ok,
    });

    this.flight?.resolve(false);
    if (cameraPath.instant) {
      const sample = cameraPath.sample(0);
      this.applyPose(sample);
      this.onRoomChanged();
      return true;
    }

    return new Promise<boolean>((resolve) => {
      this.flight = { path: cameraPath, startedAt: performance.now(), resolve };
    });
  }

  private advanceFlight(now: number): void {
    const flight = this.flight;
    if (!flight) return;
    const t = (now - flight.startedAt) / 1000;
    const sample = flight.path.sample(t);
    this.applyPose(sample);
    if (t >= flight.path.duration) {
      this.flight = undefined;
      flight.resolve(true);
      this.onRoomChanged();
    }
  }

  private applyPose(sample: { position: Vec3; yaw: number; pitch: number }): void {
    this.pose = { position: sample.position, yaw: sample.yaw, pitch: sample.pitch };
    this.controls.setPose(this.pose);
  }

  private findPathTo(key: string | Vec3): PathResult | null {
    // Start from the nav node nearest the camera rather than from the camera
    // itself: the camera may be standing between nodes, and A* needs a node.
    return this.world.findPath(this.pose.position, key as string);
  }

  private resolveTarget(
    target: AgentTarget,
  ): { navKey: string | Vec3; point: Vec3; lookAt?: Vec3 } | undefined {
    switch (target.kind) {
      case 'room': {
        const room = this.world.room(target.roomId);
        if (!room) return undefined;
        const node = this.constraint.nearestViewpoint(this.pose.position, room.id);
        const point = node ? node.position : roomCentre(room);
        return { navKey: room.id, point, lookAt: roomCentre(room) };
      }
      case 'entity': {
        const e = this.world.entity(target.entityId);
        if (!e) return undefined;
        return { navKey: e.id, point: e.centroid, lookAt: e.centroid };
      }
      case 'opening': {
        const o = this.world.opening(target.openingId);
        if (!o) return undefined;
        return { navKey: o.id, point: o.centre, lookAt: o.centre };
      }
      case 'navNode': {
        const n = this.world.doc.nav.nodes.find((x) => x.id === target.nodeId);
        if (!n) return undefined;
        return { navKey: n.id, point: n.position };
      }
      case 'point':
        return { navKey: target.position, point: target.position };
      default:
        return undefined;
    }
  }

  private onRoomChanged(): void {
    const room = this.world.roomAt(this.pose.position);
    this.currentRoomId = room?.id;
    // The viewer already knows this fact and already acts on it; reporting it
    // is one more call at the same place. The recorder decides whether it is a
    // transition at all -- this method is also called when a flight ends in the
    // room it started in.
    this.events.enteredRoom(this.currentRoomId);
    this.floorplan.setCurrentRoom(this.currentRoomId);
    this.live.say(this.locationSentence());
    if (this.activePanel === 'rooms') this.renderPanel('rooms');

    // Re-plan so the room the visitor just walked towards is next in the
    // queue, not still at the back of it.
    if (this.plan && this.plan.strategy === 'chunked' && room) {
      this.plan = planChunks(this.world.doc, {
        currentRoomId: room.id,
        splatBudget: this.opts.splatBudget ?? this.profile.splatBudget,
        loaded: this.rig.splats.loadedChunkKeys,
      });
      void this.rig.splats.loadPlan(this.plan);
    }
  }

  private locationSentence(): string {
    const here = classifyPoint(this.world, this.pose.position);
    const room = this.currentRoomId ? this.world.room(this.currentRoomId) : undefined;
    if (!room) return here.headline;
    const area = formatQuantity(this.world.measureArea(room.id), { locale: this.locale });
    const gaps = here.regions.length > 0 ? ` ${DISPLAY_STYLE.unsurveyed.label} area nearby.` : '';
    return `${room.name ?? room.id}. ${area.speech}${gaps}`;
  }

  private announceBlock(reason: BlockReason, blockedBy: string | undefined): void {
    const what = blockedBy ? this.labelFor(blockedBy) : undefined;
    const base = BLOCK_MESSAGE[reason];
    this.live.say(reason === 'collision' && what ? `Blocked by the ${what}.` : base);
  }

  private labelFor(id: string): string | undefined {
    return this.world.entity(id)?.label
      ?? (this.world.surface(id) ? this.world.surface(id)!.kind : undefined)
      ?? this.world.room(id)?.name;
  }

  private onCommand(command: string): void {
    switch (command) {
      case 'next-viewpoint': this.cycleViewpoint(1); break;
      case 'previous-viewpoint': this.cycleViewpoint(-1); break;
      case 'return-to-entrance': {
        const entrance = this.world.doc.nav.nodes.find((n) => n.isEntrance);
        if (entrance) void this.goTo({ kind: 'navNode', nodeId: entrance.id }, {});
        break;
      }
      case 'measure-here':
        this.setTool('measure');
        this.openPanel('measure');
        this.onPick(0, 0);
        break;
      case 'level-horizon':
        this.applyPose({ ...this.pose, pitch: 0 });
        this.live.say('Horizon levelled.');
        break;
      case 'help':
        this.openPanel('info');
        break;
    }
  }

  private cycleViewpoint(direction: number): void {
    const viewpoints = this.world.doc.nav.nodes.filter((n) => n.isViewpoint);
    if (viewpoints.length === 0) return;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < viewpoints.length; i++) {
      const n = viewpoints[i]!;
      const d = Math.hypot(
        n.position[0] - this.pose.position[0], n.position[2] - this.pose.position[2],
      );
      if (d < best) { best = d; nearest = i; }
    }
    const next = viewpoints[(nearest + direction + viewpoints.length) % viewpoints.length]!;
    void this.goTo({ kind: 'navNode', nodeId: next.id }, {});
  }

  // =========================================================================
  // Picking, measuring, inspecting
  // =========================================================================

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.container.setAttribute('data-tool', tool);
  }

  private onPick(ndcX: number, ndcY: number): void {
    const hit = this.rig.pick(ndcX, ndcY);
    if (!hit) {
      this.live.say('Nothing there within range.');
      return;
    }
    if (this.tool === 'measure') {
      const target = hit.entityId ? { entityId: hit.entityId } : undefined;
      const state = target
        ? this.session.addPoint(hit.point, target)
        : this.session.addPoint(hit.point);
      if (state.result) {
        this.showMeasurement(state.result.overlay);
        this.live.say(state.result.detail);
        // A measurement is reported from HERE, where the visitor's own pick
        // completed one -- not from `showMeasurement`, which the agent also
        // calls to draw the citation behind its own answer. Counting that as
        // "the visitor measured something" would make the console's measure
        // funnel a report on what the agent chose to draw.
        //
        // A fit test that does not fit has no headline quantity; it is
        // recorded as indicative, because the weaker claim is the safe default
        // for a field that means "was the figure they saw defensible".
        this.events.measured(state.result.tool, state.result.primary?.status ?? 'indicative');
      } else {
        this.live.say(state.prompt);
      }
      if (this.activePanel === 'measure') this.renderPanel('measure');
      return;
    }
    this.inspect(hit.point, hit.entityId, hit.surfaceId);
  }

  private inspect(point: Vec3, entityId?: string, surfaceId?: string): void {
    const parts: string[] = [];
    if (entityId) {
      const e = this.world.entity(entityId);
      if (e) {
        const cls = classifyEntity(e);
        parts.push(`${cap(e.label)}.`, cls.note);
        this.setHighlight([e.id]);
      }
    } else if (surfaceId) {
      const s = this.world.surface(surfaceId);
      if (s) {
        parts.push(`${cap(s.kind)}.`);
        if (s.isReflective) parts.push('This is a mirror; what you see in it is a reflection.');
        if (s.isGlazed) parts.push('Glazed.');
      }
    }
    const provenance = classifyPoint(this.world, point);
    parts.push(provenance.headline);
    if (provenance.display !== 'real') parts.push(DISPLAY_STYLE[provenance.display].description);
    this.live.say(parts.join(' '));
  }

  // =========================================================================
  // Panels
  // =========================================================================

  openPanel(id: PanelId): boolean {
    if (id === 'diagnostics' && this.mode !== 'operator') return false;
    if (id === 'ask' && !this.bridge) return false;
    if (this.activePanel !== id) {
      this.lastFocusBeforePanel = document.activeElement as HTMLElement | null ?? undefined;
    }
    this.activePanel = id;
    this.panel.hidden = false;
    for (const [key, b] of this.railButtons) b.setAttribute('aria-expanded', String(key === id));
    this.renderPanel(id);
    focusFirst(this.panel);
    return true;
  }

  closePanel(): void {
    if (!this.activePanel) return;
    const previous = this.railButtons.get(this.activePanel);
    this.activePanel = undefined;
    this.panel.hidden = true;
    for (const b of this.railButtons.values()) b.setAttribute('aria-expanded', 'false');
    (this.lastFocusBeforePanel ?? previous ?? this.canvas).focus({ preventScroll: true });
    if (this.tool === 'measure') this.setTool('move');
  }

  private onContainerKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (!this.activePanel) return;
    e.stopPropagation();
    this.closePanel();
  }

  private renderPanel(id: PanelId): void {
    clear(this.panelBody);
    switch (id) {
      case 'rooms': this.panelTitle.textContent = 'Rooms'; this.renderRooms(); break;
      case 'measure': this.panelTitle.textContent = 'Measure'; this.renderMeasure(); break;
      case 'ask': this.panelTitle.textContent = 'Ask about this property'; this.renderAsk(); break;
      case 'floorplan': this.panelTitle.textContent = 'Floorplan'; this.panelBody.appendChild(this.floorplan.node); break;
      case 'text': this.panelTitle.textContent = 'Written tour'; renderNarrative(this.panelBody, this.narrative, (roomId) => { void this.goToRoom(roomId); }); break;
      case 'info': this.panelTitle.textContent = 'About this survey'; this.renderInfo(); break;
      case 'diagnostics': this.panelTitle.textContent = 'Diagnostics'; this.renderDiagnostics(); break;
    }
  }

  private renderRooms(): void {
    const list = el('ul', { class: 'm3xi-list' });
    for (const room of this.world.doc.rooms) {
      const area = formatQuantity(this.world.measureArea(room.id), { locale: this.locale });
      const row = el('button', {
        type: 'button',
        class: 'm3xi-row',
        'aria-label': `${room.name ?? room.id}. ${area.speech} Walk there.`,
        ...(room.id === this.currentRoomId ? { 'aria-current': 'true' } : {}),
      }, [
        el('span', { text: room.name ?? room.id }),
        el('span', { class: 'm3xi-row-meta', text: `${area.value} ${area.tolerance}` }),
      ]);
      row.addEventListener('click', () => { void this.goToRoom(room.id); });
      list.appendChild(el('li', {}, [row]));
    }
    this.panelBody.appendChild(list);
    this.panelBody.appendChild(el('p', {
      class: 'm3xi-hint',
      text: `Areas are measured to ${formatQuantity(this.world.measureArea(this.world.doc.rooms[0]!.id), { locale: this.locale }).standard}.`,
    }));
  }

  private renderMeasure(): void {
    this.setTool('measure');
    const state = this.session.state;
    const toolbar = el('div', { class: 'm3xi-toolbar', role: 'group', 'aria-label': 'Measurement type' });
    const tools: Array<[MeasureTool, string]> = [
      ['distance', 'Distance'], ['area', 'Room area'], ['clearance', 'Clearance'], ['fit', 'Will it fit'],
    ];
    for (const [tool, label] of tools) {
      const b = button({
        label,
        pressed: state.tool === tool,
        onClick: () => { this.session.setTool(tool); this.clearMeasurements(); this.renderPanel('measure'); },
      });
      toolbar.appendChild(b);
    }
    this.panelBody.appendChild(toolbar);

    if (state.tool === 'fit') {
      const select = el('select', { id: 'm3xi-fit-select' }) as HTMLSelectElement;
      for (const fit of COMMON_FITS) {
        const option = el('option', { value: fit.label, text: fit.label }) as HTMLOptionElement;
        if (fit.label === state.fit.label) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        const fit = COMMON_FITS.find((f) => f.label === select.value);
        if (fit) { this.session.setFit(fit); this.renderPanel('measure'); }
      });
      this.panelBody.appendChild(el('div', { class: 'm3xi-field' }, [
        el('label', { for: 'm3xi-fit-select', text: 'What are you fitting?' }),
        select,
      ]));
    }

    this.panelBody.appendChild(el('p', { class: 'm3xi-hint', text: state.prompt }));
    this.panelBody.appendChild(el('p', {
      class: 'm3xi-hint',
      text: 'Click in the 3D view, or aim the crosshair and press Enter.',
    }));

    const result = state.result;
    if (result) {
      if (result.primary) this.panelBody.appendChild(quantityBlock(headlineLabel(result.tool), result.primary));
      for (const s of result.supporting) this.panelBody.appendChild(quantityBlock(s.label, s.value));
      if (result.fits !== undefined) {
        this.panelBody.appendChild(el('p', {
          class: result.fits ? 'm3xi-hint' : 'm3xi-indicative',
          text: result.detail,
        }));
      } else {
        this.panelBody.appendChild(el('p', { class: 'm3xi-hint', text: result.detail }));
      }
    }

    const actions = el('div', { class: 'm3xi-toolbar' });
    actions.appendChild(button({
      label: 'Undo last point',
      onClick: () => { this.session.undo(); this.clearMeasurements(); this.renderPanel('measure'); },
    }));
    actions.appendChild(button({
      label: 'Clear',
      onClick: () => { this.session.reset(); this.clearMeasurements(); this.renderPanel('measure'); },
    }));
    this.panelBody.appendChild(actions);
  }

  private renderAsk(): void {
    const bridge = this.bridge;
    if (!bridge) return;
    const log = el('div', { class: 'm3xi-ask-log' });
    for (const turn of bridge.transcript) {
      log.appendChild(el('p', { class: 'm3xi-ask-turn', 'data-role': turn.role, text: turn.text }));
    }
    this.panelBody.appendChild(log);

    const input = el('input', {
      type: 'text',
      id: 'm3xi-ask-input',
      'aria-label': 'Ask a question about this property',
      placeholder: 'Ask about this property',
      autocomplete: 'off',
    }) as HTMLInputElement;

    const form = el('form', { class: 'm3xi-ask-form' }, [
      input,
      el('button', { type: 'submit', class: 'm3xi-btn', text: 'Ask' }),
    ]) as HTMLFormElement;

    const ask = async (text: string): Promise<void> => {
      if (text.trim().length === 0) return;
      // Reported before the answer arrives: the fact worth recording is that
      // somebody asked, and an agent that fails to answer is a question that
      // still happened. The text itself never leaves the browser.
      this.events.asked(text);
      input.value = '';
      log.appendChild(el('p', { class: 'm3xi-ask-turn', 'data-role': 'user', text }));
      const thinking = el('p', { class: 'm3xi-ask-turn', 'data-role': 'agent', text: 'Working that out…' });
      log.appendChild(thinking);
      const { answer } = await bridge.ask(text);
      thinking.remove();
      const turn = el('p', { class: 'm3xi-ask-turn', 'data-role': 'agent', text: answer.text });
      log.appendChild(turn);
      if (answer.citations.length > 0) {
        log.appendChild(el('ul', { class: 'm3xi-cites', 'aria-label': 'Shown from' },
          answer.citations.slice(0, 8).map((c) => el('li', {
            class: 'm3xi-cite',
            text: c.quantity ? `${c.label}: ${formatQuantity(c.quantity, { locale: this.locale }).full}` : c.label,
          }))));
      }
      if (answer.suggestions && answer.suggestions.length > 0) {
        const s = el('div', { class: 'm3xi-suggestions' });
        for (const suggestion of answer.suggestions.slice(0, 3)) {
          s.appendChild(button({ label: suggestion, onClick: () => { void ask(suggestion); } }));
        }
        log.appendChild(s);
      }
      log.scrollIntoView?.({ block: 'end' });
    };

    form.addEventListener('submit', (e) => { e.preventDefault(); void ask(input.value); });
    this.panelBody.appendChild(form);

    if (bridge.transcript.length === 0 && bridge.capabilities.examples) {
      const s = el('div', { class: 'm3xi-suggestions' });
      for (const example of bridge.capabilities.examples.slice(0, 4)) {
        s.appendChild(button({ label: example, onClick: () => { void ask(example); } }));
      }
      this.panelBody.appendChild(s);
    }
  }

  private renderInfo(): void {
    const doc = this.world.doc;
    const summary = coverageSummary(this.world);
    this.panelBody.appendChild(el('p', { text: summary.headline }));

    const legend = el('ul', { class: 'm3xi-list' });
    for (const key of ['real', 'estimated', 'unsurveyed'] as const) {
      const style = DISPLAY_STYLE[key];
      legend.appendChild(el('li', {}, [
        el('div', { class: 'm3xi-row', role: 'presentation' }, [
          el('span', {}, [
            el('strong', { text: style.label }),
            el('br'),
            el('span', { class: 'm3xi-row-meta', text: style.description }),
          ]),
        ]),
      ]));
    }
    this.panelBody.appendChild(el('h3', { text: 'How this survey is marked' }));
    this.panelBody.appendChild(legend);

    this.panelBody.appendChild(el('h3', { text: 'Measurement' }));
    this.panelBody.appendChild(el('p', {
      text: `Areas to ${doc.measurementPolicy.areaStandard}, tolerance at least ${doc.measurementPolicy.areaTolerancePct}%. Lengths clear internal, ±${doc.measurementPolicy.wallToleranceMm} mm per segment.`,
    }));
    this.panelBody.appendChild(el('p', {
      text: `Scale fixed by ${doc.scale.source}, ${Math.round(doc.scale.agreement * 100)}% estimator agreement.`,
    }));

    this.panelBody.appendChild(el('h3', { text: 'Keyboard controls' }));
    const keys: Array<[string, string]> = [
      ['W, A, S, D or arrow keys', 'walk and turn'],
      ['Shift', 'walk faster'],
      ['Page Up, Page Down', 'look up and down'],
      ['Home', 'level the horizon'],
      ['Enter', 'inspect or measure what is in front of you'],
      ['V, Shift + V', 'next and previous viewpoint'],
      ['R', 'return to the entrance'],
      ['M', 'measure from here'],
      ['Escape', 'close the open panel'],
    ];
    const dl = el('dl');
    for (const [k, v] of keys) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v }));
    }
    this.panelBody.appendChild(el('div', { class: 'm3xi-diag' }, [dl]));
  }

  private renderDiagnostics(): void {
    const report = this.metrics();
    const plan = this.plan;
    const rows: Array<[string, string]> = [
      ['Device profile', report.deviceProfile],
      ['First paint', ms(report.firstPaintMs)],
      ['Time to interactive', ms(report.timeToInteractiveMs)],
      ['Fully loaded', ms(report.fullyLoadedMs)],
      ['FPS, median', report.frames.fpsMedian.toFixed(0)],
      ['FPS, 1% low', report.frames.fpsOnePercentLow.toFixed(0)],
      ['Frame p95', `${report.frames.frameMsP95.toFixed(1)} ms`],
      ['Jank (>20 ms)', `${(report.frames.jankFraction * 100).toFixed(1)}%`],
      ['Bytes transferred', mb(report.bytesTransferred)],
      ['Splats resident', report.splatsResident.toLocaleString(this.locale)],
      ['Draw calls', String(report.drawCalls ?? 0)],
      ['Geometries', String(report.geometries ?? 0)],
      ['JS heap', report.jsHeapUsedMb === undefined ? 'not exposed by this browser' : `${report.jsHeapUsedMb.toFixed(1)} MB`],
      ['Proxy triangles', (this.world.soup.indices.length / 3).toLocaleString(this.locale)],
      ['Load strategy', plan ? `${plan.strategy}: ${plan.reason}` : 'not planned'],
    ];
    const dl = el('dl');
    for (const [k, v] of rows) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v }));
    }
    this.panelBody.appendChild(el('div', { class: 'm3xi-diag' }, [dl]));
    this.panelBody.appendChild(el('p', {
      class: 'm3xi-hint',
      text: 'Frame statistics are sampled from this session only and reflect this device, not a target device.',
    }));
  }

  // =========================================================================
  // ViewerCommands, for the agent bridge
  // =========================================================================

  private commands() {
    const self = this;
    return {
      get mode() { return self.mode; },
      context(): ViewerContext {
        const visible = self.world.visibleFrom(
          { position: self.pose.position, orientation: poseQuat(self.pose), fov: (60 * Math.PI) / 180 },
          { maxDistance: 22 },
        );
        const here = classifyPoint(self.world, self.pose.position);
        return {
          worldId: self.world.doc.id,
          worldVersion: self.world.doc.version,
          mode: self.mode,
          locale: self.locale,
          pose: self.pose,
          ...(self.currentRoomId ? { roomId: self.currentRoomId } : {}),
          visibleRoomIds: visible.rooms.map((r) => r.id),
          visibleEntityIds: visible.entities.map((e) => e.id),
          provenance: here.provenance,
          activeMeasurements: [...self.overlays.values()],
          loadedChunkKeys: self.rig.splats.loadedChunkKeys,
        };
      },
      goTo: (target: AgentTarget, o: { lookAt?: AgentTarget; style?: 'walk' | 'cut'; speedMps?: number }) =>
        self.goTo(target, o),
      lookAt: (target: AgentTarget): boolean => {
        const resolved = self.resolveTarget(target);
        if (!resolved) return false;
        const at = resolved.lookAt ?? resolved.point;
        self.applyPose({
          position: self.pose.position,
          yaw: yawTo(self.pose.position, at),
          pitch: pitchTo(self.pose.position, at),
        });
        return true;
      },
      viewpoint: (nodeId: string): boolean => {
        const node = self.world.doc.nav.nodes.find((n) => n.id === nodeId && n.isViewpoint);
        if (!node) return false;
        void self.goTo({ kind: 'navNode', nodeId }, {});
        return true;
      },
      setHighlight: (ids: readonly string[], label?: string): boolean => {
        const ok = self.setHighlight(ids);
        if (ok && label) self.live.say(label);
        return ok;
      },
      clearHighlight: (): void => { self.rig.overlays.clearHighlight(); },
      showMeasurement: (overlay: MeasurementOverlay): boolean => self.showMeasurement(overlay),
      clearMeasurements: (): void => self.clearMeasurements(),
      openPanel: (panel: 'rooms' | 'measure' | 'info' | 'floorplan' | 'text'): boolean => self.openPanel(panel),
      emphasiseRooms: (roomIds: readonly string[]): boolean => self.floorplan.emphasise(roomIds),
      announce: (text: string): void => self.live.say(text),
    };
  }

  private setHighlight(ids: readonly string[]): boolean {
    return this.rig.overlays.setHighlight(ids);
  }

  private showMeasurement(overlay: MeasurementOverlay): boolean {
    if (overlay === EMPTY_OVERLAY) return false;
    const ok = this.rig.overlays.show(overlay);
    if (ok) this.overlays.set(overlay.id, overlay);
    return ok;
  }

  private clearMeasurements(): void {
    this.rig.overlays.clear();
    this.overlays.clear();
    clear(this.labelHost);
  }

  // =========================================================================
  // Frame-time chores
  // =========================================================================

  /**
   * Labels are DOM, positioned from the projected world anchor each frame.
   * Nodes are reused between frames and only their transform is written, so a
   * measurement on screen costs a style recalculation, not a re-layout.
   */
  private positionLabels(): void {
    const anchors = this.rig.overlays.labels;
    const existing = new Map<string, HTMLElement>();
    for (const node of Array.from(this.labelHost.children) as HTMLElement[]) {
      existing.set(node.dataset['key'] ?? '', node);
    }
    const seen = new Set<string>();
    const rect = this.container.getBoundingClientRect();

    for (const anchor of anchors) {
      seen.add(anchor.id);
      const projected = this.rig.project(anchor.at);
      let node = existing.get(anchor.id);
      if (!node) {
        node = el('div', { class: 'm3xi-label' });
        node.dataset['key'] = anchor.id;
        this.labelHost.appendChild(node);
      }
      if (!projected.visible) { node.style.display = 'none'; continue; }
      node.style.display = '';
      node.setAttribute('data-status', anchor.status);
      const detail = anchor.detail ?? '';
      if (node.dataset['text'] !== `${anchor.text}|${detail}`) {
        clear(node);
        node.appendChild(document.createTextNode(anchor.text));
        if (detail) node.appendChild(el('small', { text: detail }));
        node.dataset['text'] = `${anchor.text}|${detail}`;
      }
      node.style.left = `${projected.x * rect.width}px`;
      node.style.top = `${projected.y * rect.height}px`;
    }

    for (const [key, node] of existing) if (!seen.has(key)) node.remove();
  }

  private updateChromeVisibility(): void {
    const focusInside = this.container.contains(document.activeElement)
      && document.activeElement !== this.canvas;
    const busy = this.controls.isActive || this.flight !== undefined;
    const idle = Date.now() - this.lastInputAt > CHROME_IDLE_MS;
    const hide = busy && idle && !focusInside && this.activePanel === undefined;
    const current = this.container.getAttribute('data-chrome');
    const next = hide ? 'hidden' : 'shown';
    if (current !== next) this.container.setAttribute('data-chrome', next);
  }

  private setLoadingVisible(visible: boolean): void {
    this.loading.hidden = !visible;
  }

  private updateLoading(chunkKey: string | undefined, loaded: number, total: number): void {
    const room = chunkKey ? this.world.room(chunkKey) : undefined;
    this.loadingTitle.textContent = room
      ? `Loading ${room.name ?? room.id}`
      : 'Loading this property';
    const totalBytes = this.plan?.totalBytes ?? total;
    const done = [...this.bytesByAsset.values()].reduce((s, v) => s + v, 0);
    const pct = totalBytes > 0 ? Math.min(100, (done / totalBytes) * 100) : 0;
    this.progressBar.style.width = `${pct.toFixed(1)}%`;
    // An honest loading state: real megabytes, not a spinner that implies the
    // wait is about to end when it is not.
    this.loadingDetail.textContent = `${mb(done)} of ${mb(totalBytes)}. You can start walking as soon as the first room arrives.`;
  }

  private observeResize(): void {
    const apply = (): void => {
      const rect = this.container.getBoundingClientRect();
      this.rig.resize(rect.width, rect.height);
    };
    apply();
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(apply);
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', apply);
    }
  }

  private onThemeChange = (): void => {
    const dark = this.isDark();
    this.container.setAttribute('data-theme', dark ? 'dark' : 'light');
    this.rig.setTheme(dark);
  };

  private watchTheme(): void {
    const theme = this.opts.theme ?? 'system';
    this.container.setAttribute('data-theme', this.isDark() ? 'dark' : 'light');
    if (theme !== 'system' || typeof matchMedia !== 'function') return;
    this.themeQuery = matchMedia('(prefers-color-scheme: dark)');
    this.themeQuery.addEventListener?.('change', this.onThemeChange);
  }

  private isDark(): boolean {
    const theme = this.opts.theme ?? 'system';
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  }
}

// ---------------------------------------------------------------------------

function roomCentre(room: Room): Vec3 {
  let x = 0, z = 0;
  for (const v of room.polygon) { x += v[0]; z += v[1]; }
  const n = Math.max(1, room.polygon.length);
  return [x / n, room.floorZ + 1.5, z / n];
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function matchesCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

function coverageChipText(fraction: number | undefined, gaps: number): string {
  if (fraction === undefined) {
    return gaps === 0 ? 'Fully surveyed' : `${gaps} ${gaps === 1 ? 'area' : 'areas'} not surveyed`;
  }
  return `${Math.round(fraction * 100)}% surveyed`;
}

function headlineLabel(tool: MeasureTool): string {
  switch (tool) {
    case 'distance': return 'Distance';
    case 'area': return 'Floor area';
    case 'clearance': return 'Clearance';
    case 'fit': return 'Room area';
  }
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function ms(v: number | undefined): string {
  return v === undefined ? 'not reached' : `${Math.round(v)} ms`;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
