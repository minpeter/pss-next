import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { AgentHost } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun, type ThreadExecutionRun } from "./execution";
import { ThreadEventDispatcher } from "./thread-event-dispatcher";

export interface ReplacedExecutionFixture {
  readonly execution: ThreadExecutionRun;
  readonly host: ReturnType<typeof createInMemoryHost>;
  readonly state: ThreadState;
  readonly threadKey: string;
}

export async function createReplacedExecution(
  scenario: string
): Promise<ReplacedExecutionFixture> {
  const host = createInMemoryHost();
  const threadKey = `ownership-${scenario}`;
  const state = new ThreadState({ key: threadKey, store: host.store.threads });
  await state.ensureLoaded();
  const execution = await startThreadExecutionRun({
    executionHost: host,
    executionRun: { kind: "user-turn", runId: `run-${scenario}` },
    state,
    threadKey,
    turnId: "unused",
  });
  if (!execution) {
    throw new Error("Expected a durable execution.");
  }
  const replacement = await host.store.turns.claim(execution.runId, {
    attempt: 2,
    leaseId: "replacement-owner",
    leaseMs: 100,
    nowMs: 0,
  });
  if (!replacement.ok) {
    throw new Error("Expected replacement owner to claim the run.");
  }
  return { execution, host, state, threadKey };
}

export function createDispatcher(
  host: AgentHost,
  state: ThreadState,
  threadKey: string
): ThreadEventDispatcher {
  return new ThreadEventDispatcher({
    attachmentStore: host.attachmentStore,
    history: () => state.modelSnapshot(),
    hookRuntime: new AgentHookRuntime(),
    signal: () => undefined,
    threadKey,
  });
}

export async function readEventTypes(
  host: ReturnType<typeof createInMemoryHost>,
  threadKey: string
): Promise<readonly string[]> {
  const eventTypes: string[] = [];
  for await (const record of host.store.threadEvents.read(threadKey)) {
    eventTypes.push(record.event.type);
  }
  return eventTypes;
}
