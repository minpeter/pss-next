import { describe, expect, it } from "vitest";
import { FAULT_KINDS } from "./fault-proxy-types";
import { runS3FaultCampaign } from "./s3-fault-runner";

describe("S3 fault campaign", () => {
  it("aggregates one binary observable for all eight scenarios", async () => {
    // Given
    const visited: string[] = [];

    // When
    const report = await runS3FaultCampaign((kind) => {
      visited.push(kind);
      return Promise.resolve({
        convergence: true,
        detail: `${kind}:observed`,
        effect: "exactly_once",
        injectionEvidence: true,
        kind,
        observed: true,
        recovery: true,
      });
    });

    // Then
    expect(visited).toEqual(FAULT_KINDS);
    expect(report.ok).toBe(true);
    expect(report.scenarios).toHaveLength(8);
    expect(report.scenarios.every((scenario) => scenario.observed)).toBe(true);
  });

  it("fails the aggregate when one scenario is not observed", async () => {
    // Given / When
    const report = await runS3FaultCampaign((kind) =>
      Promise.resolve({
        convergence: kind !== "reset",
        detail: kind,
        effect: kind === "reset" ? "none" : "exactly_once",
        injectionEvidence: kind !== "reset",
        kind,
        observed: kind !== "reset",
        recovery: kind !== "reset",
      })
    );

    // Then
    expect(report.ok).toBe(false);
    expect(
      report.scenarios.find((scenario) => scenario.kind === "reset")
    ).toMatchObject({ observed: false });
  });
});
