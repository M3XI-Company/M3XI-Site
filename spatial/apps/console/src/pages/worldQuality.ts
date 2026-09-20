/**
 * The quality gate, rendered honestly.
 *
 * Every check, its measured value, its threshold, which direction is better,
 * and whether it passed. No summary score standing in for the detail, no
 * green tick over a report with a failing check inside it, and no wording
 * anywhere that implies a world is publishable when the verdict is not `pass`.
 *
 * The score is shown, but second. A single number is how a quality gate stops
 * being read.
 */

import {
  CHECK_LABELS, checkMargin, el, evaluateGate, humanise, inlineBar, note, parseQualityRow,
  percent, table, verdictPill, type GateDecision, type WorldDetail,
} from '@m3xi/console-ui';
import type { QualityCheck } from '@m3xi/world-core';
import type { PageContext } from './context.js';
import { section } from '../shell.js';

export function renderQuality(ctx: PageContext, detail: WorldDetail): HTMLElement {
  const parsed = parseQualityRow(detail.quality as never);
  const gate = evaluateGate({
    report: parsed.report,
    worldStatus: detail.world.status,
    role: ctx.role,
    lastCorrectionAt: detail.lastCorrectionAt,
  });

  const root = el('div', {});
  root.appendChild(verdictPanel(gate, detail));

  if (!parsed.report) {
    root.appendChild(section('Checks', undefined,
      note('info', 'Nothing to show yet',
        'The quality stage has not written a report for this world. Until it does, this world cannot be published — a world that was never assessed is not the same as one that passed.')));
    return root;
  }

  if (parsed.discarded > 0) {
    root.appendChild(note('warn', 'Part of this report could not be read',
      `${parsed.discarded} ${parsed.discarded === 1 ? 'check was' : 'checks were'} not shaped like a check and have been left out. The verdict below is still the pipeline's.`));
  }

  root.appendChild(checksTable(parsed.report.checks));
  root.appendChild(historySection(detail));
  return root;
}

function verdictPanel(gate: GateDecision, detail: WorldDetail): HTMLElement {
  const tone = gate.state === 'pass' ? 'ok' : gate.state === 'fail' ? 'bad' : 'warn';
  const routeLine = {
    build: 'Start a build. There is nothing to assess yet.',
    requality: 'Re-run the quality stage over the corrected world.',
    correct: 'Open the correction editor, fix what is wrong, then re-run quality.',
    recapture: 'Recapture the property. A failed world cannot be corrected into a pass — the capture itself is not good enough.',
    publish: 'This world can be published.',
    none: 'Somebody with an operator, admin or owner role can publish it.',
  }[gate.route];

  return section('Verdict', undefined,
    el('div', { style: 'display:flex;gap:12px;align-items:center;margin-bottom:10px;flex-wrap:wrap' },
      verdictPill(gate.state === 'unassessed' ? null : (detail.quality?.['verdict'] as string ?? null)),
      gate.score === null
        ? null
        : el('span', { class: 'c-num', style: 'font-size:15px' }, `score ${gate.score.toFixed(3)}`),
      el('span', { class: 'c-hint' }, `${gate.failingChecks.length} failing, ${gate.marginalChecks.length} marginal`),
    ),
    note(tone, null, gate.reason, el('p', {}, routeLine)),
  );
}

function checksTable(checks: readonly QualityCheck[]): HTMLElement {
  return section('Every check',
    'The measured value, the threshold it had to meet, and which way is better. Nothing here is rounded away.',
    table<QualityCheck>({
      caption: `${checks.length} checks, ${checks.filter((c) => !c.pass).length} failing`,
      columns: [
        {
          key: 'name', header: 'Check',
          render: (c) => el('div', {},
            el('div', { style: 'font-weight:600' }, CHECK_LABELS[c.name]?.label ?? humanise(c.name)),
            el('div', { class: 'c-hint' }, CHECK_LABELS[c.name]?.meaning ?? c.name),
            c.detail ? el('div', { class: 'c-hint', style: 'color:var(--warn-ink)' }, c.detail) : null,
          ),
        },
        { key: 'value', header: 'Value', numeric: true, render: (c) => formatValue(c.value) },
        {
          key: 'threshold', header: 'Threshold', numeric: true,
          render: (c) => `${c.higherIsBetter ? '≥ ' : '≤ '}${formatValue(c.threshold)}`,
        },
        {
          key: 'margin', header: 'Margin', numeric: true,
          render: (c) => {
            const margin = checkMargin(c);
            if (margin === null) return '—';
            return el('span', { class: 'c-num' }, `${margin > 0 ? '+' : ''}${percent(margin, 1)}`);
          },
        },
        {
          key: 'bar', header: 'Against threshold',
          render: (c) => {
            // The bar shows value relative to threshold, clamped at twice it,
            // so "passed by a hair" and "passed comfortably" look different.
            const ratio = c.threshold === 0 ? 0
              : c.higherIsBetter ? c.value / c.threshold : c.threshold === 0 ? 0 : 1 - (c.value - c.threshold) / c.threshold;
            return inlineBar(Math.max(0, Math.min(1, ratio / 1.5)), formatValue(c.value));
          },
        },
        {
          key: 'pass', header: 'Verdict',
          render: (c) => el('span', { class: `c-pill c-pill--${c.pass ? 'ok' : 'bad'}` }, c.pass ? 'pass' : 'fail'),
        },
      ],
      rows: [...checks].sort((a, b) => Number(a.pass) - Number(b.pass)),
      rowKey: (c) => c.name,
      empty: 'The report contains no checks, which is itself a reason not to publish.',
    }),
  );
}

function historySection(detail: WorldDetail): HTMLElement {
  const rows = detail.qualityHistory.map((row, i) => {
    const parsed = parseQualityRow(row as never);
    return {
      id: String(i),
      verdict: parsed.report?.verdict ?? 'unreadable',
      score: parsed.report?.score ?? null,
      createdAt: parsed.report?.createdAt ?? '',
      failing: parsed.report?.checks.filter((c) => !c.pass).length ?? 0,
    };
  });

  if (rows.length <= 1) {
    return section('Assessment history',
      'A world is assessed every time the quality stage runs. Only one run so far.');
  }

  return section('Assessment history',
    'Every run of the quality stage against this world version, newest first.',
    table({
      caption: `${rows.length} assessments`,
      columns: [
        { key: 'verdict', header: 'Verdict', render: (r: typeof rows[number]) => verdictPill(r.verdict) },
        { key: 'score', header: 'Score', numeric: true, render: (r) => (r.score === null ? '—' : r.score.toFixed(3)) },
        { key: 'failing', header: 'Failing checks', numeric: true, render: (r) => String(r.failing) },
        { key: 'at', header: 'Run at', numeric: true, render: (r) => new Date(r.createdAt).toLocaleString('en-GB') },
      ],
      rows,
      rowKey: (r) => r.id,
    }),
  );
}

/** Fractions read as percentages; anything else keeps three decimals. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 0 && value <= 1) return `${(value * 100).toFixed(1)}%`;
  return value.toFixed(3);
}
