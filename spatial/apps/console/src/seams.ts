/**
 * Mounting the other builder's packages, if they are there.
 *
 * The imports are dynamic and wrapped, so a checkout without `@m3xi/review`
 * builds, boots and runs. What appears in their place is not an apology: the
 * correction table on the review screen writes through the same
 * `approve_corrections` endpoint the editor would, so an operator can still do
 * the job, more slowly.
 */

import {
  SEAM_ABSENT_COMPLIANCE, SEAM_ABSENT_CORRECTION, SEAM_INCOMPATIBLE, isComplianceHandle,
  isCorrectionHandle, note, readComplianceCentre, readCorrectionEditor,
  type ApiClient, type ComplianceCentreHandle, type Correction, type CorrectionEditorHandle,
} from '@m3xi/console-ui';

async function load(specifier: string): Promise<unknown | null> {
  try {
    // @vite-ignore: the package may not exist, and that is a supported state.
    return await import(/* @vite-ignore */ specifier);
  } catch {
    return null;
  }
}

export interface CorrectionMount {
  readonly handle: CorrectionEditorHandle | null;
  readonly fallback: HTMLElement | null;
}

export async function mountCorrections(host: HTMLElement, opts: {
  world: object;
  worldId: string;
  api: ApiClient;
  onDirty: (dirty: boolean) => void;
  onCorrection: (c: Correction) => void;
}): Promise<CorrectionMount> {
  const mod = await load('@m3xi/review');
  if (!mod) return { handle: null, fallback: note('info', 'Correction editor not installed', SEAM_ABSENT_CORRECTION) };

  const mount = readCorrectionEditor(mod);
  if (!mount) return { handle: null, fallback: note('warn', 'Correction editor could not be mounted', SEAM_INCOMPATIBLE) };

  try {
    const handle = mount(host, opts);
    if (!isCorrectionHandle(handle)) {
      return { handle: null, fallback: note('warn', 'Correction editor could not be mounted', SEAM_INCOMPATIBLE) };
    }
    return { handle, fallback: null };
  } catch (err) {
    return {
      handle: null,
      fallback: note('bad', 'The correction editor failed to start', String(err instanceof Error ? err.message : err)),
    };
  }
}

export interface ComplianceMount {
  readonly handle: ComplianceCentreHandle | null;
  readonly fallback: HTMLElement | null;
}

export async function mountCompliance(host: HTMLElement, opts: {
  world: object;
  worldId: string;
  propertyId: string;
  api: ApiClient;
}): Promise<ComplianceMount> {
  const mod = await load('@m3xi/compliance');
  if (!mod) return { handle: null, fallback: note('info', 'Compliance centre not installed', SEAM_ABSENT_COMPLIANCE) };

  const mount = readComplianceCentre(mod);
  if (!mount) return { handle: null, fallback: note('warn', 'Compliance centre could not be mounted', SEAM_INCOMPATIBLE) };

  try {
    const handle = mount(host, opts);
    if (!isComplianceHandle(handle)) {
      return { handle: null, fallback: note('warn', 'Compliance centre could not be mounted', SEAM_INCOMPATIBLE) };
    }
    return { handle, fallback: null };
  } catch (err) {
    return {
      handle: null,
      fallback: note('bad', 'The compliance centre failed to start', String(err instanceof Error ? err.message : err)),
    };
  }
}
