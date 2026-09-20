/**
 * The seam with @m3xi/review and @m3xi/compliance.
 *
 * Those packages are another builder's and may not exist yet. The structural
 * checks below run unconditionally against synthetic modules, because the
 * contract is a shape rather than an import. The two tests that need the real
 * packages SKIP when they are absent rather than failing, which is what keeps
 * this suite green in a checkout that does not have them.
 */

import { describe, expect, it } from 'vitest';
import {
  SEAM_ABSENT_COMPLIANCE, SEAM_ABSENT_CORRECTION, isComplianceHandle, isCorrectionHandle,
  readComplianceCentre, readCorrectionEditor,
} from '../logic/seam.js';

async function tryImport(specifier: string): Promise<unknown | null> {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch {
    return null;
  }
}

describe('structural acceptance', () => {
  it('accepts a module exporting a two-argument mount function', () => {
    const mod = { mountCorrectionEditor: (_el: HTMLElement, _opts: unknown) => ({ destroy() {}, save: async () => {} }) };
    expect(readCorrectionEditor(mod)).toBeTypeOf('function');
  });

  it('rejects a module with the right name and the wrong arity', () => {
    expect(readCorrectionEditor({ mountCorrectionEditor: () => ({}) })).toBeNull();
  });

  it('rejects a module that exports something that is not a function', () => {
    expect(readCorrectionEditor({ mountCorrectionEditor: 'soon' })).toBeNull();
    expect(readComplianceCentre({ mountComplianceCentre: 42 })).toBeNull();
  });

  it('rejects nothing at all', () => {
    expect(readCorrectionEditor(null)).toBeNull();
    expect(readCorrectionEditor(undefined)).toBeNull();
    expect(readComplianceCentre({})).toBeNull();
  });

  it('accepts a compliance module of the agreed shape', () => {
    const mod = { mountComplianceCentre: (_el: HTMLElement, _opts: unknown) => ({ destroy() {} }) };
    expect(readComplianceCentre(mod)).toBeTypeOf('function');
  });
});

describe('handles', () => {
  it('requires destroy and save on a correction handle', () => {
    expect(isCorrectionHandle({ destroy() {}, save: async () => {} })).toBe(true);
    expect(isCorrectionHandle({ destroy() {} })).toBe(false);
    expect(isCorrectionHandle(null)).toBe(false);
  });

  it('requires only destroy on a compliance handle', () => {
    expect(isComplianceHandle({ destroy() {} })).toBe(true);
    expect(isComplianceHandle({})).toBe(false);
  });
});

describe('absence is explained rather than crashed', () => {
  it('has a sentence for each missing package that names the fallback', () => {
    expect(SEAM_ABSENT_CORRECTION).toMatch(/not installed/i);
    expect(SEAM_ABSENT_CORRECTION).toMatch(/table below/i);
    expect(SEAM_ABSENT_COMPLIANCE).toMatch(/not installed/i);
  });
});

describe('the real packages, when they exist', () => {
  it('exports mountCorrectionEditor of the agreed shape', async ({ skip }) => {
    const mod = await tryImport('@m3xi/review');
    if (!mod) skip();
    expect(readCorrectionEditor(mod)).toBeTypeOf('function');
  });

  it('exports mountComplianceCentre of the agreed shape', async ({ skip }) => {
    const mod = await tryImport('@m3xi/compliance');
    if (!mod) skip();
    expect(readComplianceCentre(mod)).toBeTypeOf('function');
  });
});
