import { describe, expect, it } from "vitest";
import { buildCampaignReport, parseCampaignReport } from "./campaign-report";

describe("campaign report contract", () => {
  it("derives the aggregate verdict from scenarios and cleanup", () => {
    const report = buildCampaignReport({
      cleanup: {
        passed: true,
        receiptPath: "/var/tmp/campaign-cleanup.txt",
      },
      command: "chaos",
      runId: "run-1",
      scenarios: [
        {
          name: "alarm-boundaries",
          observables: {
            testFiles: [
              "src/platform/durable-object/celld/scheduler-chaos.test.ts",
              "src/platform/durable-object/celld/drainer-chaos.test.ts",
            ],
            testsPassed: true,
          },
          violations: [],
        },
        {
          name: "ordering",
          observables: {
            testFiles: [
              "src/platform/durable-object/celld/scheduler-ordering.test.ts",
            ],
            testsPassed: true,
          },
          violations: ["model-visible order mismatch"],
        },
        {
          name: "migration",
          observables: {
            celldTestFiles: [
              "src/platform/durable-object/celld/scheduled-work-migration.test.ts",
            ],
            celldTestsPassed: true,
            cloudflareTestFiles: [
              "src/platform/durable-object/host/scheduler-contract.test.ts",
              "src/platform/durable-object/storage/execution/store-transaction.test.ts",
              "src/platform/durable-object/storage/sqlite/bootstrap.test.ts",
            ],
            cloudflareTestsPassed: true,
          },
          violations: [],
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([
      "ordering: model-visible order mismatch",
    ]);
    expect(report.scenarios.map((scenario) => scenario.passed)).toEqual([
      true,
      false,
      true,
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

  it("rejects a partial profiles matrix", () => {
    expect(() =>
      buildCampaignReport({
        cleanup: { passed: true, receiptPath: "/tmp/cleanup.txt" },
        command: "profiles",
        runId: "run-profiles",
        scenarios: [
          {
            name: "wide",
            observables: {
              cleanupPassed: true,
              cleanupPath: "/tmp/wide-cleanup.txt",
              profile: "wide",
              report: {
                admitted: 1,
                cleanup: { aborted: 0, drained: true, inFlight: 0 },
                completed: 1,
                correct: 1,
                failed: 0,
                incorrect: 0,
              },
              runId: "wide-run",
            },
            violations: [],
          },
        ],
      })
    ).toThrow("Incomplete profiles scenario matrix");
  });

  it("derives failure when S3 evidence omits exactly-once recovery", () => {
    const names = [
      "latency",
      "timeout",
      "reset",
      "http_500",
      "localstack_restart",
      "throttle_429",
      "read_after_write",
      "conditional_412",
    ];

    const report = buildCampaignReport({
      cleanup: { passed: true, receiptPath: "/tmp/cleanup.txt" },
      command: "s3-faults",
      runId: "run-s3",
      scenarios: names.map((name) => ({
        name,
        observables: { observed: true },
        violations: [],
      })),
    });

    expect(report.passed).toBe(false);
    expect(report.violations).toContain(
      "latency: S3 fault evidence is incomplete"
    );
  });
});
