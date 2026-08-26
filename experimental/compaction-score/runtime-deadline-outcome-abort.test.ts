import { describe, expect, it } from "vitest";
import { abortableDeadlineWork } from "./runtime-deadline-outcome-runner";

describe("runtime deadline attempt cancellation", () => {
  it("interrupts active work before rejecting the abort race", async () => {
    const attempt = new AbortController();
    let interrupted = false;
    const work = abortableDeadlineWork(
      new Promise<never>(() => undefined),
      attempt.signal,
      () => {
        interrupted = true;
      }
    );

    attempt.abort(new TypeError("deadline attempt wall timeout"));

    await expect(work).rejects.toThrow("deadline attempt wall timeout");
    expect(interrupted).toBe(true);
  });
});
