import { describe, expect, it } from "vitest";
import type { AgenticAttempt } from "./agentic";
import { buildAgenticReport } from "./agentic-report";

const attempt = (
  task: string,
  fields: Partial<AgenticAttempt>
): AgenticAttempt =>
  ({
    durationMs: 100,
    editCalls: 1,
    editSuccesses: 1,
    failureKind: undefined,
    finalText: "done",
    firstEditPassed: true,
    format: "pss-json",
    inputTokens: 10,
    model: "test-model",
    outputTokens: 5,
    passed: true,
    readCalls: 1,
    recovered: false,
    requestFailure: undefined,
    responseMessagesJson: "[]",
    retryFailures: [],
    run: 1,
    steps: 2,
    task,
    toolEvents: [],
    toolStatus: "succeeded",
    totalTokens: 15,
    transportStatus: "ok",
    verificationDiagnostics: [],
    verificationStatus: "passed",
    ...fields,
  }) as AgenticAttempt;

describe("agentic benchmark report", () => {
  it("separates pass@1 recovery and failure dimensions", () => {
    const report = buildAgenticReport([
      attempt("single-line-to-two", {}),
      attempt("py-dedent-block", {
        failureKind: "tool-failed",
        firstEditPassed: false,
        passed: false,
        toolStatus: "failed",
        verificationStatus: "failed",
      }),
      attempt("large-mid-replace", {
        failureKind: "transport-failed",
        firstEditPassed: false,
        passed: false,
        requestFailure: "timeout",
        toolStatus: "not-called",
        transportStatus: "failed",
        verificationStatus: "not-run",
      }),
    ]);

    expect(report).toContain("| pass@1 | 1/3 |");
    expect(report).toContain("| transport failures | 1 |");
    expect(report).toContain("| tool failures | 1 |");
    expect(report).toContain("## By method");
    expect(report).toContain("## By language");
    expect(report).toContain("## By kind");
    expect(report).toContain("## By difficulty");
  });
});
