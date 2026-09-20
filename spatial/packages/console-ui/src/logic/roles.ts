/**
 * Who may do what, in the UI layer.
 *
 * The database is the real boundary: RLS decides what rows a member can read
 * and `wv-worlds` re-derives membership on every action. This module exists
 * for the *other* half of the problem — a console that offers a viewer a
 * Publish button and then shows them a 404 is a worse product than one that
 * never offered it, and an operator who cannot find the Members page because
 * it is simply missing has learned something true in one second.
 *
 * So: capabilities are computed here, rendered as disabled-with-a-reason or
 * omitted entirely, and the server still checks. Two locks, one key.
 *
 * The roles are exactly `wv_member_role` from
 * supabase/migrations/20260919170000_world_viewer_core.sql. If that enum
 * changes, this file is wrong and the type error will say so.
 */

export const MEMBER_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Everything the console can be asked to do. Named after the thing, not the
 * screen, so a capability survives a redesign.
 */
export type Capability =
  | 'property.create'
  | 'property.edit'
  | 'property.archive'
  | 'world.create'
  | 'build.start'
  | 'build.resume'
  | 'correction.apply'
  | 'world.publish'
  | 'world.unpublish'
  | 'share.manage'
  | 'lead.read'
  | 'lead.export'
  | 'analytics.read'
  | 'export.create'
  | 'export.download'
  | 'member.invite'
  | 'member.role.change'
  | 'member.remove'
  | 'billing.manage'
  | 'org.settings'
  | 'org.delete';

/** Read-only capabilities every member of an org has, including a viewer. */
const VIEWER: readonly Capability[] = [
  'analytics.read',
  'lead.read',
  'export.download',
];

/**
 * An operator runs the working life of a property: capture to publish. They
 * do not touch people, money or the org itself.
 */
const OPERATOR: readonly Capability[] = [
  ...VIEWER,
  'property.create',
  'property.edit',
  'world.create',
  'build.start',
  'build.resume',
  'correction.apply',
  'world.publish',
  'world.unpublish',
  'share.manage',
  'lead.export',
  'export.create',
];

/** An admin additionally runs the account: members, billing, settings. */
const ADMIN: readonly Capability[] = [
  ...OPERATOR,
  'property.archive',
  'member.invite',
  'member.role.change',
  'member.remove',
  'billing.manage',
  'org.settings',
];

/** The owner is the only role that can end the organisation. */
const OWNER: readonly Capability[] = [...ADMIN, 'org.delete'];

const MATRIX: Readonly<Record<MemberRole, readonly Capability[]>> = {
  owner: OWNER,
  admin: ADMIN,
  operator: OPERATOR,
  viewer: VIEWER,
};

export function capabilitiesFor(role: MemberRole): readonly Capability[] {
  return MATRIX[role];
}

export function can(role: MemberRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  const list = MATRIX[role];
  return list ? list.includes(capability) : false;
}

/** Ranking used for "you cannot act on someone senior to you". */
const RANK: Readonly<Record<MemberRole, number>> = {
  owner: 3, admin: 2, operator: 1, viewer: 0,
};

export function roleRank(role: MemberRole): number {
  return RANK[role];
}

export const ROLE_DESCRIPTIONS: Readonly<Record<MemberRole, string>> = {
  owner:
    'Full control, including billing and closing the account. There is always at least one owner.',
  admin:
    'Everything an operator can do, plus members, billing and organisation settings.',
  operator:
    'Runs properties end to end: capture, build, correct, publish, share, export.',
  viewer:
    'Read-only. Sees the portfolio, analytics, leads and finished exports; changes nothing.',
};

export interface RoleChangeDecision {
  readonly allowed: boolean;
  /** Plain sentence shown next to the disabled control. Never a code. */
  readonly reason: string;
}

const ALLOWED = { allowed: true, reason: '' } as const;

/**
 * May `actor` move `target` from `current` to `next`?
 *
 * These are `set_member_role`'s rules in wv-worlds/handler.ts, check for
 * check, and they are the boring ones that keep an account recoverable:
 *  - you cannot raise your own role, because an admin who can make themselves
 *    an owner is not an admin;
 *  - you CAN lower your own role. Stepping down is not an escalation and
 *    refusing it helps nobody: it means the only way to stop being an owner is
 *    to ask somebody else to do it for you. What actually keeps an account
 *    recoverable is the last-owner rule below, not a blanket ban on touching
 *    your own row;
 *  - only an owner may create another owner;
 *  - you cannot act on somebody whose role outranks yours;
 *  - the last owner cannot be demoted — by anyone, including themselves —
 *    because an org with no owner has no one who can fix it.
 */
export function canAssignRole(input: {
  readonly actorRole: MemberRole;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly currentRole: MemberRole;
  readonly nextRole: MemberRole;
  readonly ownerCount: number;
}): RoleChangeDecision {
  const { actorRole, actorUserId, targetUserId, currentRole, nextRole, ownerCount } = input;
  const isSelf = actorUserId === targetUserId;

  if (!can(actorRole, 'member.role.change')) {
    return { allowed: false, reason: 'Your role cannot change other people’s roles.' };
  }
  if (currentRole === nextRole) {
    return { allowed: false, reason: isSelf ? 'That is already your role.' : 'That is already their role.' };
  }
  // Ranks are a total order over the four roles, so after the equality check
  // above "not lower" is exactly "higher": a promotion.
  if (isSelf && RANK[nextRole] > RANK[currentRole]) {
    return {
      allowed: false,
      reason: 'You cannot give yourself a higher role. Ask another owner or admin.',
    };
  }
  if (RANK[currentRole] > RANK[actorRole]) {
    return { allowed: false, reason: `Only an owner can change an ${currentRole}’s role.` };
  }
  if (nextRole === 'owner' && actorRole !== 'owner') {
    return { allowed: false, reason: 'Only an owner can make someone else an owner.' };
  }
  if (currentRole === 'owner' && ownerCount <= 1) {
    return {
      allowed: false,
      reason: isSelf
        ? 'You are the last owner. Make someone else an owner before you step down.'
        : 'This is the last owner. Make someone else an owner first.',
    };
  }
  return ALLOWED;
}

/**
 * May `actor` take `target` out of the organisation?
 *
 * Leaving is the same argument as stepping down, carried to its end: a member
 * may remove themselves, and the last-owner rule is what stops that emptying
 * the org of anybody who could fix it.
 *
 * The capability check still applies to a self-removal, and deliberately so —
 * `remove_member` in wv-worlds/handler.ts requires the same one. Membership is
 * a write to `wv_member` whichever row it touches, and a viewer who wants out
 * asks an admin.
 */
export function canRemoveMember(input: {
  readonly actorRole: MemberRole;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly targetRole: MemberRole;
  readonly ownerCount: number;
}): RoleChangeDecision {
  const { actorRole, actorUserId, targetUserId, targetRole, ownerCount } = input;
  const isSelf = actorUserId === targetUserId;

  if (!can(actorRole, 'member.remove')) {
    return { allowed: false, reason: 'Your role cannot remove members.' };
  }
  if (RANK[targetRole] > RANK[actorRole]) {
    return { allowed: false, reason: `Only an owner can remove an ${targetRole}.` };
  }
  if (targetRole === 'owner' && ownerCount <= 1) {
    return {
      allowed: false,
      reason: isSelf
        ? 'You are the last owner. Make someone else an owner before you leave.'
        : 'This is the last owner. Make someone else an owner first.',
    };
  }
  return ALLOWED;
}
