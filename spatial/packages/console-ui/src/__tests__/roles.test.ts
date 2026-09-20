/**
 * Role-based access, at the layer the console actually renders from.
 *
 * These assert on the view models in `logic/actions.ts` rather than on
 * rendered DOM, because that is where the decision is made — the renderer only
 * draws what these produce. The two failures that matter are both covered: an
 * action enabled for somebody who may not perform it, and an action disabled
 * with no reason attached.
 */

import { describe, expect, it } from 'vitest';
import {
  MEMBER_ROLES, can, canAssignRole, canRemoveMember, capabilitiesFor, type MemberRole,
} from '../logic/roles.js';
import { findAction, navigationFor, portfolioActions, worldActions } from '../logic/actions.js';
import { evaluateGate } from '../logic/publishGate.js';
import { buildView } from '../logic/jobs.js';
import type { QualityReport } from '@m3xi/world-core';

const PASSING: QualityReport = {
  checks: [{ name: 'scale_agreement', value: 0.99, threshold: 0.95, higherIsBetter: true, pass: true }],
  score: 0.97,
  verdict: 'pass',
  createdAt: '2026-09-01T10:00:00.000Z',
};

function contextFor(role: MemberRole | null, worldStatus = 'review') {
  return {
    role,
    worldStatus,
    gate: evaluateGate({ report: PASSING, worldStatus, role }),
    build: buildView([
      { id: 'j1', stage: 'ingest', status: 'succeeded', queued_at: '2026-09-01T09:00:00Z' },
      { id: 'j2', stage: 'quality', status: 'succeeded', queued_at: '2026-09-01T09:05:00Z' },
    ]),
    slug: 'two-bed-flat',
    hasExportableAssets: true,
    buildInFlight: false,
  };
}

/** The same context over a build whose `splat` stage failed on `attempt`. */
function failedBuildContext(role: MemberRole | null, attempt: number) {
  return {
    ...contextFor(role),
    build: buildView([
      { id: 'j1', stage: 'ingest', status: 'succeeded', attempt: 1, queued_at: '2026-09-01T09:00:00Z', depends_on: [] },
      {
        id: 'j2', stage: 'splat', status: 'failed', attempt, error: 'CUDA out of memory',
        queued_at: '2026-09-01T09:05:00Z', depends_on: ['j1'],
      },
      { id: 'j3', stage: 'quality', status: 'queued', attempt: 0, queued_at: '2026-09-01T09:06:00Z', depends_on: ['j2'] },
    ]),
  };
}

describe('capability matrix', () => {
  it('gives a viewer reads and nothing else', () => {
    expect(can('viewer', 'analytics.read')).toBe(true);
    expect(can('viewer', 'lead.read')).toBe(true);
    expect(can('viewer', 'export.download')).toBe(true);
    expect(can('viewer', 'world.publish')).toBe(false);
    expect(can('viewer', 'build.start')).toBe(false);
    expect(can('viewer', 'correction.apply')).toBe(false);
    expect(can('viewer', 'export.create')).toBe(false);
  });

  it('lets an operator run a property end to end but not the account', () => {
    expect(can('operator', 'build.start')).toBe(true);
    expect(can('operator', 'world.publish')).toBe(true);
    expect(can('operator', 'correction.apply')).toBe(true);
    expect(can('operator', 'member.invite')).toBe(false);
    expect(can('operator', 'billing.manage')).toBe(false);
    expect(can('operator', 'org.settings')).toBe(false);
    expect(can('operator', 'property.archive')).toBe(false);
  });

  it('gives an admin everything except ending the organisation', () => {
    expect(can('admin', 'member.remove')).toBe(true);
    expect(can('admin', 'billing.manage')).toBe(true);
    expect(can('admin', 'org.delete')).toBe(false);
    expect(can('owner', 'org.delete')).toBe(true);
  });

  it('nests the roles: each one is a superset of the one below', () => {
    const order: MemberRole[] = ['viewer', 'operator', 'admin', 'owner'];
    for (let i = 1; i < order.length; i += 1) {
      const lower = capabilitiesFor(order[i - 1]!);
      const higher = capabilitiesFor(order[i]!);
      for (const capability of lower) expect(higher).toContain(capability);
    }
  });

  it('treats a missing role as no access at all', () => {
    expect(can(null, 'analytics.read')).toBe(false);
    expect(can(undefined, 'world.publish')).toBe(false);
  });
});

