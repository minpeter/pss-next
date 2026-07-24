import { describe, expect, it } from "vitest";
import { evaluateStabilityComparison } from "./stability-gates";
import {
  expectCode,
  mutatedDecision,
  summary,
} from "./stability-gates.test-support";

describe("stability quality and compression gates", () => {
  it("rejects compacted recall below 100%", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.retention.aggregate.accuracy = 0.875;
      candidate.retention.aggregate.correct = 7;
      candidate.retention.byScenario[0].accuracy = 0.75;
      candidate.retention.byScenario[0].correct = 3;
      candidate.retention.byCategory[0].accuracy = 0.75;
      candidate.retention.byCategory[0].correct = 3;
    });

    expectCode(decision, "RECALL_BELOW_REQUIRED");
    expect(decision.failures).toContainEqual({
      code: "RECALL_BELOW_REQUIRED",
      payload: {
        actual: 0.875,
        correct: 7,
        required: 1,
        scope: "aggregate",
        total: 8,
      },
    });
  });

  it("rejects any per-hop maximum ratio at or above one", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.compression.byHop[1].ratio.max = 1;
    });

    expectCode(decision, "HOP_RATIO_NOT_BELOW_ONE");
    expect(decision.failures).toContainEqual({
      code: "HOP_RATIO_NOT_BELOW_ONE",
      payload: { actual: 1, hop: 2, requiredBelow: 1 },
    });
  });

  it("rejects aggregate mean ratio regression above +0.05", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.compression.ratio.mean = 0.36;
    });

    expectCode(decision, "AGGREGATE_MEAN_RATIO_REGRESSION");
    expect(decision.failures).toContainEqual({
      code: "AGGREGATE_MEAN_RATIO_REGRESSION",
      payload: {
        baseline: 0.3,
        candidate: 0.36,
        delta: 0.06,
        maximumDelta: 0.05,
      },
    });
  });

  it("rejects scenario mean ratio regression above +0.10", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.compression.byScenario[1].ratio.mean = 0.41;
    });

    expectCode(decision, "SCENARIO_MEAN_RATIO_REGRESSION");
    expect(decision.failures).toContainEqual({
      code: "SCENARIO_MEAN_RATIO_REGRESSION",
      payload: {
        baseline: 0.3,
        candidate: 0.41,
        delta: 0.11,
        maximumDelta: 0.1,
        scenario: "lifecycle",
      },
    });
  });

  it("passes exact delta limits while keeping every hop strictly below one", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.compression.ratio.mean = 0.35;
      candidate.compression.byScenario[1].ratio.mean = 0.4;
      candidate.compression.byHop[1].ratio.max = 0.999_999;
    });

    expect(decision).toEqual({ failures: [], passed: true });
  });

  it("rejects new disagreement fingerprints", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.retention.disagreements.push({
        arm: "compacted",
        category: "exact-recall",
        count: 1,
        fingerprint: "sha256:new-disagreement",
        scenario: "baseline",
      });
    });

    expectCode(decision, "DISAGREEMENT_DRIFT");
  });

  it("passes a stable candidate", () => {
    expect(evaluateStabilityComparison(summary(), summary())).toEqual({
      failures: [],
      passed: true,
    });
  });
});
