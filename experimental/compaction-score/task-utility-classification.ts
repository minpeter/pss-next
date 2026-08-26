import type { TaskUtilityFixture } from "./task-utility-fixtures";
import type {
  TaskArmResult,
  TaskUtilityArm,
  TaskUtilityPair,
} from "./task-utility-types";

export function classifyTaskUtilityPair(
  fixture: TaskUtilityFixture,
  repetition: number,
  order: readonly [TaskUtilityArm, TaskUtilityArm],
  full: TaskArmResult,
  compact: TaskArmResult
): TaskUtilityPair {
  return {
    arms: [full, compact],
    classification: classification(fixture, full, compact),
    compactPassed: compact.passed,
    fixture: fixture.id,
    fullPassed: full.passed,
    order: order[0] === "full" ? "full-compact" : "compact-full",
    repetition,
  };
}

export function criticalTaskFacts(fixture: TaskUtilityFixture): string {
  const facts: Record<TaskUtilityFixture["id"], readonly string[]> = {
    "exec-committed-event-telemetry": [
      "committedEventCount",
      "pss-headless-v1",
    ],
    "prompt-template-dollar-escape": ["$$", "$ARGUMENTS", "one combined"],
    "workspace-cache-ignore-correction": [".cache", ".pnpm-store", "dist"],
  };
  return facts[fixture.id].join("|");
}

function classification(
  fixture: TaskUtilityFixture,
  full: TaskArmResult,
  compact: TaskArmResult
): TaskUtilityPair["classification"] {
  if (!full.passed) {
    return "invalid-full-control";
  }
  if (compact.passed) {
    return "retained-success";
  }
  return summaryRetainsCriticalFacts(fixture, compact.summary)
    ? "downstream-execution-variance"
    : "context-loss-failure";
}

function summaryRetainsCriticalFacts(
  fixture: TaskUtilityFixture,
  summary: string | null
): boolean {
  return (
    summary !== null &&
    criticalTaskFacts(fixture)
      .split("|")
      .every((fact) => summary.includes(fact))
  );
}
