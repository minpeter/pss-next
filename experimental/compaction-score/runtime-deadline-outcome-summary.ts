import {
  auditDeadlineArm,
  deadlineScenarioAggregate,
} from "./deadline-sweep-statistics";
import {
  DEADLINE_SWEEP_SCENARIOS,
  type DeadlineArm,
  type DeadlineArmAudit,
  type DeadlineScenarioAggregate,
} from "./deadline-sweep-types";

export interface RuntimeDeadlineOutcomeSummary {
  readonly audit: DeadlineArmAudit;
  readonly scenarios: Readonly<
    Record<(typeof DEADLINE_SWEEP_SCENARIOS)[number], DeadlineScenarioAggregate>
  >;
}

export function createRuntimeDeadlineOutcomeSummary(
  arm: DeadlineArm
): RuntimeDeadlineOutcomeSummary {
  const scenarios: Partial<
    Record<(typeof DEADLINE_SWEEP_SCENARIOS)[number], DeadlineScenarioAggregate>
  > = {};
  for (const scenario of DEADLINE_SWEEP_SCENARIOS) {
    scenarios[scenario] = deadlineScenarioAggregate(arm, scenario);
  }
  if (
    scenarios["candidate-fit-late-hit"] === undefined ||
    scenarios["candidate-too-broad-fallback"] === undefined ||
    scenarios["overlap-nonblocking"] === undefined ||
    scenarios["prepared-hit"] === undefined ||
    scenarios["repeated-failure-overflow-recovery"] === undefined ||
    scenarios["summary-failure-retry-hit"] === undefined
  ) {
    throw new TypeError("Runtime deadline scenarios are incomplete.");
  }
  return {
    audit: auditDeadlineArm(arm),
    scenarios: {
      "candidate-fit-late-hit": scenarios["candidate-fit-late-hit"],
      "candidate-too-broad-fallback": scenarios["candidate-too-broad-fallback"],
      "overlap-nonblocking": scenarios["overlap-nonblocking"],
      "prepared-hit": scenarios["prepared-hit"],
      "repeated-failure-overflow-recovery":
        scenarios["repeated-failure-overflow-recovery"],
      "summary-failure-retry-hit": scenarios["summary-failure-retry-hit"],
    },
  };
}
