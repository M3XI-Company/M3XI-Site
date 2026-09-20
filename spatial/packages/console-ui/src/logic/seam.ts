/**
 * The seam with `@m3xi/review` and `@m3xi/compliance`.
 *
 * Another builder owns those two packages. This console must build, run and
 * pass its tests whether or not they exist yet, so nothing here imports them
 * statically. Instead the modules are loaded at runtime, checked structurally
 * against the agreed shape, and either mounted or replaced with an honest
 * explanation of what is missing.
 *
 * Duck-typing rather than `instanceof` is deliberate. The agreed contract is:
 *
 *   mountCorrectionEditor(el, { world, worldId, api, onDirty, onCorrection })
 *     -> { destroy(): void; save(): Promise<void> }
 *   mountComplianceCentre(el, { world, worldId, propertyId, api })
 *     -> { destroy(): void }
 *
 * If their real shape differs when it lands, this file is the only place that
 * has to change.
 */

import type { ApiClient, Correction } from './api.js';

/** Structural stand-in for `World` from `@m3xi/spatial-engine`. */
export type WorldLike = object;

export interface CorrectionEditorOptions {
  readonly world: WorldLike;
  readonly worldId: string;
  readonly api: ApiClient;
  onDirty(dirty: boolean): void;
  onCorrection(c: Correction): void;
}

export interface CorrectionEditorHandle {
  destroy(): void;
  save(): Promise<void>;
}

export interface ComplianceCentreOptions {
  readonly world: WorldLike;
  readonly worldId: string;
  readonly propertyId: string;
  readonly api: ApiClient;
}

export interface ComplianceCentreHandle {
  destroy(): void;
}

export type MountCorrectionEditor = (
  el: HTMLElement, opts: CorrectionEditorOptions,
) => CorrectionEditorHandle;

export type MountComplianceCentre = (
  el: HTMLElement, opts: ComplianceCentreOptions,
) => ComplianceCentreHandle;

function isFn(v: unknown): v is (...args: never[]) => unknown {
  return typeof v === 'function';
}

/**
 * Accept a module only if it carries a function of the right arity under the
 * right name. Arity is checked because a zero-argument export named
 * `mountCorrectionEditor` is a different thing that happens to share a name,
 * and calling it would fail somewhere less obvious than here.
 */
export function readCorrectionEditor(mod: unknown): MountCorrectionEditor | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const fn = (mod as Record<string, unknown>)['mountCorrectionEditor'];
  if (!isFn(fn) || fn.length < 2) return null;
  return fn as unknown as MountCorrectionEditor;
}

export function readComplianceCentre(mod: unknown): MountComplianceCentre | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const fn = (mod as Record<string, unknown>)['mountComplianceCentre'];
  if (!isFn(fn) || fn.length < 2) return null;
  return fn as unknown as MountComplianceCentre;
}

/** A handle is only usable if it can be torn down. */
export function isCorrectionHandle(v: unknown): v is CorrectionEditorHandle {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return isFn(h['destroy']) && isFn(h['save']);
}

export function isComplianceHandle(v: unknown): v is ComplianceCentreHandle {
  if (typeof v !== 'object' || v === null) return false;
  return isFn((v as Record<string, unknown>)['destroy']);
}

export type SeamStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'absent'; readonly message: string }
  | { readonly kind: 'incompatible'; readonly message: string };

export const SEAM_ABSENT_CORRECTION =
  'The correction editor is not installed in this build. Room names and object labels can still be corrected from the table below, which writes through the same endpoint.';

export const SEAM_ABSENT_COMPLIANCE =
  'The compliance centre is not installed in this build. Redactions and the measurement audit trail are unavailable here.';

export const SEAM_INCOMPATIBLE =
  'The installed package does not export the function this console expects, so it has not been mounted. This is a version mismatch, not a failure of the world.';