describe('world actions', () => {
  it('never enables publish for a viewer, even on a passing world', () => {
    const publish = findAction(worldActions(contextFor('viewer')), 'world.publish');
    expect(publish.enabled).toBe(false);
    expect(publish.visible).toBe(true);
    expect(publish.reason).toMatch(/role/i);
  });

  it('enables publish for an operator on a passing world', () => {
    const publish = findAction(worldActions(contextFor('operator')), 'world.publish');
    expect(publish.enabled).toBe(true);
    expect(publish.emphasis).toBe('primary');
  });

  it('gives every disabled action a reason a person can read', () => {
    for (const role of MEMBER_ROLES) {
      for (const action of worldActions(contextFor(role))) {
        if (!action.enabled && action.visible) {
          expect(action.reason.length, `${role}/${action.id}`).toBeGreaterThan(8);
          expect(action.reason, `${role}/${action.id}`).not.toMatch(/undefined|null|\[object/);
        }
      }
    }
  });

  it('offers a viewer no enabled action at all on a world', () => {
    const enabled = worldActions(contextFor('viewer')).filter((a) => a.enabled);
    expect(enabled).toEqual([]);
  });

  it('blocks a signed-out caller from everything', () => {
    for (const action of worldActions(contextFor(null))) {
      expect(action.enabled).toBe(false);
      expect(action.reason).toMatch(/sign in/i);
    }
  });

  it('marks unpublish as unavailable until the world is live, then available', () => {
    expect(findAction(worldActions(contextFor('operator', 'review')), 'world.unpublish').enabled).toBe(false);
    expect(findAction(worldActions(contextFor('operator', 'published')), 'world.unpublish').enabled).toBe(true);
  });

  it('requires confirmation for anything destructive or expensive', () => {
    const actions = worldActions(contextFor('operator', 'published'));
    expect(findAction(actions, 'world.unpublish').confirms).toBe(true);
    expect(findAction(actions, 'world.publish').confirms).toBe(true);
  });

  it('offers resume on a failed build, because the server implements it', () => {
    // There is no "this deployment cannot resume" state any more: resume_build
    // exists, and the only thing the console can know in advance about a
    // refusal is the attempt ceiling.
    const actions = worldActions(failedBuildContext('operator', 1));
    const resume = findAction(actions, 'build.resume');
    expect(resume.enabled).toBe(true);
    expect(resume.reason).toMatch(/restarts at/i);
  });

  it('blocks resume at the attempt ceiling with the queue’s own reason', () => {
    const resume = findAction(worldActions(failedBuildContext('operator', 3)), 'build.resume');
    expect(resume.enabled).toBe(false);
    expect(resume.reason).toMatch(/all 3 attempts/i);
  });

  it('never offers resume to a viewer', () => {
    expect(findAction(worldActions(failedBuildContext('viewer', 1)), 'build.resume').enabled).toBe(false);
  });
});

describe('portfolio actions', () => {
  it('disables bulk build with nothing selected and says so', () => {
    const action = findAction(portfolioActions({ role: 'operator', selectedCount: 0, buildCapReached: false }), 'build.start');
    expect(action.enabled).toBe(false);
    expect(action.reason).toMatch(/select at least one/i);
  });

  it('disables bulk build at the monthly cap with the cap as the reason', () => {
    const action = findAction(portfolioActions({ role: 'operator', selectedCount: 3, buildCapReached: true }), 'build.start');
    expect(action.enabled).toBe(false);
    expect(action.reason).toMatch(/builds for the month/i);
  });

  it('hides nothing from an operator but keeps archive disabled by role', () => {
    const actions = portfolioActions({ role: 'operator', selectedCount: 2, buildCapReached: false });
    expect(findAction(actions, 'property.archive').enabled).toBe(false);
    expect(findAction(actions, 'build.start').enabled).toBe(true);
  });
});

describe('navigation', () => {
  it('hides the organisation page from an operator and a viewer', () => {
    const forOperator = navigationFor('operator').find((n) => n.id === 'organisation');
    const forAdmin = navigationFor('admin').find((n) => n.id === 'organisation');
    expect(forOperator?.visible).toBe(false);
    expect(forAdmin?.visible).toBe(true);
  });

  it('shows the portfolio to every signed-in role and none to a signed-out caller', () => {
    for (const role of MEMBER_ROLES) {
      expect(navigationFor(role).find((n) => n.id === 'portfolio')?.visible).toBe(true);
    }
    expect(navigationFor(null).every((n) => !n.visible)).toBe(true);
  });
});

describe('role assignment', () => {
  const base = {
    actorRole: 'admin' as MemberRole,
    actorUserId: 'u_admin',
    targetUserId: 'u_other',
    currentRole: 'operator' as MemberRole,
    nextRole: 'viewer' as MemberRole,
    ownerCount: 2,
  };

  it('lets an admin demote an operator', () => {
    expect(canAssignRole(base).allowed).toBe(true);
  });

  it('lets somebody lower their own role', () => {
    // Stepping down is not an escalation, and refusing it means the only way
    // to stop being an admin is to ask somebody else. `set_member_role`
    // permits it; the console has to agree or it offers less than the server.
    const d = canAssignRole({
      ...base, targetUserId: 'u_admin', currentRole: 'admin', nextRole: 'operator',
    });
    expect(d.allowed).toBe(true);
  });

  it('refuses to let anybody raise their own role', () => {
    const d = canAssignRole({
      ...base, actorRole: 'admin', targetUserId: 'u_admin', currentRole: 'admin', nextRole: 'owner',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/higher role/i);
  });

  it('refuses a self-change that is not a change at all', () => {
    const d = canAssignRole({
      ...base, targetUserId: 'u_admin', currentRole: 'admin', nextRole: 'admin',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/already your role/i);
  });

  it('stops the last owner stepping down, which is the rule that matters', () => {
    // The blanket self-ban never protected anything this does not: an org
    // whose only owner demotes themselves has nobody who can undo it.
    const d = canAssignRole({
      actorRole: 'owner', actorUserId: 'u_owner', targetUserId: 'u_owner',
      currentRole: 'owner', nextRole: 'admin', ownerCount: 1,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/last owner/i);
  });

  it('lets an owner step down while another owner remains', () => {
    const d = canAssignRole({
      actorRole: 'owner', actorUserId: 'u_owner', targetUserId: 'u_owner',
      currentRole: 'owner', nextRole: 'admin', ownerCount: 2,
    });
    expect(d.allowed).toBe(true);
  });

  it('lets somebody leave, and stops the last owner leaving', () => {
    expect(canRemoveMember({
      actorRole: 'admin', actorUserId: 'u_admin', targetUserId: 'u_admin',
      targetRole: 'admin', ownerCount: 2,
    }).allowed).toBe(true);

    const lastOwner = canRemoveMember({
      actorRole: 'owner', actorUserId: 'u_owner', targetUserId: 'u_owner',
      targetRole: 'owner', ownerCount: 1,
    });
    expect(lastOwner.allowed).toBe(false);
    expect(lastOwner.reason).toMatch(/last owner/i);
  });

  it('will not let a viewer remove themselves either; membership is still a write', () => {
    // `remove_member` requires the same capability whoever the target is, so
    // offering a viewer a Leave button would offer them a 403.
    expect(canRemoveMember({
      actorRole: 'viewer', actorUserId: 'u_v', targetUserId: 'u_v',
      targetRole: 'viewer', ownerCount: 2,
    }).allowed).toBe(false);
  });

  it('refuses to let an admin touch an owner', () => {
    const d = canAssignRole({ ...base, currentRole: 'owner', nextRole: 'admin' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/only an owner/i);
  });

  it('refuses to let an admin mint an owner', () => {
    const d = canAssignRole({ ...base, nextRole: 'owner' });
    expect(d.allowed).toBe(false);
  });

  it('protects the last owner from demotion and removal', () => {
    const demote = canAssignRole({
      ...base, actorRole: 'owner', actorUserId: 'u_owner2',
      currentRole: 'owner', nextRole: 'admin', ownerCount: 1,
    });
    expect(demote.allowed).toBe(false);
    expect(demote.reason).toMatch(/last owner/i);

    const remove = canRemoveMember({
      actorRole: 'owner', actorUserId: 'u_owner2', targetUserId: 'u_owner',
      targetRole: 'owner', ownerCount: 1,
    });
    expect(remove.allowed).toBe(false);
  });

  it('refuses an operator outright', () => {
    expect(canAssignRole({ ...base, actorRole: 'operator' }).allowed).toBe(false);
    expect(canRemoveMember({
      actorRole: 'viewer', actorUserId: 'a', targetUserId: 'b', targetRole: 'viewer', ownerCount: 2,
    }).allowed).toBe(false);
  });
});
