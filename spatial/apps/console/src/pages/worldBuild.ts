/**
 * The build screen: thirteen stages, their state, their GPU seconds, the
 * wall-clock time each one took and the cost accruing behind them.
 *
 * The thing this screen refuses to do is imply progress that is not happening.
 * When a stage fails, the stages that depend on it are drawn as blocked, with
 * a word that says so, because `wv_claim_job` will never hand them out — a
 * dependency of theirs has not succeeded and never will without intervention.
 * A progress bar that keeps ticking past a failure costs an operator an hour
 * before they look at the log.
 *
 * "Depend on it" is meant literally: the edges come from `depends_on` on the
 * job rows, so a stage on a branch that is still claimable is not drawn as
 * doomed just because it sits lower in the list.
 */

import {
  buildView, can, confirm, duration, el, facts, findAction, gpuSeconds as fmtGpu, money, note,
  planResume, planRestart, spend, stageMeta, toast, usdToGbp, worldActions,
  type BuildView, type StageView, type WorldDetail,
} from '@m3xi/console-ui';
import type { PageContext } from './context.js';
import { section } from '../shell.js';

/** How often the build page re-reads the job rows while work is in flight. */
const POLL_MS = 5_000;

export interface BuildTab {
  readonly root: HTMLElement;
  destroy(): void;
}

export function renderBuild(ctx: PageContext, detail: WorldDetail, onChanged: () => void): BuildTab {
  const root = el('div', {});
  let timer: number | null = null;
  let current = detail;

  const draw = (): void => {
    const view = buildView(current.jobs);
    const sections: (HTMLElement | null)[] = [
      captureSection(current),
      summarySection(view),
      failureSection(ctx, current, view, onChanged),
      stagesSection(view),
      actionsSection(ctx, current, view, onChanged),
    ];
    root.replaceChildren(...sections.filter((s): s is HTMLElement => s !== null));

    const live = view.state === 'running' || view.state === 'queued';
    if (live && timer === null) {
      timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    } else if (!live && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      current = await ctx.api.getWorld(current.world.id);
      draw();
    } catch {
      // A transient read failure while polling is not worth interrupting for;
      // the next tick will either succeed or the operator will reload.
    }
  };

  draw();
  return {
    root,
    destroy(): void {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },
  };
}

function captureSection(detail: WorldDetail): HTMLElement {
  if (detail.captures.length === 0) {
    return section('Capture', undefined,
      note('info', 'No capture uploaded yet',
        'A build starts from an uploaded capture. Record it in the capture app and it will appear here.'),
    );
  }
  const capture = detail.captures[0]!;
  const coverage = capture.coverage as Record<string, unknown>;
  return section('Capture', 'What the build is being made from.',
    facts([
      ['Kind', capture.kind],
      ['Duration', capture.duration_s === null ? '—' : `${capture.duration_s.toFixed(1)} s`],
      ['Frames', capture.frame_count === null ? '—' : String(capture.frame_count)],
      ['Size', capture.bytes === null ? '—' : `${(capture.bytes / 1e6).toFixed(1)} MB`],
      ['Rooms walked', typeof coverage['walkedRooms'] === 'number' ? String(coverage['walkedRooms']) : '—'],
      ['Rejected for blur', typeof coverage['blurRejected'] === 'number' ? `${(coverage['blurRejected'] * 100).toFixed(0)}%` : '—'],
      ['Reflective surfaces found', typeof coverage['reflectiveSurfaces'] === 'number' ? String(coverage['reflectiveSurfaces']) : '—'],
    ]),
  );
}

