/**
 * Leads, with the session that produced them.
 *
 * A name and an email on their own are a contact. A name, an email and "they
 * spent four minutes in the kitchen, went back to it twice, asked whether a
 * double bed fits in the second bedroom, and left from the bathroom" is a
 * conversation an agent can open. So every lead expands into its session.
 */

import {
  aggregate, button, can, dateTime, duration, el, note, table, toast,
  type LeadRow, type RoomStat, type SessionRow,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { errorPanel, loading, pageFrame, section } from '../shell.js';

export async function renderLeads(ctx: PageContext): Promise<HTMLElement> {
  const frame = pageFrame({
    title: 'Leads',
    lede: 'Everyone who left their details, and what they were doing when they did.',
  });
  frame.body.appendChild(loading('leads'));

  let leads: readonly LeadRow[];
  try {
    leads = await ctx.api.listLeads();
  } catch (err) {
    frame.body.replaceChildren(errorPanel(err));
    return frame.root;
  }

  frame.actions.replaceChildren(button({
    label: 'Export as CSV',
    disabled: !can(ctx.role, 'lead.export'),
    reason: `Your role (${ctx.role}) cannot export leads.`,
    onClick: () => downloadCsv(leads),
  }));

  const detail = el('div', {});

  frame.body.replaceChildren(
    note('info', null,
      'Lead details are personal data. They are readable by every member of this organisation and by nobody outside it; the public viewer never sees them.'),
    section('Leads', undefined,
      table<LeadRow>({
        caption: `${leads.length} ${leads.length === 1 ? 'lead' : 'leads'}`,
        columns: [
          { key: 'name', header: 'Name', render: (l) => l.name ?? '—' },
          { key: 'email', header: 'Email', render: (l) => (l.email ? el('a', { href: `mailto:${l.email}` }, l.email) : '—') },
          { key: 'phone', header: 'Phone', render: (l) => l.phone ?? '—' },
          { key: 'message', header: 'Message', render: (l) => el('span', { style: 'max-width:42ch;display:inline-block' }, l.message ?? '—') },
          {
            key: 'world', header: 'Property',
            render: (l) => el('a', {
              href: `#/world/${l.world_id}`,
              onclick: (e: Event) => { e.preventDefault(); ctx.navigate(`#/world/${l.world_id}`); },
            }, l.world_id),
          },
          { key: 'created', header: 'Received', numeric: true, render: (l) => dateTime(l.created_at) },
          {
            key: 'session', header: 'Session',
            render: (l) => (l.session_id
              ? button({
                label: 'What they did', small: true,
                onClick: () => void showSession(ctx, l, detail),
              })
              : el('span', { class: 'c-hint' }, 'not recorded')),
          },
        ],
        rows: [...leads],
        rowKey: (l) => l.id,
        empty: 'No leads yet. They appear here the moment a visitor leaves their details in a published walkthrough.',
      }),
    ),
    detail,
  );

  return frame.root;
}

async function showSession(ctx: PageContext, lead: LeadRow, host: HTMLElement): Promise<void> {
  host.replaceChildren(loading('that session'));
  try {
    const [session, events, rooms] = await Promise.all([
      ctx.api.getSession(lead.session_id!),
      ctx.api.listEvents({ worldId: lead.world_id }),
      ctx.api.roomNames(lead.world_id),
    ]);
    const mine = events.filter((e) => e.session_id === lead.session_id);
    const summary = aggregate(mine, rooms);

    host.replaceChildren(section(
      `What ${lead.name ?? 'this visitor'} did`,
      'Reconstructed from the events that session produced.',
      sessionFacts(session, summary.medianSessionMs),
      summary.rooms.length === 0
        ? note('info', null, 'No room-level events were recorded for this session.')
        : table<RoomStat>({
          caption: 'Rooms, longest first',
          columns: [
            { key: 'name', header: 'Room', render: (r) => r.name },
            { key: 'dwell', header: 'Time there', numeric: true, render: (r) => duration(r.dwellMs) },
            { key: 'visits', header: 'Times entered', numeric: true, render: (r) => String(r.visits) },
            { key: 'exit', header: 'Left from', render: (r) => (r.exits > 0 ? 'yes' : '') },
          ],
          rows: summary.rooms,
          rowKey: (r) => r.roomId,
        }),
    ));
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    host.replaceChildren(errorPanel(err));
  }
}

function sessionFacts(session: SessionRow | null, medianMs: number): HTMLElement {
  if (!session) return note('info', null, 'That session row is no longer available.');
  const device = session.device as Record<string, unknown>;
  const started = Date.parse(session.started_at);
  const ended = session.ended_at ? Date.parse(session.ended_at) : NaN;
  const length = Number.isFinite(ended) ? ended - started : medianMs;
  return el('dl', { class: 'c-facts', style: 'margin-bottom:14px' },
    el('dt', {}, 'Arrived'), el('dd', {}, dateTime(session.started_at)),
    el('dt', {}, 'Stayed'), el('dd', {}, duration(length)),
    el('dt', {}, 'Questions asked'), el('dd', {}, String(session.ai_turns)),
    el('dt', {}, 'Came from'), el('dd', { style: 'word-break:break-all' }, session.referrer ?? 'a direct link'),
    el('dt', {}, 'Device'), el('dd', {}, typeof device['platform'] === 'string' ? device['platform'] : 'not recorded'),
  );
}

function downloadCsv(leads: readonly LeadRow[]): void {
  const header = ['name', 'email', 'phone', 'message', 'world_id', 'session_id', 'created_at'];
  const escape = (v: string | null): string => `"${(v ?? '').replace(/"/g, '""')}"`;
  const body = leads.map((l) => [
    l.name, l.email, l.phone, l.message, l.world_id, l.session_id, l.created_at,
  ].map(escape).join(','));
  const csv = [header.join(','), ...body].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `m3xi-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`${leads.length} leads exported.`, 'ok');
}
