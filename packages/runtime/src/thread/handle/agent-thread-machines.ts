import { Fsm } from "../../fsm";
import type { RuntimeInputState } from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";

/**
 * Explicit state machines for an `AgentThread`. Each machine owns one
 * orthogonal concern that was previously encoded as a combination of boolean
 * and promise fields on the thread context:
 *
 * - lifecycle: persisted-state loading (`started`/`startPromise`/`shutdownPromise`)
 * - terminal:  kill/delete (`killed`/`killPromise`/`deletePromise`)
 * - drain:     input queue draining (`running`/`drainRequested`/`drainPromise`)
 * - turn:      the active turn (`activeRun`/`activeAbort`/`activeRuntimeInput`/`runToCloseOnKill`)
 */

// ---------------------------------------------------------------------------
// Lifecycle: loading the persisted thread state.
// ---------------------------------------------------------------------------

export type ThreadLifecycleState =
  | { readonly tag: "created" }
  /**
   * `promise` settles when the initial load finishes. A failed load
   * transitions back to `created` so the next call retries the load instead
   * of replaying the first failure forever.
   */
  | { readonly tag: "starting"; readonly promise: Promise<void> }
  | { readonly tag: "started" }
  | { readonly tag: "stopping"; readonly promise: Promise<void> }
  | { readonly tag: "stopped" };

export function createThreadLifecycleMachine(): Fsm<ThreadLifecycleState> {
  return new Fsm<ThreadLifecycleState>({
    initial: { tag: "created" },
    name: "thread-lifecycle",
    transitions: {
      created: ["starting"],
      starting: ["started", "created", "stopping"],
      started: ["stopping"],
      stopping: ["stopped"],
      stopped: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Terminal: kill and delete.
// ---------------------------------------------------------------------------

export type ThreadTerminalState =
  | { readonly tag: "open" }
  | { readonly tag: "killed"; readonly killPromise: Promise<void> }
  /** Delete in flight. A failed delete transitions back to `killed` so the delete can be retried. */
  | {
      readonly tag: "deleting";
      readonly deletePromise: Promise<void>;
      readonly killPromise: Promise<void>;
    }
  | {
      readonly tag: "deleted";
      readonly deletePromise: Promise<void>;
      readonly killPromise: Promise<void>;
    };

export function createThreadTerminalMachine(): Fsm<ThreadTerminalState> {
  return new Fsm<ThreadTerminalState>({
    initial: { tag: "open" },
    name: "thread-terminal",
    transitions: {
      open: ["killed"],
      killed: ["deleting", "open"],
      deleting: ["killed", "deleted"],
      deleted: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Drain: input-queue drain loop.
// ---------------------------------------------------------------------------

export type ThreadDrainState =
  | { readonly tag: "idle" }
  | {
      readonly tag: "draining";
      /** Settles when the current drain loop ends (before any restart). */
      readonly promise: Promise<void>;
      /** A concurrent drain request arrived; restart the loop after this one ends. */
      readonly restartRequested: boolean;
    };

export function createThreadDrainMachine(): Fsm<ThreadDrainState> {
  return new Fsm<ThreadDrainState>({
    initial: { tag: "idle" },
    name: "thread-drain",
    transitions: {
      idle: ["draining"],
      draining: ["draining", "idle"],
    },
  });
}

// ---------------------------------------------------------------------------
// Turn: the currently processing turn.
// ---------------------------------------------------------------------------

export type ThreadTurnState =
  | { readonly tag: "none" }
  | {
      readonly tag: "active";
      readonly abort: AbortController;
      readonly run: BufferedAgentTurn;
      readonly runtimeInput: RuntimeInputState;
      readonly turnId: string;
    }
  /**
   * The turn emitted its terminal event but its processing pipeline has not
   * released yet. The run must still be closed if the thread is killed.
   */
  | {
      readonly tag: "finishing";
      readonly abort: AbortController;
      readonly run: BufferedAgentTurn;
      readonly turnId: string;
    };

export function createThreadTurnMachine(): Fsm<ThreadTurnState> {
  return new Fsm<ThreadTurnState>({
    initial: { tag: "none" },
    name: "thread-turn",
    transitions: {
      none: ["active"],
      active: ["finishing", "none"],
      finishing: ["none"],
    },
  });
}

/**
 * Cross-machine invariants that the transition tables alone cannot express.
 *
 * The four thread machines are deliberately orthogonal to avoid a
 * state-explosion, so the relationships *between* them are enforced here
 * instead of by call-site discipline:
 *
 * 1. A turn only exists inside a running drain loop
 *    (`turn != none  =>  drain = draining`).
 * 2. Shutdown only happens on a killed or deleted thread
 *    (`lifecycle in stopping|stopped  =>  terminal != open`).
 *
 * Call this at machine synchronization points (drain-loop settle, shutdown).
 */
export function assertThreadMachineInvariants(machines: {
  readonly drain: Fsm<ThreadDrainState>;
  readonly lifecycle: Fsm<ThreadLifecycleState>;
  readonly terminal: Fsm<ThreadTerminalState>;
  readonly turn: Fsm<ThreadTurnState>;
}): void {
  if (
    machines.turn.state.tag !== "none" &&
    machines.drain.state.tag !== "draining"
  ) {
    throw new Error(
      `[thread-machines] invariant violated: turn is ${JSON.stringify(machines.turn.state.tag)} while drain is ${JSON.stringify(machines.drain.state.tag)}`
    );
  }
  if (
    machines.lifecycle.in("stopping", "stopped") &&
    machines.terminal.state.tag === "open"
  ) {
    throw new Error(
      `[thread-machines] invariant violated: lifecycle is ${JSON.stringify(machines.lifecycle.state.tag)} while terminal is still "open"`
    );
  }
}

/** Run of the turn that is actively accepting steering input. */
export function activeTurnRun(
  turn: Fsm<ThreadTurnState>
): BufferedAgentTurn | undefined {
  const state = turn.state;
  return state.tag === "active" ? state.run : undefined;
}

/** Runtime input window of the actively steering turn. */
export function activeTurnRuntimeInput(
  turn: Fsm<ThreadTurnState>
): RuntimeInputState | undefined {
  const state = turn.state;
  return state.tag === "active" ? state.runtimeInput : undefined;
}

/** Abort controller of the turn, available until the turn is released. */
export function turnAbort(
  turn: Fsm<ThreadTurnState>
): AbortController | undefined {
  const state = turn.state;
  return state.tag === "none" ? undefined : state.abort;
}

/** Run that must be closed when the thread is killed mid-turn. */
export function turnRunToClose(
  turn: Fsm<ThreadTurnState>
): BufferedAgentTurn | undefined {
  const state = turn.state;
  return state.tag === "none" ? undefined : state.run;
}
