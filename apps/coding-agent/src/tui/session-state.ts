import type { AgentTurn } from "@minpeter/pss-runtime";

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

const PROMPT_TRANSITIONS: Record<PromptState["tag"], PromptState["tag"][]> = {
  idle: ["awaiting", "closed"],
  awaiting: ["processing", "closed"],
  processing: ["awaiting", "closed"],
  closed: [],
};

export class InvalidSessionTransitionError extends Error {
  constructor(machine: string, from: string, to: string) {
    super(
      `[tui-session:${machine}] invalid transition: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`
    );
    this.name = "InvalidSessionTransitionError";
  }
}

export class TuiSessionMachine {
  #prompt: PromptState = { tag: "idle" };
  #turn: TurnState = { tag: "none" };

  get promptState(): PromptState {
    return this.#prompt;
  }

  get turnState(): TurnState {
    return this.#turn;
  }

  /** Whether the session has been closed (exit requested or loop ended). */
  get closed(): boolean {
    return this.#prompt.tag === "closed";
  }

  /** The currently streaming turn, if any. */
  get activeTurn(): Extract<TurnState, { tag: "active" }> | undefined {
    return this.#turn.tag === "active" ? this.#turn : undefined;
  }

  // -------------------------------------------------------------------------
  // Prompt transitions
  // -------------------------------------------------------------------------

  /**
   * Start waiting for editor input. Resolves immediately with `null` when the
   * session is already closed so the main loop can exit.
   */
  awaitInput(resolve: (value: string | null) => void): void {
    if (this.#prompt.tag === "closed") {
      resolve(null);
      return;
    }
    this.#toPrompt({ tag: "awaiting", resolve });
  }

  /**
   * Hand submitted text to the pending input waiter. Returns `false` when
   * nothing is waiting (e.g. a command is still processing), matching the
   * previous "ignore submit without resolver" behavior.
   */
  submitInput(text: string): boolean {
    if (this.#prompt.tag !== "awaiting") {
      return false;
    }
    const { resolve } = this.#prompt;
    this.#toPrompt({ tag: "processing" });
    resolve(text);
    return true;
  }

  /**
   * Close the session. Idempotent; resolves a pending input waiter with
   * `null` so the main loop unblocks.
   */
  close(): void {
    if (this.#prompt.tag === "closed") {
      return;
    }
    const pending =
      this.#prompt.tag === "awaiting" ? this.#prompt.resolve : undefined;
    this.#toPrompt({ tag: "closed" });
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
    this.#turn = { tag: "active", interrupted: false, run };
  }

  /**
   * Request interruption of the active turn. Returns the interrupted run, or
   * `undefined` when no turn is active.
   */
  markInterrupted(): AgentTurn | undefined {
    if (this.#turn.tag !== "active") {
      return;
    }
    this.#turn = { ...this.#turn, interrupted: true };
    return this.#turn.run;
  }

  /** Whether `run` is still the active turn and was interrupted. */
  wasInterrupted(run: AgentTurn): boolean {
    return (
      this.#turn.tag === "active" &&
      this.#turn.run === run &&
      this.#turn.interrupted
    );
  }

  /**
   * Release the turn slot when `run` finishes. Guarded by run identity: a
   * steering-started replacement run must not be cleared by the finishing
   * predecessor.
   */
  endTurn(run: AgentTurn): void {
    if (this.#turn.tag === "active" && this.#turn.run === run) {
      this.#turn = { tag: "none" };
    }
  }

  #toPrompt(next: PromptState): void {
    if (!PROMPT_TRANSITIONS[this.#prompt.tag].includes(next.tag)) {
      throw new InvalidSessionTransitionError(
        "prompt",
        this.#prompt.tag,
        next.tag
      );
    }
    this.#prompt = next;
  }
}
