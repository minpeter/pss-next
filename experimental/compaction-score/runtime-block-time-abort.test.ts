import { describe, expect, it } from "vitest";
import { abortable } from "./runtime-block-time-control";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import { runRuntimeBlockTrial } from "./runtime-block-time-runner";

describe("runtime block-time attempt cancellation", () => {
  it("interrupts active runtime work before rejecting the race", async () => {
    const attempt = new AbortController();
    let interrupted = false;
    const work = abortable(
      new Promise<never>(() => undefined),
      attempt.signal,
      () => {
        interrupted = true;
      }
    );

    attempt.abort(new TypeError("runtime attempt wall timeout"));

    await expect(work).rejects.toThrow("runtime attempt wall timeout");
    expect(interrupted).toBe(true);
  });

  it("aborts an in-flight paired runtime observation", async () => {
    const attempt = new AbortController();
    let logicalNow = 0;
    const advance = (milliseconds: number) => {
      logicalNow += milliseconds;
    };
    const treatment = createDeterministicRuntimeBlockModel(
      "candidate-too-broad-fallback",
      advance
    );
    const control = createDeterministicRuntimeBlockModel(
      "candidate-too-broad-fallback",
      advance
    );

    await expect(
      runRuntimeBlockTrial({
        abortSignal: attempt.signal,
        controlModel: control.model,
        model: treatment.model,
        now: () => logicalNow,
        onTargetStepStart: () =>
          attempt.abort(new TypeError("paired attempt wall timeout")),
        repetition: 1,
        scenario: "candidate-too-broad-fallback",
        treatmentModel: treatment.model,
      })
    ).rejects.toThrow("paired attempt wall timeout");
  });
});
