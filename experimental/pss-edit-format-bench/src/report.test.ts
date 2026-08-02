import { describe, expect, it } from "vitest";
import { buildReport, type Attempt } from "./report";

const attempt = (
  overrides: Partial<Attempt> & Pick<Attempt, "model" | "format" | "task" | "run" | "passed">
): Attempt => ({
  durationMs: 1000,
  failure: undefined,
  fingerprint: "fp_one",
  outputTokens: 100,
  replyChars: 80,
  retries: 0,
  tolerances: [],
  ...overrides,
});

const sampleAttempts: readonly Attempt[] = [
  attempt({ model: "m1", format: "a", task: "t1", run: 1, passed: true }),
  attempt({ model: "m1", format: "a", task: "t1", run: 2, passed: true }),
  attempt({ model: "m1", format: "a", task: "t2", run: 1, passed: false, failure: "unparsable: x" }),
  attempt({ model: "m1", format: "a", task: "t2", run: 2, passed: true }),
  attempt({ model: "m1", format: "b", task: "t1", run: 1, passed: false, failure: "unparsable: y" }),
  attempt({ model: "m1", format: "b", task: "t1", run: 2, passed: true }),
  attempt({ model: "m1", format: "b", task: "t2", run: 1, passed: true }),
  attempt({ model: "m1", format: "b", task: "t2", run: 2, passed: true }),
  attempt({ model: "m1", format: "a", task: "t1", passed: false, failure: "request: timeout", fingerprint: null, run: 3 }),
];

describe("buildReport", () => {
  const report = buildReport(sampleAttempts, ["m1"]);

  it("prints per-cell standard error and CI columns", () => {
    expect(report).toMatch(/\bse\b/u);
    expect(report).toMatch(/95% ci/iu);
  });

  it("prints a paired format delta section", () => {
    expect(report).toContain("## Paired format deltas");
    expect(report).toMatch(/a vs b/u);
  });

  it("flags cells whose attempts mix fingerprints", () => {
    const mixed = [
      ...sampleAttempts,
      attempt({ model: "m1", format: "a", task: "t2", passed: true, fingerprint: "fp_two", run: 4 }),
    ];
    const mixedReport = buildReport(mixed, ["m1"]);
    expect(mixedReport).toContain("fp_two");
    expect(mixedReport).toMatch(/fingerprint/iu);
  });

  it("excludes request failures from the scored rate", () => {
    // 4 scored attempts for m1/a: 3 pass 1 fail = 75%, request failure not counted
    expect(report).toMatch(/3\/4/u);
    expect(report).toMatch(/75\.0%/u);
  });
});
