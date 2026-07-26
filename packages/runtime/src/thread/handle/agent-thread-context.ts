import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type {
  QueuedInput,
  QueuedRuntimeInput,
  RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import {
  type ThreadPersistenceOptions,
  ThreadState,
} from "../state/thread-state";
import { DurableInputRecoveryState } from "./durable-queue-claims";

export interface AgentThreadContext {
  activeAbort: AbortController | undefined;
  activeRun: BufferedAgentTurn | undefined;
  activeRuntimeInput: RuntimeInputState | undefined;
  deletePromise: Promise<void> | undefined;
  drainPromise: Promise<void> | undefined;
  drainRequested: boolean;
  readonly durableInputRecovery: DurableInputRecoveryState;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions;
  inputAdmissionQueue: Promise<void>;
  readonly inputQueue: QueuedInput[];
  killed: boolean;
  killPromise: Promise<void> | undefined;
  readonly model: ModelGenerationOptions;
  readonly pendingOverlays: QueuedRuntimeInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  running: boolean;
  runToCloseOnKill: BufferedAgentTurn | undefined;
  shutdownPromise: Promise<void> | undefined;
  started: boolean;
  startPromise: Promise<void> | undefined;
  readonly state: ThreadState;
  readonly threadKey: string;
}

export function createAgentThreadContext(
  model: ModelGenerationOptions,
  persistence: ThreadPersistenceOptions,
  execution: ThreadExecutionOptions
): AgentThreadContext {
  const hookRuntime = execution.hookRuntime ?? new AgentHookRuntime();
  const resolvedExecution = { ...execution, hookRuntime };
  const threadModel = model;
  const state = new ThreadState(persistence);
  let context: AgentThreadContext;

  context = {
    activeAbort: undefined,
    activeRun: undefined,
    activeRuntimeInput: undefined,
    deletePromise: undefined,
    drainPromise: undefined,
    drainRequested: false,
    durableInputRecovery: new DurableInputRecoveryState(),
    events: new ThreadEventDispatcher({
      attachmentStore: model.attachmentStore,
      history: () => state.modelSnapshot(),
      hookRuntime,
      signal: () => context.activeAbort?.signal,
      threadKey: persistence.key,
    }),
    execution: resolvedExecution,
    inputAdmissionQueue: Promise.resolve(),
    inputQueue: [],
    killed: false,
    killPromise: undefined,
    model: threadModel,
    pendingOverlays: [],
    pendingRuntimeInputs: [],
    running: false,
    runToCloseOnKill: undefined,
    shutdownPromise: undefined,
    started: false,
    startPromise: undefined,
    state,
    threadKey: persistence.key,
  };
  return context;
}
