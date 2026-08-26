import { describe, expect, it, vi } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { isCompactionProviderPrompt } from "./runtime-block-time-instrumentation";
import { waitForRuntimeSummaryStart } from "./runtime-deadline-outcome-path";
import { runRuntimeDeadlineTrial } from "./runtime-deadline-outcome-runner";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe("runtime deadline outcomes", () => {
  it("records a typed timeout before provider dispatch", async () => {
    vi.useFakeTimers();
    const targetStarted = deferred();
    const model = createMockLanguageModelV4(async ({ abortSignal, prompt }) => {
      if (!isCompactionProviderPrompt(prompt)) {
        return mockLanguageModelV4Text("DONE");
      }
      return await new Promise((_, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => reject(abortSignal.reason),
          { once: true }
        );
      });
    });

    try {
      const trialPromise = runRuntimeDeadlineTrial({
        deadlineMs: 50,
        model,
        onTargetStepStart: () => targetStarted.resolve(),
        repetition: 1,
        scenario: "candidate-too-broad-fallback",
      });
      await targetStarted.promise;
      await vi.advanceTimersByTimeAsync(50);

      await expect(trialPromise).resolves.toMatchObject({
        candidateApplied: false,
        decisionLatencyMs: 50,
        errorCategory: "timeout",
        errorCode: "COMPACTION_DEADLINE_EXCEEDED",
        outcome: "timeout",
        pathValid: true,
        providerStarted: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds setup when background compaction never starts", async () => {
    vi.useFakeTimers();

    try {
      const wait = waitForRuntimeSummaryStart(
        new Promise<never>(() => undefined),
        50
      );
      const rejected = expect(wait).rejects.toThrow(
        "setup summary did not start within 50ms"
      );
      await vi.advanceTimersByTimeAsync(50);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight attempt through its explicit signal", async () => {
    const attempt = new AbortController();
    const model = createMockLanguageModelV4(async ({ prompt }) =>
      isCompactionProviderPrompt(prompt)
        ? await new Promise<never>(() => undefined)
        : mockLanguageModelV4Text("DONE")
    );
    const trial = runRuntimeDeadlineTrial({
      abortSignal: attempt.signal,
      deadlineMs: 5000,
      model,
      onTargetStepStart: () =>
        attempt.abort(new TypeError("attempt wall timeout")),
      repetition: 1,
      scenario: "candidate-too-broad-fallback",
    });

    await expect(trial).rejects.toThrow("attempt wall timeout");
  });
});
