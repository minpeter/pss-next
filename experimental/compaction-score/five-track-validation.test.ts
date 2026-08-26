import { describe, expect, it } from "vitest";
import { DEADLINE_SWEEP_SCENARIOS } from "./deadline-sweep-types";
import {
  validateDeadlineSweepArtifact,
  validateFiveTrackReport,
} from "./five-track-validation";
import { validateHumanCalibrationReport } from "./human-calibration-report-validation";

describe("five-track input validation", () => {
  it("accepts a complete live deadline report and rejects missing cells", () => {
    const report = deadlineFixture();
    expect(() => validateDeadlineSweepArtifact(report)).not.toThrow();

    report.arms["10000"].cells = 59;
    expect(() => validateDeadlineSweepArtifact(report)).toThrow(
      "Deadline arm 10000 is invalid"
    );
  });

  it("validates actual-human provenance and confidence coverage", () => {
    const report = humanFixture();
    expect(() => validateHumanCalibrationReport(report)).not.toThrow();

    report.packetContentDigest = "wrong";
    expect(() => validateHumanCalibrationReport(report)).toThrow(
      "provenance is invalid"
    );
  });

  it("forbids a top-level aggregate score", () => {
    const report = fiveTrackFixture();

    expect(() => validateFiveTrackReport(report)).not.toThrow();
    expect(() =>
      validateFiveTrackReport({ ...report, aggregateScore: 1 })
    ).toThrow("identity is invalid");
  });

  it("rejects mixed input modes", () => {
    const report = fiveTrackFixture();
    report.inputs.quality.mode = "deterministic";

    expect(() => validateFiveTrackReport(report)).toThrow(
      "input compatibility is invalid"
    );
  });

  it("rejects mixed input models", () => {
    const report = fiveTrackFixture();
    report.inputs.task.model = "other-model";

    expect(() => validateFiveTrackReport(report)).toThrow(
      "input compatibility is invalid"
    );
  });
});

function fiveTrackFixture() {
  const hash = `sha256:${"a".repeat(64)}`;
  const receipt = `sha256:${"b".repeat(64)}`;
  return {
    inputs: {
      deadline: {
        mode: "live",
        model: "test-model",
        receiptSha256: null,
        sha256: hash,
        status: "measured",
      },
      human: {
        mode: null,
        model: null,
        receiptSha256: null,
        sha256: hash,
        status: "measured",
      },
      production: {
        mode: "live",
        model: "test-model",
        receiptSha256: receipt,
        sha256: hash,
        status: "measured",
      },
      quality: {
        mode: "live",
        model: "test-model",
        receiptSha256: receipt,
        sha256: hash,
        status: "measured",
      },
      task: {
        mode: "live",
        model: "test-model",
        receiptSha256: receipt,
        sha256: hash,
        status: "measured",
      },
    },
    methodology: {
      aggregateScore: "forbidden",
      qualityOutputBudgetEnforcement:
        "local-four-characters-per-token-hard-cap",
    },
    schemaVersion: "five-track-report-v1",
  };
}

function deadlineFixture() {
  const deadlines = [5000, 10_000, 15_000, 20_000];
  const arms: Record<string, Record<string, unknown>> = {};
  for (const deadline of deadlines) {
    arms[String(deadline)] = {
      attemptErrors: 0,
      cells: deadline === 5000 ? 6 : 60,
      completed: deadline === 5000 ? 6 : 60,
      finiteLatencies: true,
      pathPolicy: deadline === 5000 ? "legacy-unverified" : "required",
      typedTimeouts: true,
      uniqueCells: deadline === 5000 ? 6 : 60,
    };
  }
  const scenarios = Object.fromEntries(
    DEADLINE_SWEEP_SCENARIOS.map((scenario) => [
      scenario,
      Object.fromEntries(
        deadlines.map((deadline) => [
          String(deadline),
          {
            attemptErrors: 0,
            attempts: deadline === 5000 ? 1 : 10,
            completed: deadline === 5000 ? 1 : 10,
          },
        ])
      ),
    ])
  );
  const pareto = Object.fromEntries(
    DEADLINE_SWEEP_SCENARIOS.map((scenario) => [scenario, [10_000, 15_000]])
  );
  const historicalPareto = Object.fromEntries(
    DEADLINE_SWEEP_SCENARIOS.map((scenario) => [
      scenario,
      ["10000ms", "historical-uncapped"],
    ])
  );
  const inputEvidence = Object.fromEntries(
    deadlines.map((deadline) => [
      String(deadline),
      {
        artifactSha256: `sha256:${"a".repeat(64)}`,
        receiptPolicy:
          deadline === 5000 ? "legacy-unverified" : "exact-live-command",
        receiptSha256: deadline === 5000 ? null : `sha256:${"b".repeat(64)}`,
        source: `/tmp/${deadline}.json`,
      },
    ])
  );
  return {
    arms,
    deadlinesMs: deadlines,
    historical: { sha256: "a".repeat(64) },
    historicalPareto,
    inputEvidence,
    methodology: {
      bootstrapIterations: 10_000,
      bootstrapSeed: 15_081,
      pairedResampling: "whole-scenario-repetition-cells",
      rateInterval: "wilson-95",
    },
    mode: "live",
    model: "test",
    paired: [{}],
    pareto,
    scenarios,
    schemaVersion: "deadline-sweep-v1",
  };
}

function humanFixture() {
  return {
    annotatorIds: ["human:test"],
    calibrationByConfidence: [{ accuracy: 1, confidence: 5, count: 2 }],
    confusion: {
      falseNegative: 0,
      falsePositive: 0,
      trueNegative: 0,
      truePositive: 2,
    },
    humanFixtureAgreement: 1,
    humanFixtureWilson95: [0.34, 1],
    interRaterKappa: null,
    labelCount: 2,
    labelsContentDigest: `sha256:${"b".repeat(64)}`,
    labeledAtUtcRange: ["2026-08-15T00:00:00.000Z", "2026-08-15T00:01:00.000Z"],
    packetContentDigest: `sha256:${"a".repeat(64)}`,
    protocolVersion: "human-calib-v2",
    provenancePolicy: "declared-actual-human-no-automation",
    semanticAgreement: 1,
    semanticWilson95: [0.34, 1],
    sessionIds: ["s1"],
    schemaVersion: "human-calibration-v1",
  };
}
