import { describe, expect, it } from "vitest";
import { DEADLINE_SWEEP_SCENARIOS } from "./deadline-sweep-types";
import { parseDeadlineArm } from "./deadline-sweep-validation";

describe("deadline sweep live artifact validation", () => {
  it("accepts exactly 60 causal-path-audited cells", () => {
    const arm = liveArm();

    expect(parseDeadlineArm(arm, "valid").attempts).toHaveLength(60);
  });

  it("rejects missing causal path evidence", () => {
    const arm = liveArm();
    const trial = arm.trials[0];
    if (trial === undefined) {
      throw new TypeError("Fixture trial is missing.");
    }
    arm.trials[0] = { ...trial, pathValid: undefined };

    expect(() => parseDeadlineArm(arm, "missing-path")).toThrow(
      "lacks required causal path evidence"
    );
  });

  it("rejects untyped policy timeouts", () => {
    const arm = liveArm();
    const trial = arm.trials[0];
    if (trial === undefined) {
      throw new TypeError("Fixture trial is missing.");
    }
    trial.candidateApplied = false;
    trial.errorCategory = "timeout";
    trial.errorCode = "wrong-code";
    trial.outcome = "timeout";
    trial.providerStarted = false;
    trial.providerStartedAtMs = null;

    expect(() => parseDeadlineArm(arm, "untyped-timeout")).toThrow(
      "invalid deadline trial"
    );
  });

  it("rejects duplicate scenario-repetition cells", () => {
    const arm = liveArm();
    const first = arm.attempts[0];
    if (first === undefined) {
      throw new TypeError("Fixture attempt is missing.");
    }
    arm.attempts.push({ ...first });

    expect(() => parseDeadlineArm(arm, "duplicate")).toThrow(
      "cells must be unique"
    );
  });

  it("rejects malformed summary span evidence", () => {
    const arm = liveArm();
    const trial = arm.trials[0];
    if (trial === undefined) {
      throw new TypeError("Fixture trial is missing.");
    }
    trial.summaryCallsStarted = 1;
    trial.summarySpans = [
      {
        endedAtMs: 2,
        kind: "not-summary",
        startedAtMs: 1,
        status: "completed",
      },
    ];

    expect(() => parseDeadlineArm(arm, "invalid-span")).toThrow(
      "summarySpans[0] is invalid"
    );
  });
});

function liveArm() {
  const attempts: MutableAttempt[] = [];
  const trials: MutableTrial[] = [];
  for (const scenario of DEADLINE_SWEEP_SCENARIOS) {
    for (let repetition = 1; repetition <= 10; repetition += 1) {
      attempts.push({ repetition, scenario, status: "completed" });
      trials.push({
        candidateApplied: false,
        deadlineMs: 10_000,
        decisionLatencyMs: 5,
        outcome: "provider-started",
        pathValid: true,
        providerStarted: true,
        providerStartedAtMs: 5,
        repetition,
        scenario,
        summaryCallsStarted: 0,
        summarySpans: [],
      });
    }
  }
  return {
    attempts,
    createdAt: "2026-08-15T00:00:00.000Z",
    deadlineMs: 10_000,
    mode: "live",
    model: "test-model",
    trials,
  };
}

interface MutableAttempt {
  repetition: number;
  scenario: (typeof DEADLINE_SWEEP_SCENARIOS)[number];
  status: "completed";
}

interface MutableTrial {
  candidateApplied: boolean;
  deadlineMs: number;
  decisionLatencyMs: number;
  errorCategory?: string;
  errorCode?: string;
  outcome: "provider-started" | "timeout";
  pathValid?: boolean;
  providerStarted: boolean;
  providerStartedAtMs: number | null;
  repetition: number;
  scenario: (typeof DEADLINE_SWEEP_SCENARIOS)[number];
  summaryCallsStarted: number;
  summarySpans: unknown[];
}
