import { describe, expect, it } from "vitest";
import { buildCampaignReport, parseCampaignReport } from "./campaign-report";

describe("campaign report contract", () => {
  it("derives the aggregate verdict from scenarios and cleanup", () => {
    const report = buildCampaignReport({
      cleanup: {
        passed: true,
        receiptPath: "/var/tmp/campaign-cleanup.txt",
      },
      command: "real-agent",
      runId: "run-1",
      scenarios: [
        {
          name: "tool-restart",
          observables: { sideEffectCount: 1 },
          violations: [],
        },
        {
          name: "input-ordering",
          observables: { duplicateTerminalEffects: 0 },
          violations: ["model-visible order mismatch"],
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([
      "input-ordering: model-visible order mismatch",
    ]);
    expect(report.scenarios.map((scenario) => scenario.passed)).toEqual([
      true,
      false,
    ]);
  });

  it("rejects non-finite observables at the report boundary", () => {
    expect(() =>
      parseCampaignReport({
        cleanup: { passed: true, receiptPath: "/tmp/cleanup.txt" },
        command: "profiles",
        passed: true,
        runId: "run-2",
        scenarios: [
          {
            name: "wide",
            observables: { p95: Number.POSITIVE_INFINITY },
            passed: true,
            violations: [],
          },
        ],
        schemaVersion: 1,
        violations: [],
      })
    ).toThrow();
  });
});
