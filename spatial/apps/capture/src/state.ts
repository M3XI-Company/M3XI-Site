/**
 * The wizard, in memory.
 *
 * WHY THERE IS NO ROUTING. The app is served at `/capture` and `/capture/`
 * only; everything under `/capture/*` stays on the filesystem for the PWA
 * shell, so a path-based router here would fight the service worker for URLs
 * that are real files. A hash router would work and is still wrong: the steps
 * of this wizard are not addressable. Step four is "you are recording a
 * stranger's living room"; there is nothing for a URL to mean, a reload cannot
 * resume it, and a back button that took somebody out of a recording they
 * cannot restart would be the worst control in the product.
 *
 * So the state is a value in memory and the screens are functions of it. What
 * SURVIVES a reload is the part that matters and it is not the step: the
 * recording is in IndexedDB as it is made, the upload's offset is in IndexedDB
 * as it goes, and the session is in localStorage. A reload during a walk loses
 * the walk's remaining minutes, which no web app can avoid; it does not lose
 * what was already filmed.
 *
 * `beforeunload` is wired in `main.ts` for the same reason — not to be
 * obstructive, but because the one irreversible thing here is leaving a
 * property, and a mis-swipe should cost a dialog rather than an appointment.
 */

import type { DraftRoom } from './plan.js';
import type { PropertyChoice, WorldChoice } from './api/worlds.js';
import type { CaptureManifest } from './store.js';

export type Step = 'boot' | 'signin' | 'pick' | 'plan' | 'live' | 'verdict' | 'upload' | 'done';

export interface Chosen {
  readonly property: PropertyChoice;
  readonly world: WorldChoice;
}

export interface AppState {
  readonly step: Step;
  readonly email: string | null;
  readonly chosen: Chosen | null;
  readonly rooms: readonly DraftRoom[];
  /** The walk in progress or just finished, as it will be registered. */
  readonly manifest: CaptureManifest | null;
  /** Serialised `VerdictInput` and `VerdictReport` from the worker. */
  readonly verdict: { readonly input: unknown; readonly report: unknown } | null;
  /** Captures on this device that were never registered. */
  readonly unfinished: readonly CaptureManifest[];
  /** A message the current screen must show. Cleared by the screen. */
  readonly problem: string | null;
}

export type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState) { this.state = initial; }

  get current(): AppState { return this.state; }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Replace part of the state and tell everyone.
   *
   * A whole-object replace rather than a mutation, so a screen that captured
   * `state` in a closure cannot silently see a later value — which on the live
   * screen would mean a cue rendered against one frame and a room chip against
   * another.
   */
  set(patch: Partial<AppState>): AppState {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }
}

export function initialState(): AppState {
  return {
    step: 'boot',
    email: null,
    chosen: null,
    rooms: [],
    manifest: null,
    verdict: null,
    unfinished: [],
    problem: null,
  };
}
