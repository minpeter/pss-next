import { assertNever } from "../../internal/guards";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import type { RuntimeToolExecutionCheckpointMetadata } from "../../llm/tool-execution-types";
import { appendLeaseFencedCheckpoint } from "../host/checkpoint-fencing";
import { createCheckpointId } from "../host/checkpoint-ids";
import type { AgentHost, Checkpoint, CheckpointPhase } from "../host/types";
import type { ResumeRunState } from "./types";

const maxCheckpointWriteAttempts = 5;

interface ResumeStateCheckpointReference {
  readonly kind: "resume-state-ref";
  readonly messageCount: number;
}

type ResumeStepStart = "new-step" | "resume-before-model";

interface ResumeStep {
  readonly phase: ResumeStepStart;
  readonly stepNumber: number;
}

class ResumeRunCheckpointError extends Error {
  readonly currentVersion: number;
  readonly expectedVersion: number;
  readonly runId: string;

  constructor(runId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Cannot write checkpoint for run ${runId}: expected version ${expectedVersion}, got ${currentVersion}`
    );
    this.currentVersion = currentVersion;
    this.expectedVersion = expectedVersion;
    this.name = "ResumeRunCheckpointError";
    this.runId = runId;
  }
}

class ResumeRunMissingRunError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Cannot resume missing run ${runId}`);
    this.name = "ResumeRunMissingRunError";
    this.runId = runId;
  }
}

export function resumeStepFromCheckpoint(
  checkpoint: Checkpoint | null
): ResumeStep {
  if (
    checkpoint?.phase === "before-model" ||
    checkpoint?.phase === "before-tool" ||
    checkpoint?.phase === "after-tool"
  ) {
    return {
      phase: "resume-before-model",
      stepNumber: checkpointStep(checkpoint),
    };
  }

  return {
    phase: "new-step",
    stepNumber: checkpoint ? checkpointStep(checkpoint) + 1 : 1,
  };
}

export function throwIfManualToolRecoveryRequired(
  checkpoint: Checkpoint | null
): void {
  if (
    checkpoint?.phase !== "before-tool" &&
    checkpoint?.phase !== "after-tool"
  ) {
    return;
  }

  const pendingToolCall = runtimeToolCheckpoint(checkpoint.pendingToolCall);
  if (pendingToolCall?.policy !== "manual-recovery") {
    return;
  }

  throw new ToolExecutionNeedsRecoveryError(pendingToolCall);
}

export async function appendCheckpoint({
  host,
  leaseId,
  phase,
  pendingToolCall,
  runId,
  runtimeState,
  threadSnapshot,
}: {
  readonly host: AgentHost;
  readonly leaseId: string | null;
  readonly pendingToolCall?: unknown;
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly runtimeState: unknown;
  readonly threadSnapshot: ResumeStateCheckpointReference;
}): Promise<void> {
  let lastConflict:
    | { readonly current: number; readonly expected: number }
    | undefined;
  for (let attempt = 0; attempt < maxCheckpointWriteAttempts; attempt += 1) {
    const run = await host.store.turns.get(runId);
    if (!run) {
      throw new ResumeRunMissingRunError(runId);
    }

    const version = run.checkpointVersion + 1;
    const result = await appendLeaseFencedCheckpoint(
      host.store,
      {
        checkpointId: createCheckpointId({ phase, runId, version }),
        ...(pendingToolCall === undefined ? {} : { pendingToolCall }),
        phase,
        runId,
        runtimeState,
        threadSnapshot,
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
        throw new ResumeRunCheckpointError(
          runId,
          run.checkpointVersion,
          run.checkpointVersion
        );
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

  throw new ResumeRunCheckpointError(
    runId,
    lastConflict?.expected ?? 0,
    lastConflict?.current ?? 0
  );
}

export function resumeStateCheckpointReference(
  state: ResumeRunState
): ResumeStateCheckpointReference {
  return {
    kind: "resume-state-ref",
    messageCount: state.history.length,
  };
}

function runtimeToolCheckpoint(
  value: unknown
): RuntimeToolExecutionCheckpointMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }

  if (
    !(
      "attempt" in value &&
      "idempotencyKey" in value &&
      "policy" in value &&
      "toolCallId" in value &&
      "toolName" in value
    )
  ) {
    return;
  }

  if (
    typeof value.attempt !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string"
  ) {
    return;
  }

  if (
    value.policy !== "idempotent" &&
    value.policy !== "manual-recovery" &&
    value.policy !== "pure"
  ) {
    return;
  }

  return {
    attempt: value.attempt,
    idempotencyKey: value.idempotencyKey,
    policy: value.policy,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
  };
}

function checkpointStep(checkpoint: Checkpoint): number {
  const state = checkpoint.runtimeState;
  if (
    typeof state === "object" &&
    state !== null &&
    "step" in state &&
    typeof state.step === "number"
  ) {
    return state.step;
  }

  return checkpoint.version;
}
