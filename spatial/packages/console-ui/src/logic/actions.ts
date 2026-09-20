/**
 * Every action in the console as a view model, before any DOM exists.
 *
 * The renderer's job is reduced to: draw this list, disable what says
 * disabled, and put `reason` where a person will read it. That makes the
 * access rules testable without a browser, and it makes the two failure modes
 * impossible by construction — an action that is enabled for someone who may
 * not perform it, and an action that is hidden with no explanation at all.
 *
 * Disabled-with-a-reason is the default. Hiding is reserved for whole areas a
 * role has no business in (billing, members), where an empty disabled page
 * would be worse than no page.
 */

import type { GateDecision } from './publishGate.js';
import type { BuildView } from './jobs.js';
import type { Capability, MemberRole } from './roles.js';
import { can } from './roles.js';

export type ActionId =
  | 'property.create'
  | 'property.edit'
  | 'property.archive'
  | 'world.create'
  | 'build.start'
  | 'build.resume'
  | 'build.restart'
  | 'correction.open'
  | 'world.publish'
  | 'world.unpublish'
  | 'share.configure'
  | 'export.create'
  | 'export.download'
  | 'lead.export'
  | 'member.invite'
  | 'billing.manage';

export interface ActionView {
  readonly id: ActionId;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is disabled, or the confirmation text when it is enabled. */
  readonly reason: string;
  /** False when the action should not be drawn at all. */
  readonly visible: boolean;
  /** Primary actions get the filled button; there is at most one per screen. */
  readonly emphasis: 'primary' | 'normal' | 'danger';
  /** True when the action needs a confirmation step before it fires. */
  readonly confirms: boolean;
}

export interface WorldActionContext {
  readonly role: MemberRole | null;
  readonly worldStatus: string;
  readonly gate: GateDecision;
  readonly build: BuildView;
  /** Null when this world has never been given a public link name. */
  readonly slug: string | null;
  readonly hasExportableAssets: boolean;
  /** True while a build request is in flight or a job holds a lease. */
  readonly buildInFlight: boolean;
}

function gated(
  id: ActionId,
  label: string,
  role: MemberRole | null,
  capability: Capability,
  opts: {
    readonly blocked?: string | null;
    readonly emphasis?: ActionView['emphasis'];
    readonly hideWhenDenied?: boolean;
    readonly enabledReason?: string;
    readonly confirms?: boolean;
  } = {},
): ActionView {
  const permitted = can(role, capability);
  if (!permitted) {
    return {
      id,
      label,
      enabled: false,
      visible: opts.hideWhenDenied !== true,
      reason: role
        ? `Your role (${role}) cannot ${label.toLowerCase()}.`
        : 'Sign in to do this.',
      emphasis: opts.emphasis ?? 'normal',
      confirms: opts.confirms === true,
    };
  }
  const blocked = opts.blocked ?? null;
  return {
    id,
    label,
    enabled: blocked === null,
    visible: true,
    reason: blocked ?? opts.enabledReason ?? '',
    emphasis: opts.emphasis ?? 'normal',
    confirms: opts.confirms === true,
  };
}

/**
 * The actions on a world: build, correct, publish, share, export.
 *
 * Publication is the one that matters. It is enabled if and only if
 * `gate.publishable` is true, which is the console's copy of the server's
 * rule. There is no second path to it.
 */
