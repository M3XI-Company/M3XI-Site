/**
 * @m3xi/console-ui
 *
 * The operator console's toolkit: a logic layer that decides things with no
 * DOM in it at all, and a thin DOM layer that renders those decisions.
 *
 * The split is the point. Role gates, the publish gate, the job DAG, the
 * analytics arithmetic and the spend caps are all pure functions over plain
 * data, so they are tested in Node at millisecond speed and cannot drift out
 * of step with the screens that show them.
 */

export * from './logic/index.js';
export * from './ui/styles.js';
export * from './ui/dom.js';
export * from './ui/components.js';
