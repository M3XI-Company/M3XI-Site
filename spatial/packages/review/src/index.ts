/**
 * @m3xi/review
 *
 * The operator's correction editor: the one place in this system where a
 * human assertion is allowed to enter a world, and the place that has to make
 * sure it enters as what it is.
 *
 * THE ROOT ENTRY EXPORTS ONE FUNCTION, AND THAT IS A CONTRACT, NOT AN
 * OVERSIGHT. `apps/console/src/seams.ts` loads this package with a dynamic
 * import and `console-ui/src/logic/seam.ts` checks the result structurally:
 * a `mountCorrectionEditor` of at least two parameters, returning an object
 * with `destroy` and `save`. Anything else is reported as a version mismatch
 * and the console falls back to its own table. So the shape below is matched
 * to those two files deliberately, and the arity matters.
 *
 * Everything else lives at `@m3xi/review/model`: the correction union, the
 * pure application of a list to a document, the validator, the wire plan and
 * the editing session. That subpath has no DOM in it and imports no renderer,
 * which is what lets the model be used by a test, a server or another
 * package's screen.
 *
 * IMPORTING THIS PACKAGE IN NODE DOES NOT LOAD THREE.JS. `@m3xi/viewer`'s root
 * entry is reached only through a dynamic `import()` behind a button, and
 * `src/__tests__/nodeImport.test.ts` walks this package's static import graph
 * and fails if that ever stops being true.
 */

export { mountCorrectionEditor } from './ui/editor.js';
export type {
  CorrectionEditorHandle, CorrectionEditorOptions, LegacyCorrectionSignal, WorldLike,
} from './ui/editor.js';
