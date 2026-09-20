import { describe, expect, it } from 'vitest';
import { World } from '@m3xi/spatial-engine';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { buildCertificate, compareIssues, referenceFrom } from '../model/certificate.js';
import { renderDocument } from '../ui/render.js';
import { toText } from '../render/vnode.js';
import {
  CORRECTION_ID, OPERATOR_ID, PROPERTY, WORLD_FACTS, estimateMeasurementRecord,
  laserMeasurementRecord, worldWithBrokenQuantity, worldWithCorrectedRoom,
} from './fixtures.js';

const ISSUED = '2026-03-04T09:00:00.000Z';

function certificateOf(doc = FLAT, over: Partial<Parameters<typeof buildCertificate>[0]> = {}) {
  const world = World.fromDocument(doc);
  return buildCertificate({
    world,
    reference: referenceFrom(doc, PROPERTY, WORLD_FACTS),
    measurementsAvailable: false,
    issuedAt: ISSUED,
    ...over,
  });
}

const textOf = (cert: ReturnType<typeof buildCertificate>): string =>
  toText(renderDocument(cert.document));

describe('the certificate covers the world', () => {
  const cert = certificateOf();

  it('certifies a figure for every room area and every room height', () => {
    for (const room of FLAT.rooms) {
      expect(cert.figures.some((f) => f.id === `room:${room.id}:area`)).toBe(true);
      expect(cert.figures.some((f) => f.id === `room:${room.id}:ceilingHeight`)).toBe(true);
    }
  });

  it('certifies every dimensioned opening', () => {
    const widths = FLAT.openings.filter((o) => o.width).length;
    expect(cert.figures.filter((f) => f.id.endsWith(':width')).length).toBe(widths);
  });

  it('never prints a value without its tolerance and its standard', () => {
    for (const figure of cert.figures) {
      expect(figure.formatted.value.length).toBeGreaterThan(0);
      expect(figure.formatted.tolerance).toMatch(/±/);
      expect(figure.formatted.standardShort.length).toBeGreaterThan(0);
      expect(figure.formatted.full).toContain(figure.formatted.standardShort);
    }
  });

  it('states the property, the survey version and the issue time', () => {
    const text = textOf(cert);
    expect(text).toContain(PROPERTY.label);
    expect(text).toContain('Version 3');
    expect(text).toContain('4 March 2026');
  });
});

describe('a figure the engine will not stand behind', () => {
  const cert = certificateOf();
  const bedroom1 = cert.figures.find((f) => f.id === 'room:r_bed1:area');

  it('is present rather than omitted', () => {
    // The corner of bedroom 1 is model infill in the shared fixture, so this
    // measurement genuinely crosses generated geometry. If the fixture ever
    // stops containing one, this test is the thing that should fail.
    expect(bedroom1).toBeDefined();
  });

  it('is marked indicative and carries the reason in words', () => {
    expect(bedroom1!.presentation).toBe('indicative');
    expect(bedroom1!.reason).toBeTruthy();
    expect(bedroom1!.reason!.length).toBeGreaterThan(20);
  });

  it('reads as INDICATIVE on the page, next to its number', () => {
    const text = textOf(cert);
    expect(text).toContain('INDICATIVE');
    expect(text).toContain(bedroom1!.formatted.value);
  });

  it('is counted in the summary rather than quietly dropped', () => {
    const indicative = cert.figures.filter((f) => f.presentation.includes('indicative'));
    expect(indicative.length).toBeGreaterThan(0);
    expect(textOf(cert)).toContain(`${indicative.length} of them are shown as indicative`);
  });
});

