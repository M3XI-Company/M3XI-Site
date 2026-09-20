import type { ViewerMode } from '../types.js';
import type { MeasurementOverlay } from '../types.js';
import {
  AGENT_CONTRACT_VERSION, AgentContractError,
} from './contract.js';
import type {
  ActionOutcome, AgentAction, AgentAnswer, AgentEvent, AgentPort, AgentTarget, AgentTurn,
  ViewerContext,
} from './contract.js';

/**
 * The viewer half of the seam.
 *
 * Everything the agent can ask for is a method here, and every method is
 * allowed to say no. The bridge is the place that enforces the two rules the
 * contract file states: the agent never touches the camera directly, and an
 * action the viewer cannot or will not honour comes back as a declined
 * `ActionOutcome` rather than a thrown error or a silent no-op.
 */
export interface ViewerCommands {
  readonly mode: ViewerMode;
  /** Current situation, assembled fresh for each question. */
  context(): ViewerContext;
  /** Walks the nav graph. Resolves false when the target cannot be reached. */
  goTo(target: AgentTarget, opts: { lookAt?: AgentTarget; style?: 'walk' | 'cut'; speedMps?: number }): Promise<boolean>;
  lookAt(target: AgentTarget): boolean;
  viewpoint(nodeId: string): boolean;
  setHighlight(entityIds: readonly string[], label?: string): boolean;
  clearHighlight(): void;
  showMeasurement(overlay: MeasurementOverlay): boolean;
  clearMeasurements(): void;
  openPanel(panel: 'rooms' | 'measure' | 'info' | 'floorplan' | 'text'): boolean;
  emphasiseRooms(roomIds: readonly string[]): boolean;
  /** Spoken to assistive technology. The bridge routes refusals here too. */
  announce(text: string): void;
}

export interface AskResult {
  readonly answer: AgentAnswer;
  readonly outcomes: readonly ActionOutcome[];
}

const MAX_HISTORY = 12;
/** An agent that wants twenty camera moves for one question is malfunctioning. */
const MAX_ACTIONS = 8;

export class AgentBridge {
  private history: AgentTurn[] = [];
  private inFlight: AbortController | undefined;

  constructor(
    private readonly port: AgentPort,
    private readonly commands: ViewerCommands,
  ) {
    if (port.contractVersion !== AGENT_CONTRACT_VERSION) {
      throw new AgentContractError(port.contractVersion as number);
    }
  }

  get capabilities() { return this.port.capabilities; }
  get transcript(): readonly AgentTurn[] { return this.history; }

  /** Abandons any question still running; the visitor moved on. */
  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  async ask(text: string, onEvent?: (e: AgentEvent) => void): Promise<AskResult> {
    this.cancel();
    const controller = new AbortController();
    this.inFlight = controller;

    const question = {
      text,
      context: this.commands.context(),
      history: [...this.history],
      signal: controller.signal,
    };
    this.push({ role: 'user', text, at: new Date().toISOString() });

    let answer: AgentAnswer;
    try {
      answer = this.port.capabilities.canStream && this.port.askStreaming && onEvent
        ? await this.port.askStreaming(question, onEvent)
        : await this.port.ask(question);
    } catch (err) {
      if (controller.signal.aborted) throw err;
      // A failed agent must not take the property with it. The viewer stays
      // usable and says what happened in words the visitor can act on.
      const fallback: AgentAnswer = {
        text: 'I could not answer that just now. Everything else in the tour still works, and the written tour has the room dimensions.',
        citations: [],
        actions: [{ kind: 'ui.open', panel: 'text' }],
        refusal: { scope: 'knowledge', text: String((err as Error)?.message ?? err) },
      };
      this.push({ role: 'agent', text: fallback.text, at: new Date().toISOString() });
      return { answer: fallback, outcomes: await this.apply(fallback.actions) };
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }

    this.push({ role: 'agent', text: answer.text, at: new Date().toISOString() });
    const outcomes = await this.apply(answer.actions);
    this.commands.announce(answer.speech ?? answer.text);
    return { answer, outcomes };
  }

  /**
   * Actions run in order and a declined one does not stop the rest: "walk to
   * the bathroom and highlight the bath" should still highlight the bath if
   * the walk is impossible, because the highlight is what makes the refusal
   * make sense.
   */
  private async apply(actions: readonly AgentAction[]): Promise<ActionOutcome[]> {
    const out: ActionOutcome[] = [];
    for (const action of actions.slice(0, MAX_ACTIONS)) {
      out.push(await this.applyOne(action));
    }
    if (actions.length > MAX_ACTIONS) {
      for (const action of actions.slice(MAX_ACTIONS)) {
        out.push({ action, applied: false, declined: `more than ${MAX_ACTIONS} actions in one answer` });
      }
    }
    return out;
  }

  private async applyOne(action: AgentAction): Promise<ActionOutcome> {
    switch (action.kind) {
      case 'camera.goTo': {
        const ok = await this.commands.goTo(action.target, {
          ...(action.lookAt ? { lookAt: action.lookAt } : {}),
          ...(action.style ? { style: action.style } : {}),
          ...(action.speedMps ? { speedMps: action.speedMps } : {}),
        });
        return ok
          ? { action, applied: true }
          : { action, applied: false, declined: 'no walkable route to that place' };
      }
      case 'camera.lookAt':
        return this.commands.lookAt(action.target)
          ? { action, applied: true }
          : { action, applied: false, declined: 'unknown target' };
      case 'camera.viewpoint':
        return this.commands.viewpoint(action.nodeId)
          ? { action, applied: true }
          : { action, applied: false, declined: 'unknown viewpoint' };
      case 'highlight.set':
        return this.commands.setHighlight(action.entityIds, action.label)
          ? { action, applied: true }
          : { action, applied: false, declined: 'no such entities' };
      case 'highlight.clear':
        this.commands.clearHighlight();
        return { action, applied: true };
      case 'measure.show':
        return this.commands.showMeasurement(action.overlay)
          ? { action, applied: true }
          : { action, applied: false, declined: 'overlay had no drawable geometry' };
      case 'measure.clear':
        this.commands.clearMeasurements();
        return { action, applied: true };
      case 'ui.open':
        return this.commands.openPanel(action.panel)
          ? { action, applied: true }
          : { action, applied: false, declined: 'panel not available in this mode' };
      case 'floorplan.emphasise':
        return this.commands.emphasiseRooms(action.roomIds)
          ? { action, applied: true }
          : { action, applied: false, declined: 'no such rooms' };
      default: {
        // An agent built against a newer contract may send a kind this viewer
        // has never heard of. Ignoring it loudly beats crashing the tour.
        const unknown = action as { kind: string };
        return { action, applied: false, declined: `unsupported action '${unknown.kind}'` };
      }
    }
  }

  private push(turn: AgentTurn): void {
    this.history.push(turn);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
  }

  dispose(): void {
    this.cancel();
    this.port.dispose?.();
    this.history = [];
  }
}
