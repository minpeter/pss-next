import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type {
  AgentHost,
  TurnKind,
  TurnRecord,
  TurnStatus,
  TurnStore,
} from "../../execution/host/types";
import type { RuntimeToolExecutionContext } from "../../llm/tool-execution-types";
import type { ThreadState } from "../state/thread-state";
import type { CommitResult } from "../store/types";
import type { AgentCompaction } from "./auto-compaction-types";
import {
  createThreadToolExecutionContext,
  type ThreadToolCallInterceptor,
  type ThreadToolResultInterceptor,
} from "./execution-checkpoints";
import {
  commitOwnedThreadExecutionRunStorage,
  completeThreadExecutionRun,
  isTerminalTurnStatus,
  type OwnedRunStorageCommit,
  settleThreadExecutionRun,
  type TerminalRunStorageCommit,
} from "./terminal-run-settlement";

export interface ThreadExecutionOptions {
  readonly compaction?: AgentCompaction;
  readonly executionHost?: AgentHost;
  readonly hookRuntime?: AgentHookRuntime;
}

export interface QueuedThreadExecutionRun {
  readonly kind: TurnKind;
  readonly leaseId?: string | null;
  readonly runId: string;
}

export type ThreadExecutionCancellation =
  | {
      readonly kind: "owned";
      readonly leaseId: string | null;
      readonly runId: string;
    }
  | { readonly kind: "unleased"; readonly runId: string };

export interface ThreadExecutionRun {
  commitOwned<Result>(persist: OwnedRunStorageCommit<Result>): Promise<Result>;
  complete(status: ThreadExecutionTerminalStatus): Promise<void>;
  readonly runId: string;
  settle(
    status: ThreadExecutionTerminalStatus,
    persist: TerminalRunStorageCommit
  ): Promise<CommitResult>;
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
  let running = created.record;
  if (!(created.ok || isTerminalTurnStatus(created.record.status))) {
    const transition = await transitionTurn(executionHost.store.turns, {
      expected: {
        leaseId: executionRun?.leaseId ?? null,
        status: created.record.status,
      },
      runId,
      update: { status: "running" },
    });
    if (!transition.ok) {
      throw new TurnTransitionConflictError(runId, "start", transition.reason);
    }
    running = transition.record;
  }

  const leaseId = running.lease?.leaseId ?? null;
  return {
    commitOwned: async (persist) =>
      await commitOwnedThreadExecutionRunStorage({
        executionHost,
        leaseId,
        persist,
        runId,
      }),
    complete: async (status) =>
      await completeThreadExecutionRun({
        executionHost,
        leaseId,
        runId,
        status,
      }),
    runId,
    settle: async (status, persist) =>
      await settleThreadExecutionRun({
        executionHost,
        leaseId,
        persist,
        runId,
        status,
      }),
    toolExecution: createThreadToolExecutionContext({
      executionHost,
      interceptToolCall,
      interceptToolResult,
      leaseId,
      runId,
      state,
    }),
  };
}

export function cancellationForExecutionRun(
  executionRun: QueuedThreadExecutionRun | undefined
): ThreadExecutionCancellation | undefined {
  if (!executionRun) {
    return;
  }
  return {
    kind: "owned",
    leaseId: executionRun.leaseId ?? null,
    runId: executionRun.runId,
  };
}

export async function cancelThreadExecutionRun({
  cancellation,
  executionHost,
}: {
  readonly cancellation: ThreadExecutionCancellation | undefined;
  readonly executionHost?: AgentHost;
}): Promise<void> {
  if (!(executionHost && cancellation)) {
    return;
  }

  const run = await executionHost.store.turns.get(cancellation.runId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }
  const transition = await transitionTurn(executionHost.store.turns, {
    expected: {
      leaseId: cancellation.kind === "owned" ? cancellation.leaseId : null,
      status: run.status,
    },
    runId: cancellation.runId,
    update: { status: "cancelled" },
  });
  if (!transition.ok) {
    if (transition.reason === "lease-conflict") {
      return;
    }
    const current =
      transition.reason === "status-conflict"
        ? await executionHost.store.turns.get(cancellation.runId)
        : undefined;
    if (current && isTerminalTurnStatus(current.status)) {
      return;
    }
    throw new TurnTransitionConflictError(
      cancellation.runId,
      "cancel",
      transition.reason
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
