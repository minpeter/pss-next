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
import type { AgentCompaction } from "./auto-compaction-types";
import {
  createThreadToolExecutionContext,
  type ThreadToolCallInterceptor,
  type ThreadToolResultInterceptor,
} from "./execution-checkpoints";

export interface ThreadExecutionOptions {
  readonly compaction?: AgentCompaction;
  readonly executionHost?: AgentHost;
  readonly hookRuntime?: AgentHookRuntime;
}

export interface QueuedThreadExecutionRun {
  readonly kind: TurnKind;
  readonly leaseId?: string;
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
    const transition = await executionHost.store.turns.transition(
      runId,
      {
        leaseId: executionRun?.leaseId,
        status: created.record.status,
      },
      { ...created.record, status: "running" }
    );
    if (!transition.ok) {
      throw new Error(
        `Thread execution run ${runId} transition failed: ${transition.reason}.`
      );
    }
  }

  const running = await executionHost.store.turns.get(runId);
  if (!running) {
    throw new Error(`Thread execution run ${runId} is missing.`);
  }

  return {
    complete: (status) =>
      completeThreadExecutionRun({
        executionHost,
        leaseId: running.lease?.leaseId,
        runId,
        status,
      }),
    runId,
    toolExecution: createThreadToolExecutionContext({
      executionHost,
      interceptToolCall,
      interceptToolResult,
      leaseId: running.lease?.leaseId,
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
  const transition = await executionHost.store.turns.transition(
    targetRunId,
    {
      leaseId: executionRun?.leaseId ?? run.lease?.leaseId,
      status: run.status,
    },
    { ...run, status: "cancelled" }
  );
  if (!transition.ok) {
    throw new Error(
      `Thread execution run ${targetRunId} cancellation failed: ${transition.reason}.`
    );
  }
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
  leaseId,
  runId,
  status,
}: {
  readonly executionHost: AgentHost;
  readonly leaseId?: string;
  readonly runId: string;
  readonly status: ThreadExecutionTerminalStatus;
}): Promise<void> {
  const run = await executionHost.store.turns.get(runId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }

  const transition = await executionHost.store.turns.transition(
    runId,
    { leaseId, status: run.status },
    { ...run, status }
  );
  if (!transition.ok) {
    throw new Error(
      `Thread execution run ${runId} terminal transition failed: ${transition.reason}.`
    );
  }
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "error" ||
    status === "needs-recovery"
  );
}
