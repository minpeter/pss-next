import { appendLeaseFencedCheckpoint } from "../../execution/host/checkpoint-fencing";
import { createCheckpointId } from "../../execution/host/checkpoint-ids";
import type {
  AgentHost,
  CheckpointPhase,
  LeaseFencedCheckpointWriteResult,
} from "../../execution/host/types";
import { assertNever } from "../../internal/guards";
import { persistedToolExecutionCheckpoint } from "../../llm/tool-execution-checkpoint";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import type { ThreadState } from "../state/thread-state";

const maxCheckpointWriteAttempts = 5;

export type ThreadToolCallInterceptor = (
  checkpoint: RuntimeToolExecutionCheckpoint
) => Promise<RuntimeToolExecutionDecision> | RuntimeToolExecutionDecision;

export type ThreadToolResultInterceptor = (
  checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
) =>
  | Promise<RuntimeToolExecutionResult | undefined>
  | RuntimeToolExecutionResult
  | undefined;

export class ThreadExecutionCheckpointError extends Error {
  constructor(runId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Thread execution run ${runId} checkpoint conflict: expected ${expectedVersion}, got ${currentVersion}`
    );
    this.name = "ThreadExecutionCheckpointError";
  }
}

type CheckpointAuthorityConflictReason = Exclude<
  Extract<LeaseFencedCheckpointWriteResult, { readonly ok: false }>["reason"],
  "stale-version"
>;

const CHECKPOINT_AUTHORITY_CONFLICT_MESSAGES = {
  "lease-conflict": "checkpoint lease conflict.",
  "not-found": "checkpoint run is missing.",
  "status-conflict": "checkpoint status conflict: run is terminal.",
} as const satisfies Record<CheckpointAuthorityConflictReason, string>;

export class ThreadExecutionCheckpointAuthorityError extends Error {
  readonly reason: CheckpointAuthorityConflictReason;
  readonly runId: string;

  constructor(runId: string, reason: CheckpointAuthorityConflictReason) {
    super(
      `Thread execution run ${runId} ${CHECKPOINT_AUTHORITY_CONFLICT_MESSAGES[reason]}`
    );
    this.name = "ThreadExecutionCheckpointAuthorityError";
    this.reason = reason;
    this.runId = runId;
  }
}

export function createThreadToolExecutionContext({
  executionHost,
  interceptToolCall,
  interceptToolResult,
  leaseId,
  runId,
  state,
}: {
  readonly executionHost: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly leaseId: string | null;
  readonly runId: string;
  readonly state: ThreadState;
}): RuntimeToolExecutionContext {
  return {
    attempt: 1,
    afterTool: async (checkpoint) => {
      await appendThreadToolExecutionCheckpoint({
        executionHost,
        leaseId,
        phase: "after-tool",
        runId,
        state,
        toolCall: checkpoint,
      });
      return await interceptToolResult?.(checkpoint);
    },
    beforeTool: async (checkpoint) => {
      await appendThreadToolExecutionCheckpoint({
        executionHost,
        leaseId,
        phase: "before-tool",
        runId,
        state,
        toolCall: checkpoint,
      });
      const decision = await interceptToolCall?.(checkpoint);
      if (
        decision?.status === "needs-recovery" &&
        checkpoint.policy !== "manual-recovery"
      ) {
        await appendThreadToolExecutionCheckpoint({
          executionHost,
          leaseId,
          phase: "before-tool",
          runId,
          state,
          toolCall: { ...checkpoint, policy: "manual-recovery" },
        });
      }
      return decision;
    },
    runId,
  };
}

async function appendThreadToolExecutionCheckpoint({
  executionHost,
  leaseId,
  phase,
  runId,
  state,
  toolCall,
}: {
  readonly executionHost: AgentHost;
  readonly leaseId: string | null;
  readonly phase: Extract<CheckpointPhase, "after-tool" | "before-tool">;
  readonly runId: string;
  readonly state: ThreadState;
  readonly toolCall: RuntimeToolExecutionCheckpoint & {
    readonly output?: unknown;
  };
}): Promise<void> {
  let lastConflict:
    | { readonly current: number; readonly expected: number }
    | undefined;
  for (let attempt = 0; attempt < maxCheckpointWriteAttempts; attempt += 1) {
    const run = await executionHost.store.turns.get(runId);
    if (!run) {
      throw new Error(`Thread execution run ${runId} is missing.`);
    }

    const version = run.checkpointVersion + 1;
    const result = await appendLeaseFencedCheckpoint(
      executionHost.store,
      {
        checkpointId: createCheckpointId({ phase, runId, version }),
        pendingToolCall: persistedToolExecutionCheckpoint(toolCall),
        phase,
        runId,
        runtimeState: {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
        threadSnapshot: state.threadCheckpointReference(),
        version,
      },
      {
        expectedLeaseId: leaseId,
        expectedVersion: run.checkpointVersion,
      }
    );

    if (result.ok) {
      return;
    }

    switch (result.reason) {
      case "lease-conflict":
      case "not-found":
      case "status-conflict":
        throw new ThreadExecutionCheckpointAuthorityError(runId, result.reason);
      case "stale-version":
        lastConflict = {
          current: result.currentVersion,
          expected: run.checkpointVersion,
        };
        break;
      default:
        assertNever(result);
    }
  }

  throw new ThreadExecutionCheckpointError(
    runId,
    lastConflict?.expected ?? 0,
    lastConflict?.current ?? 0
  );
}
