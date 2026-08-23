import { describe, expect, it } from "vitest";
import { runPiArm } from "./compare-pi-arms";
import { describeArm } from "./compare-pi-report";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { stableTrialError } from "./trial-provider-boundary";

const fixture = buildCompactionFixture("compare-pi-failure-redaction");

function expectStableFailure(
  result: Awaited<ReturnType<typeof runPiArm>>,
  status: string,
  secret: string
): void {
  const artifact = JSON.stringify(result);
  const stdout = describeArm(result);
  expect(result).toEqual({ error: status, status });
  expect(artifact).not.toContain(secret);
  expect(artifact).not.toContain("\\u001b");
  expect(stdout).not.toContain(secret);
  expect(stdout).not.toContain("\u001b");
}

describe("pi comparison failures", () => {
  it("classifies protocol failures without retaining provider prose", () => {
    // Given
    const cause = new Error("PI_PROTOCOL_SECRET\u001b[31m");

    // When
    const error = stableTrialError("protocol-failure", cause);

    // Then
    expect(error).toBe("protocol-failure");
  });

  it("redacts provider secrets and terminal controls from summary failures", async () => {
    // Given
    const secret = "PI_SUMMARY_SECRET";
    const model = createMockLanguageModelV4(() =>
      Promise.reject(new Error(`${secret}\u001b[31m`))
    );

    // When
    const result = await runPiArm(fixture, 1, model);

    // Then
    expectStableFailure(result, "summary-provider-failure", secret);
  });

  it("redacts provider secrets and terminal controls from evaluation failures", async () => {
    // Given
    const secret = "PI_EVALUATION_SECRET";
    let call = 0;
    const model = createMockLanguageModelV4(() => {
      call += 1;
      return call === 1
        ? Promise.resolve(mockLanguageModelV4Text("structured summary"))
        : Promise.reject(new Error(`${secret}\u001b[2J`));
    });

    // When
    const result = await runPiArm(fixture, 1, model);

    // Then
    expectStableFailure(result, "evaluation-provider-failure", secret);
  });
});
