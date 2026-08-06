import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { Fsm } from "../../fsm";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { QueuedInput, QueuedRuntimeInput } from "../input/runtime-input";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import {
  type ThreadPersistenceOptions,
  ThreadState,
} from "../state/thread-state";
import {
  createThreadDrainMachine,
  createThreadLifecycleMachine,
  createThreadTerminalMachine,
  createThreadTurnMachine,
  type ThreadDrainState,
  type ThreadLifecycleState,
  type ThreadTerminalState,
  type ThreadTurnState,
  turnAbort,
} from "./agent-thread-machines";
import { DurableInputRecoveryState } from "./durable-queue-claims";

export interface AgentThreadContext {
  /** Input-queue drain loop state machine. */
  readonly drain: Fsm<ThreadDrainState>;
  readonly durableInputRecovery: DurableInputRecoveryState;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions & {
    readonly hookRuntime: AgentHookRuntime;
  };
  /** Serializes input admission; concurrency control, not a state. */
  inputAdmissionQueue: Promise<void>;
  readonly inputQueue: QueuedInput[];
  /** Persisted-state load/shutdown state machine. */
  readonly lifecycle: Fsm<ThreadLifecycleState>;
  readonly model: ModelGenerationOptions;
  readonly pendingOverlays: QueuedRuntimeInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  readonly state: ThreadState;
  /** Kill/delete state machine; anything but `open` is terminal for new work. */
  readonly terminal: Fsm<ThreadTerminalState>;
  readonly threadKey: string;
  /** Active-turn state machine. */
  readonly turn: Fsm<ThreadTurnState>;
}

export function createAgentThreadContext(
  model: ModelGenerationOptions,
  persistence: ThreadPersistenceOptions,
  execution: ThreadExecutionOptions
): AgentThreadContext {
  const hookRuntime = execution.hookRuntime ?? new AgentHookRuntime();
  const resolvedExecution = { ...execution, hookRuntime };
  const state = new ThreadState(persistence);
  const turn = createThreadTurnMachine();

  return {
    drain: createThreadDrainMachine(),
    durableInputRecovery: new DurableInputRecoveryState(),
    events: new ThreadEventDispatcher({
      attachmentStore: model.attachmentStore,
      history: () => state.modelSnapshot(),
      hookRuntime,
      signal: () => turnAbort(turn)?.signal,
      threadKey: persistence.key,
    }),
    execution: resolvedExecution,
    inputAdmissionQueue: Promise.resolve(),
    inputQueue: [],
    lifecycle: createThreadLifecycleMachine(),
    model,
    pendingOverlays: [],
    pendingRuntimeInputs: [],
    state,
    terminal: createThreadTerminalMachine(),
    threadKey: persistence.key,
    turn,
  };
}
