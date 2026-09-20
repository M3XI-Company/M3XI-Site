import type { WorldDocument } from '@m3xi/world-core';
import { World } from '@m3xi/spatial-engine';
import { buildCertificate, referenceFrom, type CertificateIssue } from '../model/certificate.js';
import { buildChecklist } from '../model/checklist.js';
import { buildPrivacyAudit } from '../model/privacy.js';
import { buildAccessibilityStatement } from '../model/accessibility.js';
import type { ComplianceDocument, DocumentReference } from '../model/document.js';
import {
  REDACTION_KINDS,
  type ComplianceApi, type MeasurementRecord, type MeasurementRecordSource,
  type PropertyFacts, type RedactionDetection, type RedactionSearchRecord,
  type RedactionSource, type WorldFacts,
} from '../model/sources.js';
import { toDom } from '../render/vnode.js';
import { renderDocument, renderStandaloneHtml, type DocumentHandlers } from './render.js';
import { installStyles } from './styles.js';

/**
 * THE COMPLIANCE CENTRE
 * =====================
 *
 * Four documents in four tabs, each of them printable on its own, mounted by
 * the console through `apps/console/src/seams.ts`. The contract is fixed by
 * `console-ui/src/logic/seam.ts` and checked at run time there:
 *
 *   mountComplianceCentre(el, { world, worldId, propertyId, api })
 *     -> { destroy(): void }
 *
 * WHAT THE CONSOLE ACTUALLY PASSES AS `world` IS A `WorldDocument`. The seam
 * types it as `WorldLike = object` and describes it as "a structural stand-in
 * for `World` from `@m3xi/spatial-engine`", but `pages/worldReview.ts` passes
 * `doc` -- the assembled document. Both are accepted here, because the comment
 * and the call site disagree and a compliance pane that failed to mount over a
 * documentation mismatch would be a poor trade. Neither is guessed at: the two
 * shapes are distinguished by `formatVersion`, and anything else is refused in
 * words rather than rendered as an empty document.
 *
 * TWO CAPABILITIES ARE OPTIONAL AND ABSENT TODAY. `redactions` and
 * `measurements` are extra options the console does not currently pass,
 * because `ApiClient` has no method that reads `wv_redaction` or
 * `wv_measurement`. Rather than inventing methods on a client somebody else
 * implements, they are narrow interfaces (`model/sources.ts`) that a console
 * can satisfy later. Where they are missing, the affected document says what
 * it does not know, loudly, and does not render an empty table that reads as
 * "nothing was found".
 */

export interface ComplianceCentreOptions {
  /** A `WorldDocument`, or an engine `World` wrapping one. */
  readonly world: unknown;
  readonly worldId: string;
  readonly propertyId: string;
  readonly api: ComplianceApi;
  /** Reads and writes `wv_redaction`. Absent from the console today. */
  readonly redactions?: RedactionSource;
  /** Reads `wv_measurement`. Absent from the console today. */
  readonly measurements?: MeasurementRecordSource;
  /** The last issue of the certificate, for the reissue diff. */
  readonly previousIssue?: CertificateIssue;
  readonly locale?: string;
  /** Injectable clock, so a test can assert a document's issue timestamp. */
  readonly now?: () => Date;
}

export interface ComplianceCentreHandle {
  destroy(): void;
}

type TabId = 'certificate' | 'checklist' | 'privacy' | 'accessibility';

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'certificate', label: 'Measurement certificate' },
  { id: 'checklist', label: 'Material information' },
  { id: 'privacy', label: 'Privacy and redaction' },
  { id: 'accessibility', label: 'The property in words' },
];

