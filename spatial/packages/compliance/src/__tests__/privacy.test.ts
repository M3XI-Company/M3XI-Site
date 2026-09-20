import { describe, expect, it } from 'vitest';
import { FLAT } from '@m3xi/spatial-engine/fixtures/flat';
import { referenceFrom } from '../model/certificate.js';
import { buildPrivacyAudit, categorise } from '../model/privacy.js';
import type { PrivacyAuditOptions, RedactionDetection } from '../model/index.js';
import { renderDocument } from '../ui/render.js';
import { toHtml, toText } from '../render/vnode.js';
import { PROPERTY, WORLD_FACTS, redaction } from './fixtures.js';

const ISSUED = '2026-03-04T09:00:00.000Z';
const reference = referenceFrom(FLAT, PROPERTY, WORLD_FACTS);

function audit(over: Partial<PrivacyAuditOptions> = {}) {
  return buildPrivacyAudit({
    reference,
    issuedAt: ISSUED,
    available: true,
    cameraCount: FLAT.cameras.length,
    canReview: true,
    ...over,
  });
}

const textOf = (a: ReturnType<typeof audit>): string => toText(renderDocument(a.document));

const SAMPLE: readonly RedactionDetection[] = [
  redaction({ id: 'r_face_1', kind: 'face', applied: true, reviewedBy: 'u_katherine', reviewedAt: '2026-02-11T12:00:00.000Z' }),
  redaction({ id: 'r_face_2', kind: 'face', applied: true }),
  redaction({ id: 'r_doc_1', kind: 'document', detector: 'doctr', score: 0.64, applied: true, cameraId: 'cam_kitchen_01' }),
  redaction({ id: 'r_screen_1', kind: 'screen', detector: 'owlv2', score: 0.22, applied: false, cameraId: 'cam_bed2_01' }),
];

describe('what was looked for', () => {
  it('lists every category this system knows how to remove, not only the ones with hits', () => {
    const a = audit({ detections: SAMPLE });
    const labels = a.findings.map((f) => f.kind);
    expect(labels).toContain('medication');
    expect(labels).toContain('plate');
    expect(labels).toContain('correspondence');
    expect(a.findings.length).toBeGreaterThanOrEqual(8);
  });

  it('answers "did you look for medication packaging in this tour"', () => {
    const text = textOf(audit({ detections: SAMPLE }));
    expect(text).toContain('Medication and packaging');
    expect(text).toContain('Evidence that it was searched for');
  });

  it('distinguishes a category that produced results from one merely inferred', () => {
    const a = audit({ detections: SAMPLE });
    const face = a.findings.find((f) => f.kind === 'face')!;
    const medication = a.findings.find((f) => f.kind === 'medication')!;
    const correspondence = a.findings.find((f) => f.kind === 'correspondence')!;

    // A face detection proves YuNet ran. A screen detection proves the
    // open-vocabulary model ran, and medication is one of its prompts — an
    // inference, labelled as one. docTR produced a document hit, so
    // correspondence rides on the same detector.
    expect(face.evidence).toBe('detections');
    expect(medication.evidence).toBe('detector-family');
    expect(correspondence.evidence).toBe('detector-family');
  });

  it('reports a category with nothing behind it as having no evidence of a search', () => {
    const a = audit({ detections: [redaction({ kind: 'face' })] });
    const medication = a.findings.find((f) => f.kind === 'medication')!;
    expect(medication.evidence).toBe('none');
    const text = textOf(a);
    expect(text).toContain('NO EVIDENCE OF A SEARCH');
    expect(text).toContain('not as a clean result');
  });

  it('prefers a declared search record over any inference', () => {
    const findings = categorise(
      [redaction({ kind: 'face' })],
      [{ kind: 'medication', searched: true, detector: 'owlv2', threshold: 0.1 }],
    );
    expect(findings.find((f) => f.kind === 'medication')!.evidence).toBe('declared');
  });

  it('does not let an operator-added box pass as evidence that a detector ran', () => {
    const findings = categorise(
      [redaction({ kind: 'medication', detector: 'operator', score: null })], undefined,
    );
    const medication = findings.find((f) => f.kind === 'medication')!;
    expect(medication.found).toBe(1);
    expect(medication.evidence).toBe('none');
  });

  it('shows an unfamiliar kind rather than dropping it', () => {
    const findings = categorise([redaction({ kind: 'tattoo', detector: 'owlv2' })], undefined);
    expect(findings.some((f) => f.kind === 'tattoo')).toBe(true);
  });
});

