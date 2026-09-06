import type { AgentTurn } from "@minpeter/pss-runtime";
import { Fsm } from "@minpeter/pss-runtime/fsm";

/**
 * Explicit state machines for the interactive TUI session.
 *
 * Two orthogonal concerns that were previously tracked with scattered closure
 * variables (`shouldExit`, `inputResolver`, `activeRun`,
 * `activeTurnInterrupted`) are modeled as small finite state machines:
 *
 * - prompt: who currently owns the editor submit path
 *   `idle -> awaiting -> processing -> awaiting -> ... -> closed`
 * - turn: whether an agent turn is running (may overlap any prompt state,
 *   because steering keeps the editor usable while a turn streams)
 *   `none -> active(run, interrupted) -> none`
 */

export type PromptState =
  | { readonly tag: "idle" }
  | {
      readonly tag: "awaiting";
      readonly resolve: (value: string | null) => void;
    }
  | { readonly tag: "processing" }
  | { readonly tag: "closed" };

export type TurnState =
  | { readonly tag: "none" }
  | {
      readonly tag: "active";
      readonly interrupted: boolean;
      readonly run: AgentTurn;
    };

function createPromptMachine(): Fsm<PromptState> {
  return new Fsm<PromptState>({
    initial: { tag: "idle" },
    name: "tui-session-prompt",
    transitions: {
      idle: ["awaiting", "closed"],
      awaiting: ["processing", "closed"],
      processing: ["awaiting", "closed"],
      closed: [],
    },
  });
}

function createTurnMachine(): Fsm<TurnState> {
  return new Fsm<TurnState>({
    initial: { tag: "none" },
    name: "tui-session-turn",
    transitions: {
      none: ["active"],
      // `active -> active` covers steering replacement runs and the
      // per-run `interrupted` flag update.
      active: ["active", "none"],
    },
  });
}

export class TuiSessionMachine {
  readonly #prompt = createPromptMachine();
  readonly #turn = createTurnMachine();
  readonly #pendingTurns = new Map<AgentTurn, boolean>();

  get promptState(): PromptState {
    return this.#prompt.state;
  }

  get turnState(): TurnState {
    return this.#turn.state;
  }

  /** Whether the session has been closed (exit requested or loop ended). */
  get closed(): boolean {
    return this.#prompt.state.tag === "closed";
  }

  /** The currently streaming turn, if any. */
  get activeTurn(): Extract<TurnState, { tag: "active" }> | undefined {
    const turn = this.#turn.state;
    return turn.tag === "active" ? turn : undefined;
  }

  // -------------------------------------------------------------------------
  // Prompt transitions
  // -------------------------------------------------------------------------

  /**
   * Start waiting for editor input. Resolves immediately with `null` when the
   * session is already closed so the main loop can exit.
   */
  awaitInput(resolve: (value: string | null) => void): void {
    if (this.#prompt.state.tag === "closed") {
      resolve(null);
      return;
    }
    this.#prompt.to({ tag: "awaiting", resolve });
  }

  /**
   * Hand submitted text to the pending input waiter. Returns `false` when
   * nothing is waiting (e.g. a command is still processing), matching the
   * previous "ignore submit without resolver" behavior.
   */
  submitInput(text: string): boolean {
    const prompt = this.#prompt.state;
    if (prompt.tag !== "awaiting") {
      return false;
    }
    this.#prompt.to({ tag: "processing" });
    prompt.resolve(text);
    return true;
  }

  /**
   * Close the session. Idempotent; resolves a pending input waiter with
   * `null` so the main loop unblocks.
   */
  close(): void {
    const prompt = this.#prompt.state;
    if (prompt.tag === "closed") {
      return;
    }
    const pending = prompt.tag === "awaiting" ? prompt.resolve : undefined;
    this.#prompt.to({ tag: "closed" });
    pending?.(null);
  }

  // -------------------------------------------------------------------------
  // Turn transitions
  // -------------------------------------------------------------------------

  /**
   * Mark `run` as the streaming turn. Steering may replace the active run
   * with a newly started one, so `active -> active` is a legal transition.
   */
  beginTurn(run: AgentTurn): void {
    this.#pendingTurns.set(run, false);
    this.#turn.to({ tag: "active", interrupted: false, run });
  }

  /**
   * Request interruption of the active turn. Returns the interrupted run, or
   * `undefined` when no turn is active.
   */
  markInterrupted(): AgentTurn | undefined {
    const turn = this.#turn.state;
    if (turn.tag !== "active") {
      return;
    }
    // thread.interrupt() cancels the physical thread, including a predecessor
    // whose steering acknowledgement has already finished consuming events.
    for (const run of this.#pendingTurns.keys()) {
      this.#pendingTurns.set(run, true);
    }
    this.#turn.to({ ...turn, interrupted: true });
    return turn.run;
  }

  /** Whether this still-pending run was interrupted. */
  wasInterrupted(run: AgentTurn): boolean {
    return this.#pendingTurns.get(run) === true;
  }

  /**
   * Release the turn slot when `run` finishes. Guarded by run identity: a
   * steering-started replacement run must not be cleared by the finishing
   * predecessor.
   */
  endTurn(run: AgentTurn): void {
    this.#pendingTurns.delete(run);
    const turn = this.#turn.state;
    if (turn.tag === "active" && turn.run === run) {
      const pending = [...this.#pendingTurns].at(-1);
      this.#turn.to(
        pending === undefined
          ? { tag: "none" }
          : { tag: "active", run: pending[0], interrupted: pending[1] }
      );
    }
  }
}