export function mountComplianceCentre(
  host: HTMLElement, options: ComplianceCentreOptions,
): ComplianceCentreHandle {
  const doc = host.ownerDocument;
  installStyles(doc);

  const normalised = normaliseWorld(options.world);
  const root = doc.createElement('div');
  root.className = 'cp-root';
  host.appendChild(root);

  if ('error' in normalised) {
    // A refusal, not a placeholder. The pane says what it was handed and what
    // it needed, because the only person who can fix this is reading it.
    root.appendChild(failure(doc,
      'The compliance centre could not read this world',
      normalised.error));
    return { destroy: () => { root.remove(); } };
  }

  const world = normalised.world;
  const now = options.now ?? (() => new Date());
  const locale = options.locale ?? 'en-GB';

  let destroyed = false;
  let active: TabId = 'certificate';

  // Everything fetched lives here. Each field has an explicit "was it read"
  // flag beside it, because `undefined` has to mean "not read" and never
  // "read, and empty" -- the difference is the whole point of the privacy
  // report.
  let property: PropertyFacts | null = null;
  let worldFacts: WorldFacts | null = null;
  let factsError: string | null = null;
  let measurements: readonly MeasurementRecord[] | undefined;
  let measurementsError: string | undefined;
  let detections: readonly RedactionDetection[] | undefined;
  let searched: readonly RedactionSearchRecord[] | undefined;
  let redactionError: string | undefined;
  let busy: string | null = null;

  const answers = new Map<string, string>();

  const toolbar = doc.createElement('div');
  toolbar.className = 'cp-toolbar cp-noprint';
  const panel = doc.createElement('div');
  panel.id = 'cp-panel';
  root.appendChild(toolbar);
  root.appendChild(panel);

  function build(): ComplianceDocument {
    const issuedAt = now().toISOString();
    const reference: DocumentReference = referenceFrom(world.doc, property, worldFacts);
    const certificate = buildCertificate({
      world,
      reference,
      ...(measurements ? { measurements } : {}),
      measurementsAvailable: measurements !== undefined,
      ...(measurementsError ? { measurementsError } : {}),
      lastCorrectionAt: worldFacts ? worldFacts.lastCorrectionAt : undefined,
      ...(options.previousIssue ? { previousIssue: options.previousIssue } : {}),
      issuedAt,
      locale,
    });

    switch (active) {
      case 'certificate':
        return certificate.document;
      case 'checklist':
        return buildChecklist({
          world, reference, figures: certificate.figures, issuedAt, locale,
        }).document;
      case 'privacy':
        return buildPrivacyAudit({
          reference,
          issuedAt,
          available: detections !== undefined,
          ...(redactionError ? { error: redactionError } : {}),
          ...(detections ? { detections } : {}),
          ...(searched ? { searched } : {}),
          cameraCount: world.doc.cameras.length,
          cameraNames: cameraNames(world.doc),
          canReview: options.redactions !== undefined,
          reviewDisabledReason: options.redactions === undefined
            ? 'The client this page was handed exposes no method that writes to wv_redaction, '
              + 'so no decision made here could be recorded. Review these in the database until '
              + 'it does.'
            : undefined,
        }).document;
      case 'accessibility':
        return buildAccessibilityStatement({ world, reference, issuedAt, locale }).document;
    }
  }

  function handlers(): DocumentHandlers {
    const source = options.redactions;
    return {
      checklistValues: answers,
      onChecklistInput: (id, value) => { answers.set(id, value); },
      ...(source
        ? {
          onApprove: (id: string) => { void act('Approving', () => source.approve(options.worldId, id)); },
          onReject: (id: string) => { void act('Recording the rejection', () => source.reject(options.worldId, id)); },
          onAddRedaction: (input: { cameraId: string; kind: string; bbox: [number, number, number, number] }) => {
            void act('Recording the redaction', () => source.add(options.worldId, input));
          },
          cameraOptions: world.doc.cameras.map((c) => ({
            id: c.id,
            label: cameraLabel(c.id, c.frameIndex, c.roomId, world.doc),
          })),
          redactionKinds: REDACTION_KINDS as readonly string[],
        }
        : {
          addDisabledReason: 'This build has no way to write to wv_redaction, so a redaction '
            + 'recorded here would go nowhere.',
        }),
    };
  }

  /**
   * Run a write, then re-read.
   *
   * Re-reading rather than patching the row in memory is deliberate: the
   * server stamps `reviewed_at` from its own clock and `reviewed_by` from the
   * verified token, so anything this client wrote into the table locally would
   * be a guess at both. A privacy audit that displayed a guessed reviewer and
   * a guessed time would be worse than one that took a round trip.
   */
  async function act(what: string, run: () => Promise<void>): Promise<void> {
    if (destroyed) return;
    busy = `${what}…`;
    paint();
    try {
      await run();
      await loadRedactions();
      busy = null;
    } catch (err) {
      busy = null;
      redactionError = message(err);
    }
    if (!destroyed) paint();
  }

  async function loadRedactions(): Promise<void> {
    const source = options.redactions;
    if (!source) return;
    try {
      detections = await source.listDetections(options.worldId);
      redactionError = undefined;
      if (source.listSearched) {
        searched = await source.listSearched(options.worldId);
      }
    } catch (err) {
      detections = undefined;
      redactionError = message(err);
    }
  }

  function paint(): void {
    if (destroyed) return;
    paintToolbar();
    const document_ = build();
    const tree = renderDocument(document_, handlers());
    panel.replaceChildren(toDom(tree, doc));
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `cp-tab-${active}`);
    panel.setAttribute('tabindex', '0');
  }

  function paintToolbar(): void {
    toolbar.replaceChildren();

    const tabs = doc.createElement('div');
    tabs.className = 'cp-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Compliance documents');

    TABS.forEach((tab, index) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'cp-tab';
      button.id = `cp-tab-${tab.id}`;
      button.textContent = tab.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.id === active ? 'true' : 'false');
      button.setAttribute('aria-controls', 'cp-panel');
      // Roving tabindex: one stop for the whole tablist, arrow keys inside it.
      // A tablist where every tab is a tab stop makes a keyboard user walk
      // through four controls to reach the document.
      button.tabIndex = tab.id === active ? 0 : -1;
      button.addEventListener('click', () => { select(tab.id); });
      button.addEventListener('keydown', (event: KeyboardEvent) => {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (delta === 0) {
          if (event.key === 'Home') { event.preventDefault(); select(TABS[0]!.id, true); }
          if (event.key === 'End') { event.preventDefault(); select(TABS[TABS.length - 1]!.id, true); }
          return;
        }
        event.preventDefault();
        const next = TABS[(index + delta + TABS.length) % TABS.length]!;
        select(next.id, true);
      });
      tabs.appendChild(button);
    });
    toolbar.appendChild(tabs);

    const spacer = doc.createElement('span');
    spacer.className = 'cp-spacer';
    toolbar.appendChild(spacer);

    if (busy) {
      const status = doc.createElement('span');
      status.className = 'cp-status';
      status.setAttribute('role', 'status');
      status.textContent = busy;
      toolbar.appendChild(status);
    }
    if (factsError) {
      const status = doc.createElement('span');
      status.className = 'cp-status';
      status.textContent = `Property record unavailable: ${factsError}`;
      toolbar.appendChild(status);
    }

    toolbar.appendChild(toolbarButton(doc, 'Print this document', () => {
      // Only the active document is in the DOM, so the print stylesheet has
      // one document to lay out and no hidden panels to worry about.
      host.ownerDocument.defaultView?.print();
    }));
    toolbar.appendChild(toolbarButton(doc, 'Save as HTML', () => { saveHtml(); }));
  }

  function select(id: TabId, focus = false): void {
    active = id;
    paint();
    if (!focus) return;
    const next = toolbar.querySelector<HTMLElement>(`#cp-tab-${id}`);
    next?.focus();
  }

  function saveHtml(): void {
    const view = host.ownerDocument.defaultView;
    if (!view) return;
    const document_ = build();
    const html = renderStandaloneHtml(document_, { checklistValues: answers });
    const blob = new view.Blob([html], { type: 'text/html;charset=utf-8' });
    const url = view.URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = fileName(document_);
    link.rel = 'noopener';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    // Released on the next turn of the loop: revoking synchronously races the
    // click in some browsers and the file arrives empty.
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
  }

  paint();

  void (async () => {
    try {
      const [p, w] = await Promise.all([
        options.api.getProperty(options.propertyId),
        options.api.getWorld(options.worldId),
      ]);
      if (destroyed) return;
      property = p;
      worldFacts = w;
      factsError = null;
    } catch (err) {
      factsError = message(err);
    }

    if (options.measurements) {
      try {
        measurements = await options.measurements.listMeasurements(options.worldId);
        measurementsError = undefined;
      } catch (err) {
        measurements = undefined;
        measurementsError = message(err);
      }
    }

    await loadRedactions();
    if (!destroyed) paint();
  })();

  return {
    destroy(): void {
      destroyed = true;
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accept a `WorldDocument` or an engine `World`, and refuse anything else in
 * words.
 *
 * `formatVersion` is the discriminator because it is the one field the
 * contract pins to a literal. Duck-typing on `rooms` would accept any object
 * with an array called rooms, which is how a compliance document ends up
 * rendering somebody's view model.
 */
export function normaliseWorld(input: unknown): { world: World } | { error: string } {
  if (input instanceof World) return { world: input };
  if (typeof input !== 'object' || input === null) {
    return {
      error: `The compliance centre was handed ${input === null ? 'null' : typeof input} where `
        + 'it expected a world document. Nothing can be certified about it.',
    };
  }
  const candidate = input as { doc?: unknown; formatVersion?: unknown };
  if (isWorldDocument(candidate)) {
    try {
      return { world: World.fromDocument(candidate) };
    } catch (err) {
      return { error: `This world document could not be loaded: ${message(err)}` };
    }
  }
  if (candidate.doc && isWorldDocument(candidate.doc)) {
    try {
      return { world: World.fromDocument(candidate.doc as WorldDocument) };
    } catch (err) {
      return { error: `This world document could not be loaded: ${message(err)}` };
    }
  }
  return {
    error: 'The object handed to the compliance centre is neither a world document nor an '
      + 'engine world: it has no formatVersion, and no `doc` that does. No document here can '
      + 'be produced from it, and producing one anyway would mean inventing a property.',
  };
}

function isWorldDocument(value: unknown): value is WorldDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['formatVersion'] === 1 && Array.isArray(v['rooms']) && Array.isArray(v['regions']);
}

function failure(doc: Document, heading: string, text: string): HTMLElement {
  const note = doc.createElement('div');
  note.className = 'cp-note cp-note--bad';
  note.setAttribute('role', 'note');
  const h4 = doc.createElement('h4');
  h4.textContent = heading;
  const p = doc.createElement('p');
  p.textContent = text;
  note.appendChild(h4);
  note.appendChild(p);
  return note;
}

function toolbarButton(doc: Document, label: string, onClick: () => void): HTMLElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'cp-btn';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function cameraNames(doc: WorldDocument): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const camera of doc.cameras) {
    out.set(camera.id, cameraLabel(camera.id, camera.frameIndex, camera.roomId, doc));
  }
  return out;
}

/**
 * A frame, named the way an operator would look for it.
 *
 * A bare uuid in a privacy report is unusable: nobody can check a detection
 * against a frame they cannot find. Frame number and room are what the capture
 * tooling shows, so they are what this shows, with the id kept alongside
 * because it is what the database is queried by.
 */
function cameraLabel(
  id: string, frameIndex: number | undefined, roomId: string | undefined, doc: WorldDocument,
): string {
  const room = roomId ? doc.rooms.find((r) => r.id === roomId) : undefined;
  const where = room ? `, ${room.name ?? room.id}` : '';
  return frameIndex === undefined
    ? `Frame ${id}${where}`
    : `Frame ${frameIndex}${where} (${id})`;
}

function fileName(document_: ComplianceDocument): string {
  const slug = document_.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = document_.issuedAt.slice(0, 10);
  return `${slug}-${document_.reference.worldId}-${stamp}.html`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
