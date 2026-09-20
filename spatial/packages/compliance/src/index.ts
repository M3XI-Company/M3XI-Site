/**
 * @m3xi/compliance
 *
 * The four documents somebody is later asked to produce: a measurement
 * certificate, a DMCC material-information checklist, a privacy and redaction
 * audit, and the property written out in words.
 *
 * THIS FILE HAS EXACTLY ONE RUNTIME EXPORT, and that is the contract rather
 * than tidiness. `apps/console/src/seams.ts` imports this package
 * dynamically and `console-ui/src/logic/seam.ts` checks the module
 * structurally at run time: a function called `mountComplianceCentre` taking
 * at least two arguments and returning something with `destroy()`. Anything
 * else this module exported would be a second entry point into a document
 * that has one, and a second way for the shapes to drift apart.
 *
 * The models, the document types and the narrow interfaces the console will
 * need in order to supply redaction and measurement records live behind the
 * `./model` subpath, where a consumer reaches for them deliberately.
 */

export { mountComplianceCentre } from './ui/mount.js';
export type { ComplianceCentreHandle, ComplianceCentreOptions } from './ui/mount.js';
