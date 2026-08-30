import type {
  Checkpoint,
  NotificationRecord,
  TurnKind,
  TurnLease,
  TurnRecord,
  TurnStatus,
} from "../../../../execution/host/types";
import { isPlainRecord as isRecord } from "../../../../internal/guards";
import type { AgentEvent, UserInput } from "../../../../thread/protocol/events";

export function parseRunRecord(value: unknown, file: string): TurnRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected run object");
  }
  if (
    typeof value.checkpointVersion !== "number" ||
    !isRunKind(value.kind) ||
    typeof value.rootRunId !== "string" ||
    typeof value.runId !== "string" ||
    !isRunStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected run record fields");
  }

  return {
    checkpointVersion: value.checkpointVersion,
    ...(typeof value.dedupeKey === "string"
      ? { dedupeKey: value.dedupeKey }
      : {}),
    kind: value.kind,
    ...(isRunLease(value.lease) ? { lease: value.lease } : {}),
    ...("output" in value ? { output: value.output } : {}),
    ...(typeof value.ownerNamespace === "string"
      ? { ownerNamespace: value.ownerNamespace }
      : {}),
    ...(typeof value.parentRunId === "string"
      ? { parentRunId: value.parentRunId }
      : {}),
    ...(typeof value.publicTaskId === "string"
      ? { publicTaskId: value.publicTaskId }
      : {}),
    rootRunId: value.rootRunId,
    runId: value.runId,
    status: value.status,
    threadKey: value.threadKey,
  };
}

export function parseRunCheckpoint(value: unknown, file: string): Checkpoint {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected checkpoint object");
  }
  if (
    typeof value.checkpointId !== "string" ||
    !isCheckpointPhase(value.phase) ||
    typeof value.runId !== "string" ||
    typeof value.version !== "number"
  ) {
    throw invalidFile(file, "expected checkpoint fields");
  }

  return {
    ...(typeof value.childRunId === "string"
      ? { childRunId: value.childRunId }
      : {}),
    checkpointId: value.checkpointId,
    ...("pendingToolCall" in value
      ? { pendingToolCall: value.pendingToolCall }
      : {}),
    phase: value.phase,
    runId: value.runId,
    runtimeState: value.runtimeState,
    threadSnapshot: value.threadSnapshot,
    version: value.version,
  };
}

export function parseNotificationRecord(
  value: unknown,
  file: string
): NotificationRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected notification object");
  }
  if (
    typeof value.idempotencyKey !== "string" ||
    !isUserInput(value.input) ||
    typeof value.notificationId !== "string" ||
    typeof value.runId !== "string" ||
    !isNotificationStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected notification fields");
  }

  const observerEvents = Array.isArray(value.observerEvents)
    ? value.observerEvents.filter(isAgentEvent)
    : undefined;
  if (
    Array.isArray(value.observerEvents) &&
    observerEvents?.length !== value.observerEvents.length
  ) {
    throw invalidFile(file, "expected agent observer events");
  }
  const overlays = Array.isArray(value.overlays)
    ? value.overlays.filter(isUserInput)
    : undefined;
  if (
    Array.isArray(value.overlays) &&
    overlays?.length !== value.overlays.length
  ) {
    throw invalidFile(file, "expected notification overlays");
  }

  return {
    idempotencyKey: value.idempotencyKey,
    input: value.input,
    notificationId: value.notificationId,
    ...(observerEvents ? { observerEvents } : {}),
    ...(overlays ? { overlays } : {}),
    ...(typeof value.ownerNamespace === "string"
      ? { ownerNamespace: value.ownerNamespace }
      : {}),
    runId: value.runId,
    status: value.status,
    threadKey: value.threadKey,
  };
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value.type === "string";
}

function isUserInput(value: unknown): value is UserInput {
  return (
    isRecord(value) &&
    value.type === "user-input" &&
    (typeof value.text === "string" ||
      isStringArray(value.text) ||
      Array.isArray(value.content))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRunLease(value: unknown): value is TurnLease {
  return (
    isRecord(value) &&
    typeof value.attempt === "number" &&
    typeof value.leaseId === "string" &&
    typeof value.leaseUntilMs === "number"
  );
}

function isRunKind(value: unknown): value is TurnKind {
  return (
    value === "notification" ||
    value === "tool-recovery" ||
    value === "user-turn"
  );
}

function isRunStatus(value: unknown): value is TurnStatus {
  return (
    value === "cancelled" ||
    value === "completed" ||
    value === "error" ||
    value === "leased" ||
    value === "needs-recovery" ||
    value === "queued" ||
    value === "retrying" ||
    value === "running" ||
    value === "suspended"
  );
}

function isCheckpointPhase(value: unknown): value is Checkpoint["phase"] {
  return (
    value === "after-model" ||
    value === "after-notification" ||
    value === "after-tool" ||
    value === "before-child-run" ||
    value === "before-model" ||
    value === "before-notification" ||
    value === "before-tool" ||
    value === "child-linked" ||
    value === "suspended"
  );
}

function isNotificationStatus(
  value: unknown
): value is NotificationRecord["status"] {
  return value === "acked" || value === "cancelled" || value === "pending";
}

function invalidFile(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore file ${JSON.stringify(file)}: ${message}`
  );
}