describe('a figure a human declared', () => {
  const cert = certificateOf(worldWithCorrectedRoom(), {
    measurements: [laserMeasurementRecord()],
    measurementsAvailable: true,
  });
  const bath = cert.figures.find((f) => f.id === 'room:r_bath:area');

  it('takes the declared value, not the reconstruction\'s', () => {
    expect(bath!.value).toBe(3.61);
  });

  it('prints the method and the instrument', () => {
    expect(bath!.presentation).toBe('declared');
    expect(bath!.basis).toContain('Measured on site');
    expect(bath!.basis).toContain('laser');
    expect(bath!.basis).toContain(OPERATOR_ID);
    const text = textOf(cert);
    expect(text).toContain('laser distance meter');
  });

  it('keeps the figure it superseded, so both survive', () => {
    expect(bath!.declared?.supersededValue).toBe(3.57);
    expect(textOf(cert)).toContain('3.57');
  });

  it('carries the human correction receipt from the row it sits on', () => {
    expect(bath!.humanTouched).toBe(true);
    expect(bath!.operators).toContain(OPERATOR_ID);
    expect(bath!.declared?.correctionId).toBe(CORRECTION_ID);
  });

  it('shows an operator estimate as indicative, with the method', () => {
    const withEstimate = certificateOf(worldWithCorrectedRoom(), {
      measurements: [estimateMeasurementRecord()],
      measurementsAvailable: true,
    });
    const height = withEstimate.figures.find((f) => f.id === 'room:r_bed2:ceilingHeight');
    expect(height!.presentation).toBe('declared-indicative');
    expect(height!.basis).toContain('estimate');
    expect(toText(renderDocument(withEstimate.document))).toContain('INDICATIVE (DECLARED)');
  });
});

describe('when no measurement records can be read', () => {
  const cert = certificateOf(worldWithCorrectedRoom());

  it('says so, rather than showing an empty table that reads as "none"', () => {
    const text = textOf(cert);
    expect(text).toContain('empty because nothing was read');
    expect(text).toContain('wv_measurement');
  });

  it('still reports how many figures a person has touched', () => {
    expect(textOf(cert)).toContain('human correction receipt');
  });
});

describe('a dimension that cannot be printed at all', () => {
  const cert = certificateOf(worldWithBrokenQuantity());

  it('does not take the rest of the certificate down with it', () => {
    expect(cert.figures.length).toBeGreaterThan(10);
  });

  it('is named, with the reason, instead of being omitted', () => {
    expect(cert.unpresentable.length).toBe(1);
    const text = textOf(cert);
    expect(text).toContain('cannot be certified');
    expect(text).toContain('no declared standard');
  });
});

describe('reissue', () => {
  it('produces the same numbers and the same fingerprint from the same world', () => {
    const a = certificateOf();
    const b = certificateOf(FLAT, { issuedAt: '2027-01-01T00:00:00.000Z' });
    expect(b.issue.fingerprint).toBe(a.issue.fingerprint);
    expect(b.issue.figures).toEqual(a.issue.figures);
  });

  it('changes the fingerprint when a figure changes', () => {
    const declared = certificateOf(worldWithCorrectedRoom(), {
      measurements: [laserMeasurementRecord()],
      measurementsAvailable: true,
    });
    expect(declared.issue.fingerprint).not.toBe(certificateOf().issue.fingerprint);
  });

  it('states that nothing changed when nothing did', () => {
    const first = certificateOf();
    const second = certificateOf(FLAT, {
      issuedAt: '2026-04-01T09:00:00.000Z',
      previousIssue: first.issue,
    });
    expect(toText(renderDocument(second.document)))
      .toContain('identical to the previous one');
  });

  it('lists what changed when a correction has landed since the last issue', () => {
    const first = certificateOf();
    const second = certificateOf(worldWithCorrectedRoom(), {
      issuedAt: '2026-04-01T09:00:00.000Z',
      previousIssue: first.issue,
      measurements: [laserMeasurementRecord()],
      measurementsAvailable: true,
      lastCorrectionAt: '2026-03-02T14:20:00.000Z',
    });
    const diff = compareIssues(first.issue, second.issue);
    expect(diff.identical).toBe(false);
    expect(diff.changed.some((c) => c.id === 'room:r_bath:area')).toBe(true);

    const text = toText(renderDocument(second.document));
    expect(text).toContain('Changed since the previous issue');
    expect(text).toContain('3.61');
  });

  it('says plainly that it cannot report changes when no previous issue exists', () => {
    const text = textOf(certificateOf(FLAT, { lastCorrectionAt: '2026-03-02T14:20:00.000Z' }));
    expect(text).toContain('No previous issue of this certificate was supplied');
    expect(text).toContain('This survey has been corrected');
  });
});

describe('the stored area and the outline', () => {
  it('reports a disagreement rather than choosing one silently', () => {
    const doc = worldWithCorrectedRoom();
    const bath = doc.rooms.find((r) => r.id === 'r_bath')!;
    Object.assign(bath.area, { value: 9.9 });
    expect(textOf(certificateOf(doc))).toContain('the stored area and the outline disagree');
  });
});
