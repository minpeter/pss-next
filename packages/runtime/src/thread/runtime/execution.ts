import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type {
  AgentHost,
  TurnKind,
  TurnRecord,
  TurnStatus,
  TurnStore,
} from "../../execution/host/types";
import type { RuntimeToolExecutionContext } from "../../llm/tool-execution-types";
import type { ThreadState } from "../state/thread-state";
import type { ThreadAutoCompactionOptions } from "./auto-compaction-types";
import {
  createThreadToolExecutionContext,
  type ThreadToolCallInterceptor,
  type ThreadToolResultInterceptor,
} from "./execution-checkpoints";

export interface ThreadExecutionOptions {
  readonly autoCompaction?: ThreadAutoCompactionOptions;
  readonly executionHost?: AgentHost;
  readonly hookRuntime?: AgentHookRuntime;
}

export interface QueuedThreadExecutionRun {
  readonly kind: TurnKind;
  readonly runId: string;
}

export interface ThreadExecutionRun {
  complete(status: ThreadExecutionTerminalStatus): Promise<void>;
  readonly runId: string;
  readonly toolExecution: RuntimeToolExecutionContext;
}

export type ThreadExecutionTerminalStatus = Extract<
  TurnStatus,
  "cancelled" | "completed" | "error" | "needs-recovery"
>;

export async function precreateThreadExecutionRun({
  executionHost,
  kind,
  runId: requestedRunId,
  threadKey,
  turnStore,
}: {
  readonly executionHost?: AgentHost;
  readonly kind: TurnKind;
  readonly runId?: string;
  readonly threadKey: string;
  readonly turnStore?: TurnStore;
}): Promise<TurnRecord | undefined> {
  const turns = turnStore ?? executionHost?.store.turns;
  if (!turns) {
    return;
  }

  const runId =
    requestedRunId ??
    createThreadExecutionRunId({
      threadKey,
      turnId: crypto.randomUUID(),
    });
  const created = await turns.create(
    createThreadExecutionRunRecord({
      kind,
      runId,
      status: "queued",
      threadKey,
    })
  );
  return created.record;
}

export async function startThreadExecutionRun({
  executionRun,
  executionHost,
  interceptToolCall,
  interceptToolResult,
  threadKey,
  state,
  turnId,
}: {
  readonly executionRun?: QueuedThreadExecutionRun;
  readonly executionHost?: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly threadKey: string;
  readonly state: ThreadState;
  readonly turnId: string;
}): Promise<ThreadExecutionRun | undefined> {
  if (!executionHost) {
    return;
  }

  const runId =
    executionRun?.runId ?? createThreadExecutionRunId({ threadKey, turnId });
  const created = await executionHost.store.turns.create(
    createThreadExecutionRunRecord({
      kind: executionRun?.kind ?? "user-turn",
      runId,
      status: "running",
      threadKey,
    })
  );
  if (!(created.ok || isTerminalTurnStatus(created.record.status))) {
    await executionHost.store.turns.update({
      ...created.record,
      status: "running",
    });
  }

  return {
    complete: (status) =>
      completeThreadExecutionRun({ executionHost, runId, status }),
    runId,
    toolExecution: createThreadToolExecutionContext({
      executionHost,
      interceptToolCall,
      interceptToolResult,
      runId,
      state,
    }),
  };
}

export async function cancelThreadExecutionRun({
  executionHost,
  executionRun,
  runId,
}: {
  readonly executionHost?: AgentHost;
  readonly executionRun?: QueuedThreadExecutionRun;
  readonly runId?: string;
}): Promise<void> {
  const targetRunId = runId ?? executionRun?.runId;
  if (!(executionHost && targetRunId)) {
    return;
  }

  const run = await executionHost.store.turns.get(targetRunId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }
  await executionHost.store.turns.update({ ...run, status: "cancelled" });
}

export function createThreadExecutionRunRecord({
  kind,
  runId,
  status,
  threadKey,
}: {
  readonly kind: TurnKind;
  readonly runId: string;
  readonly status: Extract<TurnStatus, "queued" | "running">;
  readonly threadKey: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: runId,
    kind,
    rootRunId: runId,
    runId,
    threadKey,
    status,
  };
}

async function completeThreadExecutionRun({
  executionHost,
  runId,
  status,
}: {
  readonly executionHost: AgentHost;
  readonly runId: string;
  readonly status: ThreadExecutionTerminalStatus;
}): Promise<void> {
  const run = await executionHost.store.turns.get(runId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }

  await executionHost.store.turns.update({ ...run, status });
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "error" ||
    status === "needs-recovery"
  );
}
