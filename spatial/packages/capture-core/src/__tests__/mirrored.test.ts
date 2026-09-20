/**
 * Every MIRRORED constant, checked against the Python it claims to copy.
 *
 * A comment reading "frames.py TARGET_FPS" is a promise nothing enforces, and
 * an unenforced promise between the phone and the pipeline has a price: an
 * operator told their walk was fine, a rejection thirty-five GPU-minutes and
 * about $0.74 later, and a second appointment at a property whose vendor has
 * gone out. The failure mode is not that somebody edits `thresholds.ts` without
 * looking at `frames.py` — that is obviously wrong and people do not do it. It
 * is that somebody tunes `frames.py`, which is a self-contained stage with its
 * own tests, and never learns that a TypeScript package on the other side of
 * the repository was copying one of its numbers.
 *
 * So this test reads the Python and compares. It is slow by the standards of
 * this suite — four file reads — and that is the entire cost of the guarantee.
 *
 * The `expr` entries are the ones to watch. They are bare literals that the
 * pipeline never gave a name: the 0.25 in `if blur_frac > 0.25` and the 0.50
 * weighting `self.saturation_fraction`. An unnamed literal is exactly what gets
 * changed in passing, so those are matched by pattern and the pattern failing
 * to match at all is a failure too — a silently-skipped check would be worse
 * than no check, because the manifest would still look complete.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIRRORED_FROM_PIPELINE, type MirroredConstant } from '../thresholds.js';

/** packages/capture-core/src/__tests__/ -> spatial/pipeline/worldengine/ */
const PIPELINE = fileURLToPath(new URL('../../../../pipeline/worldengine/', import.meta.url));

const cache = new Map<string, string>();
function source(file: string): string {
  let text = cache.get(file);
  if (text === undefined) {
    text = readFileSync(PIPELINE + file, 'utf8');
    cache.set(file, text);
  }
  return text;
}

/** `NAME = 1.5` at module level, ignoring anything indented inside a function. */
function readAssignment(file: string, symbol: string): number | null {
  const re = new RegExp(`^${symbol}\\s*=\\s*(-?[0-9][0-9_]*\\.?[0-9]*(?:e-?[0-9]+)?)\\s*(?:#.*)?$`, 'm');
  const m = re.exec(source(file));
  return m ? Number(m[1]!.replace(/_/g, '')) : null;
}

/**
 * The threshold out of a `CheckSpec("name", <threshold>, ...)` entry.
 *
 * quality.py writes them positionally across a line break, so the name and the
 * number are not on the same line and a line-oriented regex will not find them.
 * Matching across the newline is the reason this is its own kind rather than
 * another `expr`.
 */
function readCheckSpec(file: string, name: string): number | null {
  const re = new RegExp(`"${name}"\\s*,\\s*(-?[0-9]+\\.?[0-9]*)\\s*,`);
  const m = re.exec(source(file));
  return m ? Number(m[1]!) : null;
}

function readExpression(file: string, pattern: string): number | null {
  const m = new RegExp(pattern).exec(source(file));
  return m ? Number(m[1]!) : null;
}

function pythonValue(c: MirroredConstant): number | null {
  switch (c.how) {
    case 'assign': return readAssignment(c.file, c.symbol);
    case 'checkspec': return readCheckSpec(c.file, c.symbol);
    case 'expr': return c.pattern ? readExpression(c.file, c.pattern) : null;
  }
}

describe('the MIRRORED manifest', () => {
  it('covers every file this package claims to mirror', () => {
    const files = new Set(MIRRORED_FROM_PIPELINE.map((c) => c.file));
    expect(files).toContain('stages/frames.py');
    expect(files).toContain('stages/ingest.py');
    expect(files).toContain('stages/quality.py');
    expect(files).toContain('reflective.py');
  });

  it('names each constant only once', () => {
    const names = MIRRORED_FROM_PIPELINE.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every expr entry a pattern to match with', () => {
    // A missing pattern would make `pythonValue` return null and the value
    // check below fail loudly — but the reason would be obscure, so it is
    // stated here instead.
    for (const c of MIRRORED_FROM_PIPELINE) {
      if (c.how === 'expr') expect(typeof c.pattern).toBe('string');
    }
  });

  it('carries the frames.py constants the brief names, so none was quietly dropped', () => {
    const byName = new Map(MIRRORED_FROM_PIPELINE.map((c) => [c.name, c]));
    for (const name of [
      'TARGET_FPS', 'CANDIDATE_FPS', 'BLUR_REL_FACTOR', 'BLUR_ABS_FLOOR', 'BLUR_WINDOW',
      'MIN_TRACK_INLIER_RATIO', 'MAX_FLOW_FRACTION', 'TARGET_DISPLACEMENT_FRAC',
      'MIN_DISPLACEMENT_FRAC', 'MAX_DISPLACEMENT_FRAC', 'MIN_FRAMES', 'MAX_FRAMES',
      'ABSOLUTE_MIN_FRAMES', 'SCORE_LONG_EDGE',
    ]) {
      expect(byName.get(name)?.file).toBe('stages/frames.py');
    }
  });
});

describe('every MIRRORED constant still equals the Python', () => {
  // One case per constant rather than one loop, so a drift names itself in the
  // failure list instead of hiding inside an aggregate assertion.
  for (const c of MIRRORED_FROM_PIPELINE) {
    it(`${c.name} === ${c.file} ${c.symbol}`, () => {
      const actual = pythonValue(c);
      expect(
        actual,
        `could not find ${c.symbol} in pipeline/worldengine/${c.file}; `
        + 'either it was renamed or the manifest entry is stale, and both mean this '
        + 'package is no longer mirroring what it says it mirrors',
      ).not.toBeNull();
      expect(actual).toBe(c.value);
    });
  }
});

describe('the sanity of the mirror itself', () => {
  it('reads real Python and not an empty string', () => {
    // If the path were wrong, every regex would fail to match and every check
    // above would fail — but with "could not find", which reads like a rename.
    // This distinguishes the two.
    expect(source('stages/frames.py')).toContain('def select_by_overlap');
    expect(source('stages/quality.py')).toContain('CheckSpec');
    expect(source('reflective.py')).toContain('def saturation_fraction');
  });

  it('returns the number that is in the file, and would notice a drift', () => {
    // The mechanism's own self-test. Everything above compares a parsed value
    // to a TypeScript constant, and a parser that somehow echoed the constant
    // back would make all 27 of those checks vacuous while still passing. This
    // one hard-codes what is in the Python today: 2.5, and not 2.6.
    expect(readAssignment('stages/frames.py', 'TARGET_FPS')).toBe(2.5);
    expect(readAssignment('stages/frames.py', 'TARGET_FPS')).not.toBe(2.6);
    expect(readCheckSpec('stages/quality.py', 'blur_rejection_rate')).toBe(0.3);
    expect(readExpression('reflective.py', '([0-9.]+)\\s*\\*\\s*self\\.saturation_fraction'))
      .toBe(0.5);
    // And a symbol that is not there comes back null rather than zero, so a
    // rename reads as "could not find" and not as "drifted to nothing".
    expect(readAssignment('stages/frames.py', 'NO_SUCH_CONSTANT')).toBeNull();
  });

  it('does not match an assignment that is indented inside a function', () => {
    // `readAssignment` is anchored to the start of a line for a reason: a local
    // variable with the same name would otherwise be read as the module
    // constant, and a coincidence like that is undetectable by eye.
    expect(readAssignment('stages/frames.py', 'accum')).toBeNull();
    expect(readAssignment('stages/frames.py', 'target_px')).toBeNull();
  });
});
