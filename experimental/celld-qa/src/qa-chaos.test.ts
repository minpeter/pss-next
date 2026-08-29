import { describe, expect, it } from "vitest";
import { buildChaosScenarios } from "./qa-chaos";

describe("chaos campaign evidence", () => {
  it("keeps Cloudflare regression status independent from Celld tests", () => {
    const scenarios = buildChaosScenarios(
      true,
      true,
      true,
      false,
      "test output"
    );

    expect(scenarios.find((scenario) => scenario.name === "migration")).toEqual(
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
          cloudflareTestsPassed: false,
        },
        violations: ["Cloudflare regression tests failed"],
      }
    );
  });

  it("attributes each Celld test group independently", () => {
    const scenarios = buildChaosScenarios(
      false,
      true,
      true,
      true,
      "test output"
    );

    expect(
      scenarios.find((scenario) => scenario.name === "alarm-boundaries")
        ?.violations
    ).toEqual(["scheduler chaos tests failed"]);
    expect(
      scenarios.find((scenario) => scenario.name === "ordering")?.violations
    ).toEqual([]);
    expect(
      scenarios.find((scenario) => scenario.name === "migration")?.violations
    ).toEqual([]);
  });
});
