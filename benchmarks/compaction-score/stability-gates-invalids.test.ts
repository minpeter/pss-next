import { describe, expect, it } from "vitest";
import type { TrialSummary } from "./report";
import { evaluateStabilityComparison } from "./stability-gates";
import {
  expectCode,
  mutatedDecision,
  summary,
} from "./stability-gates.test-support";

describe("stability invalid-attempt gates", () => {
  it.each([
    ["compaction-prompt-failure", "COMPACTION_PROMPT_FAILURE"],
    ["protocol-failure", "PROTOCOL_FAILURE"],
    ["non-compressing-summary", "NON_COMPRESSING_SUMMARY"],
  ] as const)("blocks %s attempts", (status, code) => {
    const decision = mutatedDecision((candidate) => {
      candidate.trials.attempted = 5;
      candidate.trials.valid = 4;
      candidate.trials.invalidByStatus[status] = 1;
    });

    expectCode(decision, code);
    expect(decision.failures).toContainEqual({
      code,
      payload: { attempted: 5, count: 1, status },
    });
  });

  it("allows provider/evaluator invalids only through 25% of attempts", () => {
    const over = mutatedDecision((candidate) => {
      candidate.trials.attempted = 8;
      candidate.trials.valid = 5;
      candidate.trials.invalidByStatus["evaluation-provider-failure"] = 1;
      candidate.trials.invalidByStatus["invalid-full-control"] = 1;
      candidate.trials.invalidByStatus["summary-provider-failure"] = 1;
    });
    const boundary = mutatedDecision((candidate) => {
      candidate.trials.attempted = 8;
      candidate.trials.valid = 6;
      candidate.trials.invalidByStatus["evaluation-provider-failure"] = 1;
      candidate.trials.invalidByStatus["invalid-full-control"] = 1;
    });

    expectCode(over, "PROVIDER_EVALUATOR_INVALID_RATE_EXCEEDED");
    expect(over.failures).toContainEqual({
      code: "PROVIDER_EVALUATOR_INVALID_RATE_EXCEEDED",
      payload: {
        attempted: 8,
        count: 3,
        maximum: 0.25,
        rate: 0.375,
        statuses: {
          "evaluation-provider-failure": 1,
          "invalid-full-control": 1,
          "summary-provider-failure": 1,
        },
      },
    });
    expect(boundary).toEqual({ failures: [], passed: true });
  });

  it("counts imperfect full-context controls as evaluator invalids", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.trials.attempted = 5;
      candidate.trials.valid = 3;
      candidate.trials.invalidByStatus["invalid-full-control"] = 2;
    });

    expectCode(decision, "PROVIDER_EVALUATOR_INVALID_RATE_EXCEEDED");
  });

  it("fails closed when no attempts exist", () => {
    const candidate = {
      compression: null,
      retention: null,
      trials: { attempted: 0, invalidByStatus: {}, valid: 0 },
    } satisfies TrialSummary;
    const decision = evaluateStabilityComparison(summary(), candidate);

    expectCode(decision, "ATTEMPTS_MISSING");
  });
});
