import type {
  RuntimeDiagnostic,
  RuntimeDiagnosticsSink,
} from "../../diagnostics";
import type { AgentCompaction } from "./auto-compaction-types";
import {
  DEFAULT_COMPACTION_DEADLINE_MS,
  MAX_COMPACTION_DEADLINE_MS,
} from "./auto-compaction-types";

export interface CompactionDeadline {
  readonly deadlineAt: number;
  readonly deadlineMs: number;
}

export function automaticCompactionDeadline({
  compaction,
  diagnostics,
}: {
  readonly compaction: AgentCompaction;
  readonly diagnostics?: RuntimeDiagnosticsSink;
}): CompactionDeadline {
  try {
    return compactionDeadline(compaction.deadlineMs);
  } catch {
    reportInvalidDeadline(diagnostics);
    return compactionDeadline();
  }
}

export function strictCompactionDeadline(
  readDeadlineMs?: () => number
): CompactionDeadline {
  return compactionDeadline(readDeadlineMs);
}

function compactionDeadline(readDeadlineMs?: () => number): CompactionDeadline {
  const deadlineMs = readDeadlineMs?.() ?? DEFAULT_COMPACTION_DEADLINE_MS;
  if (
    !(
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <= MAX_COMPACTION_DEADLINE_MS
    )
  ) {
    throw new TypeError(
      `Agent compaction deadlineMs() must return a positive safe integer no greater than ${MAX_COMPACTION_DEADLINE_MS}.`
    );
  }
  return { deadlineAt: Date.now() + deadlineMs, deadlineMs };
}

function reportInvalidDeadline(
  diagnostics: RuntimeDiagnosticsSink | undefined
): void {
  if (!diagnostics) {
    return;
  }
  const diagnostic: RuntimeDiagnostic = {
    code: "compaction.deadline-invalid",
    level: "warning",
    phase: "auto-compaction",
  };
  Promise.resolve()
    .then(() => diagnostics.report(diagnostic))
    .catch(() => undefined);
}
