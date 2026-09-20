/**
 * Organisation: members, roles and the caps this org is actually enforced at.
 *
 * Role changes are gated in the UI by the same rules `set_member_role` and
 * `remove_member` apply in wv-worlds — nobody raises their own role, only an
 * owner can mint an owner, and the last owner can be neither demoted nor
 * removed — and every refusal says why rather than greying out silently.
 * Stepping yourself down is allowed, because it is not an escalation and the
 * last-owner rule is what actually keeps the account reachable.
 */

import {
  ROLE_DESCRIPTIONS, canAssignRole, canRemoveMember, dateTime, el, money, note, pill, table,
  type MemberRole, type MemberRow,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';

const ROLES: MemberRole[] = ['owner', 'admin', 'operator', 'viewer'];

export async function renderOrganisation(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Organisation',
    lede: `${ctx.membership.org.name} — who can do what, and the limits this account runs under.`,
  });
  frame.body.appendChild(loading('members'));

  let members: readonly MemberRow[];
  try {
    members = await ctx.api.listMembers();
  } catch (err) {
    frame.body.replaceChildren(errorPanel(err));
    return frame.root;
  }

  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const me = ctx.api.session?.userId ?? '';

  // `wv_member.email` is filled from the account behind `user_id` by trigger.
  // A membership can still have none — an account with no address on it has
  // nothing to copy — and those rows show the id instead of a blank space
  // where a person should be. The note appears only when it applies.
  const anonymous = members.filter((m) => m.email === null).length;

  frame.body.replaceChildren(
    section('Members',
      'Roles are enforced by the database, not by this page. What you see here is what the server will also refuse.',
      anonymous === 0
        ? null
        : note('info', `${anonymous} ${anonymous === 1 ? 'member has' : 'members have'} no email address on file`,
          'The address is copied from the account behind the membership, and these accounts have none. They are shown by user id, which is the identity the database actually uses.'),
      table<MemberRow>({
        caption: `${members.length} members, ${ownerCount} ${ownerCount === 1 ? 'owner' : 'owners'}`,
        columns: [
          {
            key: 'who', header: 'Member',
            render: (m) => el('div', {},
              el('div', {}, m.email ?? el('span', { class: 'c-mono' }, m.user_id)),
              m.user_id === me ? el('span', { class: 'c-hint' }, 'this is you') : null),
          },
          { key: 'role', header: 'Role', render: (m) => pill(m.role, m.role === 'viewer' ? 'muted' : 'info') },
          { key: 'since', header: 'Member since', numeric: true, render: (m) => dateTime(m.created_at) },
          {
            key: 'change', header: 'Change role',
            render: (m) => {
              const select = el('select', {
                class: 'c-select', style: 'min-width:120px',
                'aria-label': `Role for ${m.email ?? m.user_id}`,
              });
              for (const role of ROLES) {
                const decision = canAssignRole({
                  actorRole: ctx.role,
                  actorUserId: me,
                  targetUserId: m.user_id,
                  currentRole: m.role,
                  nextRole: role,
                  ownerCount,
                });
                select.appendChild(el('option', {
                  value: role,
                  selected: role === m.role,
                  disabled: role !== m.role && !decision.allowed,
                  title: decision.allowed ? '' : decision.reason,
                }, role));
              }
              select.value = m.role;
              // Every option other than the current one is disabled when the
              // actor may not make that change, and the reason is on the option
              // itself rather than hidden in a tooltip on the control.
              const reason = firstRefusal(ctx.role, me, m, ownerCount);
              return el('div', { style: 'display:flex;flex-direction:column;gap:2px' },
                select,
                reason ? el('span', { class: 'c-hint' }, reason) : null);
            },
          },
          {
            key: 'remove', header: 'Remove',
            render: (m) => {
              const decision = canRemoveMember({
                actorRole: ctx.role, actorUserId: me, targetUserId: m.user_id,
                targetRole: m.role, ownerCount,
              });
              const isSelf = m.user_id === me;
              return el('button', {
                class: 'c-btn c-btn--danger c-btn--small',
                type: 'button',
                disabled: !decision.allowed,
                title: decision.allowed
                  ? (isSelf ? 'Leave this organisation' : 'Remove this member')
                  : decision.reason,
              }, isSelf ? 'Leave' : 'Remove');
            },
          },
        ],
        rows: [...members],
        rowKey: (m) => m.user_id,
      }),
      note('info', 'The membership writes are not wired into this page yet',
        '`wv-worlds` implements invite_member, set_member_role and remove_member — `wv_member` grants a signed-in member only `select`, so they have to be actions — but this page does not call them. The controls above are live about what each role is permitted to do and nothing more; changing a role or removing somebody has to be done elsewhere until they are connected.'),
    ),

    section('Roles',
      'Four roles, nested: each one can do everything the one below it can.',
      table({
        caption: 'What each role can do',
        columns: [
          { key: 'role', header: 'Role', render: (r: { role: MemberRole }) => pill(r.role, 'info') },
          { key: 'what', header: 'What it means', render: (r) => ROLE_DESCRIPTIONS[r.role] },
        ],
        rows: ROLES.map((role) => ({ role })),
        rowKey: (r) => r.role,
      }),
    ),

    section('Enforced limits',
      'These are the values on this organisation’s row, and they are what the database checks before work starts.',
      el('dl', { class: 'c-facts' },
        el('dt', {}, 'Reconstructions a month'), el('dd', {}, String(ctx.membership.org.build_month_cap ?? 'no cap')),
        el('dt', {}, 'Monthly AI ceiling'), el('dd', {}, money(Number(ctx.membership.org.ai_month_cap_gbp ?? 0))),
        el('dt', {}, 'Questions per visitor session'), el('dd', {}, String(ctx.membership.org.ai_turns_per_session ?? 'no limit')),
        el('dt', {}, 'Organisation id'), el('dd', { class: 'c-mono' }, ctx.membership.org.id),
      ),
    ),
  );

  return frame.root;
}

function firstRefusal(actorRole: MemberRole, me: string, member: MemberRow, ownerCount: number): string | null {
  for (const role of ROLES) {
    if (role === member.role) continue;
    const decision = canAssignRole({
      actorRole, actorUserId: me, targetUserId: member.user_id,
      currentRole: member.role, nextRole: role, ownerCount,
    });
    if (decision.allowed) return null;
  }
  const any = canAssignRole({
    actorRole, actorUserId: me, targetUserId: member.user_id,
    currentRole: member.role, nextRole: member.role === 'viewer' ? 'operator' : 'viewer', ownerCount,
  });
  return any.reason || null;
}
