import { describe, expect, it } from "vitest";
import { campaignEvidenceViolations } from "./campaign-report-semantics";

describe("campaign command evidence semantics", () => {
  it("rejects incomplete S3 exactly-once evidence", () => {
    expect(
      campaignEvidenceViolations("s3-faults", "latency", {
        observed: true,
      })
    ).toContain("S3 fault evidence is incomplete");
  });

  it("rejects profile counters that do not fully converge", () => {
    expect(
      campaignEvidenceViolations("profiles", "wide", {
        profile: "wide",
        report: {
          admitted: 10,
          cleanup: { aborted: 0, drained: true, inFlight: 0 },
          completed: 10,
          correct: 9,
          failed: 1,
          incorrect: 0,
        },
      })
    ).toContain("profile evidence did not fully converge");
  });

  it("requires checkpoint and Cloudflare migration observables", () => {
    expect(
      campaignEvidenceViolations("real-agent", "tool-checkpoint-restart", {
        checkpointed: true,
        leaseRecovery: "checkpoint-proven-orphan-release",
        passed: true,
        resumedSameRun: true,
        sideEffectCount: 2,
        terminalResultCount: 1,
      })
    ).toContain("tool checkpoint recovery evidence is incomplete");
    expect(
      campaignEvidenceViolations("chaos", "migration", {
        celldTestFiles: ["src/platform/celld/scheduled-work-migration.test.ts"],
        celldTestsPassed: true,
        cloudflareTestFiles: [
          "src/platform/cloudflare/host/scheduler-contract.test.ts",
          "src/platform/cloudflare/storage/execution/store-transaction.test.ts",
          "src/platform/cloudflare/storage/sqlite/bootstrap.test.ts",
        ],
        cloudflareTestsPassed: false,
      })
    ).toContain("migration regression evidence is incomplete");
  });

  it.each([1, 3])(
    "rejects checkpoint evidence with %i tool executions",
    (toolExecutionCount) => {
      expect(
        campaignEvidenceViolations("real-agent", "tool-checkpoint-restart", {
          checkpointed: true,
          leaseRecovery: "checkpoint-proven-orphan-release",
          passed: true,
          resumedSameRun: true,
          sideEffectCount: 1,
          terminalResultCount: 1,
          toolExecutionCount,
        })
      ).toContain("tool checkpoint recovery evidence is incomplete");
    }
  );

  it("requires exact compaction and large-history observables", () => {
    expect(
      campaignEvidenceViolations("real-agent", "compaction-restart", {
        automaticCompactions: 2,
        continuityMarkers: ["CMP-A", "CMP-B", "CMP-C"],
        manualStatus: "compacted",
        passed: true,
      })
    ).toContain("compaction restart evidence is incomplete");
    expect(
      campaignEvidenceViolations("real-agent", "large-history", {
        chunked: true,
        markers: ["LARGE-00", "LARGE-01", "LARGE-02", "LARGE-03"],
        passed: true,
        payloadBytes: 1,
      })
    ).toContain("large history evidence is incomplete");
  });
});
