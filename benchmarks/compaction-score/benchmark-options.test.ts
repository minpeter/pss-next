import { describe, expect, it } from "vitest";
import { BENCHMARK_HELP, parseBenchmarkOptions } from "./benchmark-options";

describe("benchmark options", () => {
  it("preserves score defaults and adds safe campaign defaults", () => {
    expect(
      parseBenchmarkOptions([], new Date("2026-07-24T01:02:03.000Z"))
    ).toEqual({
      fixtures: 3,
      maxAttempts: 3,
      omitSummarySeed: false,
      outputDir: "/tmp/compaction-score-2026-07-24T01-02-03.000Z",
      preflightOnly: false,
      providerLabel: "custom",
      seed: "compaction-score-v2",
      summaryMaxOutputTokens: 1024,
      trials: 2,
    });
  });

  it("parses provider label and preflight-only without changing score flags", () => {
    expect(
      parseBenchmarkOptions([
        "--provider-label",
        "gateway-a",
        "--preflight-only",
        "--omit-summary-seed",
        "--fixtures",
        "4",
      ])
    ).toMatchObject({
      fixtures: 4,
      omitSummarySeed: true,
      preflightOnly: true,
      providerLabel: "gateway-a",
      summaryMaxOutputTokens: 1024,
      trials: 2,
    });
  });

  it("documents both campaign flags", () => {
    expect(BENCHMARK_HELP).toContain("--provider-label");
    expect(BENCHMARK_HELP).toContain("--preflight-only");
  });
});
