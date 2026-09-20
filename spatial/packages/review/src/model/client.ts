import {
  reconcile, type LegacyCorrection, type SaveReconciliation, type WireCorrection, type WireReport,
} from './wire.js';

/**
 * THE SLICE OF THE CONSOLE'S API CLIENT THIS PACKAGE USES
 * =======================================================
 *
 * Structural, and deliberately not an import of `ApiClient` from
 * `@m3xi/console-ui`.
 *
 * The console mounts this editor through a runtime seam that exists so the
 * console builds and boots whether or not this package is installed. A compile
 * -time import in the other direction would tie the two builds back together
 * for the sake of one method signature, and a version skew in that signature
 * would then break the seam rather than one panel. `console-ui`'s own
 * `seam.ts` does the same thing from its side -- `WorldLike = object` -- for
 * the same reason.
 *
 * NOTHING IS INVENTED HERE. This interface is a SUBSET of the real
 * `ApiClient`: every member below exists on it and does what the name says.
 * Where this package needs something the client does not expose, the answer is
 * to say so rather than to declare a method no backend implements -- see the
 * note on `applyCorrections` below, which is exactly that case.
 */

export interface CorrectionApi {
  /**
   * `wv-worlds approve_corrections`, through the console's client.
   *
   * The real `ApiClient` declares this as `readonly Correction[]`, where
   * `Correction` is the five-field legacy text shape -- room name, room kind,
   * entity label, entity category, entity room -- and nothing else. That
   * declaration is now narrower than the endpoint: the server accepts a
   * `CorrectionRecord`, a bare `CorrectionChange` or the legacy tuple, across
   * eighteen kinds, and prefers the record.
   *
   * So the union below is what the ENDPOINT takes, and the legacy member is
   * kept so the real client's narrower declaration still satisfies this one.
   * That widening belongs in `console-ui/src/logic/api.ts`, which is another
   * package and not this builder's to edit; until it happens, a console typed
   * strictly against its own `Correction` cannot express the other thirteen
   * kinds, and this interface is where the gap is recorded rather than papered
   * over.
   */
  applyCorrections(
    worldId: string, corrections: readonly (WireCorrection | LegacyCorrection)[],
  ): Promise<{ applied: number; rejected: readonly string[] }>;

  /** Null until sign-in completes. Used only to name the operator locally. */
  readonly session?: { readonly userId: string; readonly email: string } | null;

  /** True when the client is reading declared fixtures rather than a database. */
  readonly isFixture?: boolean;
}

/**
 * Who this editor writes on a local receipt.
 *
 * The server ignores it: `approve_corrections` stamps `by` from the verified
 * token, so a client-stated author cannot become the recorded one. It is used
 * for the preview, the draft and the list, where an operator needs to see
 * their own name beside their own decisions.
 */
export function operatorName(api: CorrectionApi): string {
  return api.session?.email ?? api.session?.userId ?? 'unidentified operator';
}

/**
 * Send a planned batch and read the answer honestly.
 *
 * Everything in the plan is sent, including the records `planWire` expects to
 * be refused. Dropping them here would make this editor's prediction the
 * authority on what the server accepts, and it is not: it is a prediction made
 * from a document, about rows it cannot see. The server decides, and
 * `reconcile` reports where the two disagree so a wrong prediction is visible
 * rather than silently self-confirming.
 */
export async function sendCorrections(
  api: CorrectionApi, worldId: string, report: WireReport,
): Promise<SaveReconciliation> {
  if (report.payload.length === 0) {
    throw new Error('There are no corrections to save.');
  }
  if (report.overBatchLimit) {
    throw new Error('This is more corrections than one request may carry. Save them in smaller batches.');
  }
  const outcome = await api.applyCorrections(worldId, report.payload);
  return reconcile(report, {
    applied: typeof outcome?.applied === 'number' ? outcome.applied : 0,
    rejected: Array.isArray(outcome?.rejected) ? outcome.rejected : [],
  });
}