describe('what was found, and what a person decided', () => {
  const a = audit({ detections: SAMPLE });

  it('counts found, removed, reviewed and awaiting separately', () => {
    const face = a.findings.find((f) => f.kind === 'face')!;
    expect(face.found).toBe(2);
    expect(face.removed).toBe(2);
    expect(face.reviewed).toBe(1);
    expect(face.awaiting).toBe(1);
  });

  it('lists categories searched and found clean', () => {
    expect(textOf(a)).toContain('Searched for and found clean');
  });

  it('puts the rows awaiting a decision first', () => {
    expect(a.rows[0]!.decision).toBe('Awaiting review');
    expect(a.rows[a.rows.length - 1]!.decision).toContain('Reviewed');
  });

  it('says what happened to the pixels in words, never in colour', () => {
    const removed = a.rows.find((r) => r.id === 'r_face_1')!;
    const notRemoved = a.rows.find((r) => r.id === 'r_screen_1')!;
    expect(removed.pixels).toBe('Removed from the frames');
    expect(notRemoved.pixels).toBe('Still visible in the frames');
  });

  it('names the reviewer and the time, from the server, not from the client', () => {
    const text = textOf(a);
    expect(text).toContain('u_katherine');
    expect(text).toContain('11 February 2026');
  });

  it('states plainly when nothing has been reviewed by a human', () => {
    const none = audit({ detections: [redaction({ reviewedAt: null, reviewedBy: null })] });
    expect(textOf(none)).toContain('No human has reviewed any detection');
  });

  it('warns that unreviewed detections hold the publish gate', () => {
    expect(textOf(a)).toContain('have not been reviewed');
  });
});

describe('when the redaction records cannot be read', () => {
  const a = audit({ available: false, canReview: false, detections: undefined });

  it('refuses to look like a clean report', () => {
    const text = textOf(a);
    expect(text).toContain('This report has no data and must not be filed');
    expect(text).toContain('not evidence that a property was clean');
    expect(text).toContain('wv_redaction');
  });

  it('shows no findings and no rows at all', () => {
    expect(a.findings).toHaveLength(0);
    expect(a.rows).toHaveLength(0);
  });

  it('carries the underlying error when there was one', () => {
    const failed = audit({ available: false, error: 'permission denied for table wv_redaction' });
    expect(textOf(failed)).toContain('permission denied for table wv_redaction');
  });
});

describe('review controls', () => {
  it('disables them with a visible, announced reason when nothing can be written', () => {
    const a = audit({
      detections: SAMPLE,
      canReview: false,
      reviewDisabledReason: 'This build cannot write to wv_redaction.',
    });
    const html = toHtml(renderDocument(a.document, {}));
    expect(a.rows.every((r) => !r.actionable)).toBe(true);
    expect(html).toContain('Decisions cannot be recorded from this page');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-describedby="cp-why-');
    expect(toText(renderDocument(a.document, {})))
      .toContain('This build cannot write to wv_redaction.');
  });

  it('offers approve and reject per row when a source is wired in', () => {
    const a = audit({ detections: SAMPLE });
    const seen: string[] = [];
    const html = toHtml(renderDocument(a.document, {
      onApprove: (id) => seen.push(`approve:${id}`),
      onReject: (id) => seen.push(`reject:${id}`),
    }));
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Reject<');
    // The buttons say what they act on for a screen reader, because four
    // identical "Approve" buttons in a table are four identical buttons.
    expect(html).toContain('the Faces detection in');
  });
});

describe('the limits, stated in the report', () => {
  const text = textOf(audit({ detections: SAMPLE }));

  it('says a recorded instruction is not a changed pixel', () => {
    expect(text).toContain('cannot change a pixel');
  });

  it('names the column the schema does not have', () => {
    expect(text).toContain('has no column for which way they decided');
  });

  it('says a rejection does not restore destroyed pixels', () => {
    expect(text).toContain('does not restore them');
  });
});
