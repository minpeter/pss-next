import { describe, it } from "vitest";
import { evaluateStabilityComparison } from "./stability-gates";
import {
  expectCode,
  mutatedDecision,
  summary,
} from "./stability-gates.test-support";

describe("stability report validation", () => {
  it("rejects a missing required metric", () => {
    const source = summary();
    const candidate: unknown = {
      retention: source.retention,
      trials: source.trials,
    };

    expectCode(
      evaluateStabilityComparison(summary(), candidate),
      "REPORT_METRIC_MISSING"
    );
  });

  it("fails closed on empty scenario metric arrays", () => {
    const compression = mutatedDecision((candidate) => {
      candidate.compression.byScenario.splice(0);
    });
    const retention = mutatedDecision((candidate) => {
      candidate.retention.byScenario.splice(0);
    });

    expectCode(compression, "REPORT_METRIC_INVALID");
    expectCode(retention, "REPORT_METRIC_INVALID");
  });

  it("rejects an unknown scenario", () => {
    const candidate: unknown = structuredClone(summary());
    const value = candidate as {
      compression: { byScenario: { scenario: string }[] };
      retention: { byScenario: { scenario: string }[] };
    };
    value.compression.byScenario[0].scenario = "unknown-scenario";
    value.retention.byScenario[0].scenario = "unknown-scenario";

    expectCode(
      evaluateStabilityComparison(summary(), candidate),
      "REPORT_SCENARIO_UNKNOWN"
    );
  });

  it("rejects a candidate missing a baseline scenario", () => {
    const decision = mutatedDecision((candidate) => {
      candidate.compression.byScenario.splice(1, 1);
      candidate.retention.byScenario.splice(1, 1);
    });

    expectCode(decision, "REPORT_SCENARIO_MISSING");
  });
});