function summarySection(view: BuildView): HTMLElement {
  const gbp = usdToGbp(view.costUsd);
  const pct = Math.round(view.progress * 100);

  const bar = el('div', {
    class: 'c-meter-track',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': String(view.total),
    'aria-valuenow': String(view.completed),
    'aria-valuetext': `${view.completed} of ${view.total} stages complete. Build ${view.state.replace('_', ' ')}.`,
    'aria-label': 'Build progress',
    style: 'max-width:420px',
  }, el('div', { class: 'c-meter-fill', style: `width:${pct}%` }));

  return section('This build', undefined,
    el('div', { class: 'c-grid', style: 'margin-bottom:14px' },
      el('div', { class: 'c-card' },
        el('h3', {}, 'State'),
        el('div', { class: 'c-stat' }, view.state === 'not_started' ? 'Not started' : view.state.replace('_', ' ')),
        el('p', { class: 'c-stat-sub' }, view.activeStage ? `Running ${stageMeta(view.activeStage).label.toLowerCase()}` : `${view.completed} of ${view.total} stages complete`),
      ),
      el('div', { class: 'c-card' },
        el('h3', {}, 'GPU time'),
        el('div', { class: 'c-stat' }, fmtGpu(view.gpuSeconds)),
        el('p', { class: 'c-stat-sub' }, 'Accrued across every stage that has reported.'),
      ),
      // Wall-clock and GPU time are different numbers and the gap between them
      // is the interesting one: it is queueing, uploads and pods starting, not
      // work. An operator chasing "why did this take two hours" is asking
      // about this figure, not the one above it.
      el('div', { class: 'c-card' },
        el('h3', {}, 'Wall clock'),
        el('div', { class: 'c-stat' }, view.elapsedS === null ? '—' : duration(view.elapsedS * 1000)),
        el('p', { class: 'c-stat-sub' }, view.elapsedS === null
          ? (view.startedAt === null
            ? 'No stage has started yet, so there is nothing to time.'
            : 'Still running. This reads once every stage has stopped.')
          : 'From the first stage starting to the last one finishing, waiting included.'),
      ),
      el('div', { class: 'c-card' },
        el('h3', {}, 'Cost so far'),
        el('div', { class: 'c-stat' }, spend(gbp)),
        el('p', { class: 'c-stat-sub' }, `${money(gbp)} at the rate the spend cap is enforced at. Charged whether or not the build finishes.`),
      ),
    ),
    bar,
  );
}

function failureSection(
  ctx: PageContext,
  detail: WorldDetail,
  view: BuildView,
  onChanged: () => void,
): HTMLElement | null {
  if (!view.failure) return null;
  const plan = planResume(view);
  const restart = planRestart(view);

  const actions = el('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' });

  if (can(ctx.role, 'build.resume')) {
    const resumeButton = el('button', {
      class: 'c-btn c-btn--primary',
      type: 'button',
      disabled: !view.failure.canResume,
      title: view.failure.resumeBlockedReason ?? '',
      onclick: async () => {
        const ok = await confirm({
          title: 'Resume this build?',
          body: [
            plan?.summary ?? 'The build will restart at the failed stage.',
            `Nothing already computed is thrown away: ${fmtGpu(plan?.preservedGpuSeconds ?? 0)} of GPU time is kept.`,
          ],
          confirmLabel: 'Resume',
        });
        if (!ok) return;
        try {
          await ctx.api.resumeBuild(detail.world.id);
          toast('Resumed from the failed stage.', 'ok');
          onChanged();
        } catch (err) {
          // `resume_build` refuses with a sentence — the attempts are spent, a
          // worker still holds the lease, the row was taken mid-request — and
          // each one tells the operator something different about what to do
          // next. It is shown as written rather than summarised.
          toast(err instanceof Error ? err.message : String(err), 'bad');
        }
      },
    }, 'Resume from this stage');
    actions.appendChild(resumeButton);
  }

  if (can(ctx.role, 'build.start')) {
    actions.appendChild(el('button', {
      class: 'c-btn c-btn--danger',
      type: 'button',
      onclick: async () => {
        const ok = await confirm({
          title: 'Start the whole build again?',
          body: [
            `This runs all ${restart.stages} stages from the beginning and pays for them again.`,
            `${fmtGpu(restart.discardedGpuSeconds)} of GPU time already spent on this world is discarded.`,
            'It also counts as another build against this month’s cap.',
          ],
          confirmLabel: 'Start again',
          danger: true,
        });
        if (!ok) return;
        try {
          await ctx.api.requestBuild(detail.world.id);
          toast('A fresh build has been queued.', 'ok');
          onChanged();
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'bad');
        }
      },
    }, 'Start again from scratch'));
  }

  const waiting = view.failure.resumes.length - 1;

  return section('What failed', undefined,
    note('bad', `${view.failure.label} failed on attempt ${view.failure.attempt} of 3`,
      el('pre', { class: 'c-code', tabindex: '0', 'aria-label': 'Worker error' }, view.failure.error),
      el('p', {}, view.failure.canResume
        ? `${view.failure.attemptsRemaining} ${view.failure.attemptsRemaining === 1 ? 'attempt' : 'attempts'} left before the queue gives up on this stage.`
        : view.failure.resumeBlockedReason ?? ''),
      el('p', {}, `${view.failure.preserved.length} stages already succeeded and would be kept: ${view.failure.preserved.join(', ') || 'none'}.`),
      el('p', {}, waiting === 0
        ? 'Nothing else in the pipeline is waiting on it.'
        : `${waiting} ${waiting === 1 ? 'stage is' : 'stages are'} waiting on it and cannot be claimed until it succeeds: ${view.failure.resumes.slice(1).join(', ')}.`),
    ),
    actions,
  );
}