export function worldActions(ctx: WorldActionContext): readonly ActionView[] {
  const { role, gate, build } = ctx;
  const published = ctx.worldStatus === 'published';

  const buildBlocked = ctx.buildInFlight
    ? 'A build is already running for this world.'
    : build.state === 'running' || build.state === 'queued'
      ? 'A build is already running for this world.'
      : null;

  const out: ActionView[] = [];

  out.push(gated('build.start', 'Start a build', role, 'build.start', {
    blocked: buildBlocked,
    emphasis: build.total === 0 ? 'primary' : 'normal',
    enabledReason: build.total === 0
      ? 'Queues the thirteen pipeline stages for this world.'
      : 'Queues a fresh run of all thirteen stages. Work already done is not reused.',
    confirms: build.total > 0,
  }));

  if (build.failure) {
    // The only thing that can block a resume is the attempt ceiling, which is
    // `wv_claim_job`'s and is known from the rows. Everything else the server
    // can refuse — a lease still held, a race with the reaper — is not
    // knowable here and is reported when the call is made.
    const resumeBlocked = build.failure.canResume ? null : build.failure.resumeBlockedReason;
    out.push(gated('build.resume', 'Resume the build', role, 'build.resume', {
      blocked: resumeBlocked,
      emphasis: 'primary',
      enabledReason: `Keeps the ${build.failure.preserved.length} stages that succeeded and restarts at ${build.failure.label}.`,
      confirms: true,
    }));
    out.push(gated('build.restart', 'Start again from scratch', role, 'build.start', {
      blocked: buildBlocked,
      emphasis: 'danger',
      enabledReason: 'Discards every completed stage and pays for the whole pipeline again.',
      confirms: true,
    }));
  }

  out.push(gated('correction.open', 'Open corrections', role, 'correction.apply', {
    blocked: build.state === 'succeeded' || build.total === 0 || published
      ? null
      : 'The build has not finished, so there is nothing to correct yet.',
    emphasis: gate.route === 'correct' ? 'primary' : 'normal',
    enabledReason: 'Rename rooms, fix labels and approve redactions.',
  }));

  out.push(gated('world.publish', published ? 'Re-publish' : 'Publish', role, 'world.publish', {
    blocked: gate.publishable ? null : gate.reason,
    emphasis: gate.publishable && !published ? 'primary' : 'normal',
    enabledReason: published
      ? 'Replaces the live version with this one.'
      : 'Makes this world publicly viewable at its link.',
    confirms: true,
  }));

  out.push(gated('world.unpublish', 'Unpublish', role, 'world.unpublish', {
    blocked: published ? null : 'This world is not live.',
    emphasis: 'danger',
    enabledReason: 'Takes the public link down immediately. Anyone holding the link gets a not-found.',
    confirms: true,
  }));

  out.push(gated('share.configure', 'Share and embed', role, 'share.manage', {
    blocked: published ? null : 'A world has to be live before it can be shared.',
    enabledReason: ctx.slug ? '' : 'Choose the link name visitors will see.',
  }));

  out.push(gated('export.create', 'Build the permanence bundle', role, 'export.create', {
    blocked: ctx.hasExportableAssets ? null : 'There are no assets to package yet. Run a build first.',
    emphasis: 'normal',
    enabledReason: 'Packages this world into a zip that works on its own, forever, with no call back to us.',
  }));

  return out;
}

export interface PortfolioActionContext {
  readonly role: MemberRole | null;
  readonly selectedCount: number;
  /** True when the org has reached its monthly build cap. */
  readonly buildCapReached: boolean;
}

export function portfolioActions(ctx: PortfolioActionContext): readonly ActionView[] {
  return [
    gated('property.create', 'Add a property', ctx.role, 'property.create', {
      emphasis: 'primary',
      enabledReason: 'Creates the listing. The first world version comes next.',
    }),
    gated('build.start', 'Build selected', ctx.role, 'build.start', {
      blocked: ctx.selectedCount === 0
        ? 'Select at least one property.'
        : ctx.buildCapReached
          ? 'This organisation has used its builds for the month.'
          : null,
      enabledReason: `Queues a build for ${ctx.selectedCount} ${ctx.selectedCount === 1 ? 'property' : 'properties'}.`,
      confirms: true,
    }),
    gated('property.archive', 'Archive selected', ctx.role, 'property.archive', {
      blocked: ctx.selectedCount === 0 ? 'Select at least one property.' : null,
      emphasis: 'danger',
      enabledReason: 'Hides them from the portfolio. Published worlds stay live until unpublished.',
      confirms: true,
    }),
    gated('lead.export', 'Export leads', ctx.role, 'lead.export', {
      enabledReason: 'Downloads every lead in this organisation as CSV.',
    }),
  ];
}

/**
 * Whole areas of the console, gated the same way. `visible: false` removes the
 * navigation entry; an operator does not need a billing page they cannot use
 * staring at them all day.
 */
export interface NavEntry {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly visible: boolean;
}

export function navigationFor(role: MemberRole | null): readonly NavEntry[] {
  const entries: { id: string; label: string; href: string; capability?: Capability }[] = [
    { id: 'portfolio', label: 'Portfolio', href: '#/portfolio' },
    { id: 'leads', label: 'Leads', href: '#/leads', capability: 'lead.read' },
    { id: 'analytics', label: 'Analytics', href: '#/analytics', capability: 'analytics.read' },
    { id: 'exports', label: 'Exports', href: '#/exports', capability: 'export.download' },
    { id: 'usage', label: 'Usage and spend', href: '#/usage' },
    { id: 'organisation', label: 'Organisation', href: '#/organisation', capability: 'member.invite' },
    { id: 'plans', label: 'Plans', href: '#/plans' },
  ];
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    href: e.href,
    visible: e.capability ? can(role, e.capability) : role !== null,
  }));
}

export function findAction(actions: readonly ActionView[], id: ActionId): ActionView {
  const found = actions.find((a) => a.id === id);
  if (!found) throw new Error(`No action ${id} in this context`);
  return found;
}
