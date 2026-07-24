import { describe, expect, it } from "vitest";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { runCompactionTrial } from "./trial-runner";

const fixture = buildCompactionFixture("trial-timeout-test");
const providerTimeoutMs = 10;

function rejectWhenAborted(
  options: MockLanguageModelV4CallOptions
): Promise<never> {
  const signal = options.abortSignal;
  if (!signal) {
    return new Promise(() => undefined);
  }
  return new Promise((_, reject) => {
    const rejectWithReason = () => reject(signal.reason);
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

function trialInput(model: ReturnType<typeof createMockLanguageModelV4>) {
  return {
    attempt: 1,
    fixture,
    fixtureSeed: "trial-timeout-test",
    id: "trial-timeout",
    model,
    providerTimeoutMs,
    repetition: 1,
    seed: 42,
    summaryMaxOutputTokens: 768,
  } as const;
}

describe("benchmark provider call timeouts", () => {
  it("classifies a summary call that produces no output instead of hanging", {
    timeout: 1000,
  }, async () => {
    const model = createMockLanguageModelV4(rejectWhenAborted);

    await expect(runCompactionTrial(trialInput(model))).resolves.toMatchObject({
      error: "summary-provider-failure",
      status: "summary-provider-failure",
    });
  });

  it("classifies an evaluation call that produces no output instead of hanging", {
    timeout: 1000,
  }, async () => {
    let calls = 0;
    const model = createMockLanguageModelV4((options) => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(mockLanguageModelV4Text("structured summary"))
        : rejectWhenAborted(options);
    });

    await expect(runCompactionTrial(trialInput(model))).resolves.toMatchObject({
      error: "evaluation-provider-failure",
      status: "evaluation-provider-failure",
    });
    expect(calls).toBe(2);
  });
});