function stagesSection(view: BuildView): HTMLElement {
  if (view.stages.length === 0) {
    return section('Stages', undefined,
      note('info', 'This world has never been built',
        'Starting a build queues thirteen stages, wired as a dependency graph: a stage runs only once everything it waits for has succeeded, so a failure stops everything downstream of it.'),
    );
  }

  const list = el('ol', { class: 'c-dag', style: 'list-style:none;margin:0;padding:0' });
  for (const stage of view.stages) list.appendChild(stageRow(stage));

  // The console will not draw a graph it does not have. Inferring the edges
  // from the order the rows came back would look identical to the real thing
  // and would decide which stages are shown as permanently blocked.
  const missing = view.edgesMissing
    ? note('warn', 'The dependency edges are missing from this response',
      'None of these job rows carried depends_on, so which stages wait for which is unknown here and no stage is marked blocked. The order below is the order they were queued in, which is not the same claim. Reload; if it persists, get_world has stopped projecting the column.')
    : null;

  return section('Stages',
    'Each stage waits for the ones it depends on. A stage marked blocked cannot be claimed until the failure upstream of it is dealt with.',
    missing,
    list);
}

function stageRow(stage: StageView): HTMLElement {
  const tone = stage.state === 'succeeded' ? 'ok'
    : stage.state === 'failed' ? 'bad'
      : stage.state === 'running' || stage.state === 'leased' ? 'info'
        : stage.state === 'blocked' ? 'warn' : 'muted';

  const row = el('li', { class: `c-stage c-stage--${stage.state}` },
    el('span', { class: 'c-stage-n', 'aria-hidden': 'true' }, String(stage.index + 1)),
    el('div', { style: 'min-width:0' },
      el('div', { class: 'c-stage-name' }, stage.label),
      el('div', { class: 'c-stage-desc' }, stage.description),
    ),
    el('span', { class: `c-pill c-pill--${tone}` }, stateWord(stage)),
    // Wall clock from started_at to finished_at. On a stage the reaper
    // requeued this spans the attempt that died as well, which is why the
    // label says so rather than presenting it as the cost of the work.
    el('span', {
      class: 'c-stage-num',
      title: stage.elapsedS === null
        ? 'This stage has not both started and finished.'
        : stage.attempt > 1
          ? `Wall clock since this stage first started, across ${stage.attempt} attempts.`
          : 'Wall clock, start to finish.',
    }, stage.elapsedS === null ? '—' : duration(stage.elapsedS * 1000)),
    el('span', { class: 'c-stage-num' }, stage.gpuSeconds === null ? '—' : fmtGpu(stage.gpuSeconds)),
    el('span', { class: 'c-stage-num' }, stage.costUsd === null ? '—' : spend(usdToGbp(stage.costUsd))),
  );

  if (stage.error) {
    row.appendChild(el('pre', { class: 'c-stage-error', tabindex: '0', 'aria-label': `${stage.label} error` }, stage.error));
  }
  return row;
}

function stateWord(stage: StageView): string {
  switch (stage.state) {
    case 'blocked': return 'blocked';
    case 'leased': return 'starting';
    case 'queued': return 'waiting';
    default: return stage.state;
  }
}

function actionsSection(
  ctx: PageContext, detail: WorldDetail, view: BuildView, onChanged: () => void,
): HTMLElement | null {
  if (view.failure) return null;

  const actions = worldActions({
    role: ctx.role,
    worldStatus: detail.world.status,
    gate: { state: 'unassessed', publishable: false, reason: '', route: 'build', failingChecks: [], marginalChecks: [], score: null, alreadyPublished: false },
    build: view,
    slug: detail.world.slug,
    hasExportableAssets: detail.assetCount > 0,
    buildInFlight: false,
  });
  const start = findAction(actions, 'build.start');

  return section('Start a build', undefined,
    el('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:flex-start' },
      el('button', {
        class: 'c-btn c-btn--primary',
        type: 'button',
        disabled: !start.enabled,
        title: start.enabled ? '' : start.reason,
        onclick: async () => {
          if (view.total > 0) {
            const ok = await confirm({
              title: 'Queue another build?',
              body: [
                'This queues all thirteen stages again and is charged again. It also counts against this month’s build cap.',
                'If a previous build failed part-way, resuming from the failed stage is cheaper.',
              ],
              confirmLabel: 'Queue the build',
            });
            if (!ok) return;
          }
          try {
            await ctx.api.requestBuild(detail.world.id);
            toast('Build queued.', 'ok');
            onChanged();
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'bad');
          }
        },
      }, view.total === 0 ? 'Start the build' : 'Queue another build'),
      start.enabled ? null : el('span', { class: 'c-hint' }, start.reason),
    ),
  );
}
