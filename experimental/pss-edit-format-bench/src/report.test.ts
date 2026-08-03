import { describe, expect, it } from "vitest";
import { type Attempt, buildReport } from "./report";

const STANDARD_ERROR_COLUMN = /\bse\b/u;
const CONFIDENCE_INTERVAL_COLUMN = /95% ci/iu;
const FORMAT_DELTA = /a vs b/u;
const FINGERPRINT = /fingerprint/iu;
const SCORED_ATTEMPTS = /3\/4/u;
const PASS_RATE = /75\.0%/u;
const FIRST_SHOT_COLUMN = /first-shot/iu;
const REPEATED_FAILURE_COLUMN = /repeated-failure/iu;
const FORMAT_ROW = /m1 \| a/u;
const RECOVERED_COUNT = /2\/2/u;
const REPEATED_FAILURE_COUNT = /1\/1/u;

const attempt = (
  overrides: Partial<Attempt> &
    Pick<Attempt, "model" | "format" | "task" | "run" | "passed">
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
  attempt({
    model: "m1",
    format: "a",
    task: "t2",
    run: 1,
    passed: false,
    failure: "unparsable: x",
  }),
  attempt({ model: "m1", format: "a", task: "t2", run: 2, passed: true }),
  attempt({
    model: "m1",
    format: "b",
    task: "t1",
    run: 1,
    passed: false,
    failure: "unparsable: y",
  }),
  attempt({ model: "m1", format: "b", task: "t1", run: 2, passed: true }),
  attempt({ model: "m1", format: "b", task: "t2", run: 1, passed: true }),
  attempt({ model: "m1", format: "b", task: "t2", run: 2, passed: true }),
  attempt({
    model: "m1",
    format: "a",
    task: "t1",
    passed: false,
    failure: "request: timeout",
    fingerprint: null,
    run: 3,
  }),
];

describe("buildReport", () => {
  const report = buildReport(sampleAttempts, ["m1"]);

  it("prints per-cell standard error and CI columns", () => {
    expect(report).toMatch(STANDARD_ERROR_COLUMN);
    expect(report).toMatch(CONFIDENCE_INTERVAL_COLUMN);
  });

  it("prints a paired format delta section", () => {
    expect(report).toContain("## Paired format deltas");
    expect(report).toMatch(FORMAT_DELTA);
  });

  it("flags cells whose attempts mix fingerprints", () => {
    const mixed = [
      ...sampleAttempts,
      attempt({
        model: "m1",
        format: "a",
        task: "t2",
        passed: true,
        fingerprint: "fp_two",
        run: 4,
      }),
    ];
    const mixedReport = buildReport(mixed, ["m1"]);
    expect(mixedReport).toContain("fp_two");
    expect(mixedReport).toMatch(FINGERPRINT);
  });

  it("excludes request failures from the scored rate", () => {
    // 4 scored attempts for m1/a: 3 pass 1 fail = 75%, request failure not counted
    expect(report).toMatch(SCORED_ATTEMPTS);
    expect(report).toMatch(PASS_RATE);
  });

  it("renders a recovery section with first-shot, recovered, and repeated-failure columns", () => {
    const withRecovery: readonly Attempt[] = [
      attempt({
        model: "m1",
        format: "a",
        task: "t1",
        run: 1,
        passed: true,
        recovery: {
          attemptsUsed: 1,
          recovered: true,
          firstAttemptFailed: false,
          repeatedFailure: false,
        },
      }),
      attempt({
        model: "m1",
        format: "a",
        task: "t2",
        run: 1,
        passed: true,
        recovery: {
          attemptsUsed: 2,
          firstAttemptFailed: true,
          recovered: true,
          repeatedFailure: false,
        },
      }),
      attempt({
        model: "m1",
        format: "b",
        task: "t1",
        run: 1,
        passed: false,
        failure: "unparsable: x",
        recovery: {
          attemptsUsed: 3,
          firstAttemptFailed: true,
          recovered: false,
          repeatedFailure: true,
        },
      }),
    ];
    const recoveryReport = buildReport(withRecovery, ["m1"]);
    expect(recoveryReport).toContain("## Recovery by model and format");
    expect(recoveryReport).toMatch(FIRST_SHOT_COLUMN);
    expect(recoveryReport).toMatch(REPEATED_FAILURE_COLUMN);
    expect(recoveryReport).toMatch(FORMAT_ROW);
    expect(recoveryReport).toMatch(RECOVERED_COUNT); // recovered 2 of 2 for m1/a
    expect(recoveryReport).toMatch(REPEATED_FAILURE_COUNT); // repeated failure 1 of 1 for m1/b
  });

  it("omits the recovery section when no attempt carries recovery data", () => {
    expect(report).not.toContain("## Recovery by model and format");
  });

  it("renders a cumulative pass-rate ladder by attempt", () => {
    const withRecovery: readonly Attempt[] = [
      attempt({
        model: "m1",
        format: "a",
        task: "t1",
        run: 1,
        passed: true,
        recovery: {
          attemptsUsed: 1,
          recovered: true,
          firstAttemptFailed: false,
          repeatedFailure: false,
        },
      }),
      attempt({
        model: "m1",
        format: "a",
        task: "t2",
        run: 1,
        passed: true,
        recovery: {
          attemptsUsed: 2,
          recovered: true,
          firstAttemptFailed: true,
          repeatedFailure: false,
        },
      }),
      attempt({
        model: "m1",
        format: "a",
        task: "t3",
        run: 1,
        passed: false,
        failure: "unparsable: x",
        recovery: {
          attemptsUsed: 3,
          recovered: false,
          firstAttemptFailed: true,
          repeatedFailure: true,
        },
      }),
    ];
    const cumulativeReport = buildReport(withRecovery, ["m1"]);
    expect(cumulativeReport).toContain("## Cumulative pass rate by attempt");
    expect(cumulativeReport).toContain("attempt 1");
    expect(cumulativeReport).toContain("attempt 2");
    expect(cumulativeReport).toContain("attempt 3");
    expect(cumulativeReport).toContain("1/3"); // solved within 1 attempt
    expect(cumulativeReport).toContain("2/3"); // solved within 2 attempts
    expect(cumulativeReport).toContain("3/3"); // all scored solved within 3 attempts
  });
});
