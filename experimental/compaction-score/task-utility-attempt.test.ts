import { describe, expect, it } from "vitest";
import {
  abortableTaskUtilityWork,
  withValidFullControl,
} from "./task-utility-attempt";

describe("task utility attempt cancellation", () => {
  it("rejects on the exact abort signal", async () => {
    const attempt = new AbortController();
    const work = abortableTaskUtilityWork(
      new Promise<never>(() => undefined),
      attempt.signal
    );

    attempt.abort(new TypeError("task arm wall timeout"));

    await expect(work).rejects.toThrow("task arm wall timeout");
  });

  it("retries failed full controls within a bounded attempt count", async () => {
    let attempts = 0;
    const result = await withValidFullControl(3, () => {
      attempts += 1;
      return Promise.resolve({ fullPassed: attempts === 2 });
    });

    expect(result.fullPassed).toBe(true);
    expect(attempts).toBe(2);

    await expect(
      withValidFullControl(3, () => Promise.resolve({ fullPassed: false }))
    ).rejects.toThrow("full-context control failed after 3 attempts");
  });

  it("retries a thrown task-pair attempt", async () => {
    let attempts = 0;
    const result = await withValidFullControl(3, () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("turn-error"))
        : Promise.resolve({ fullPassed: true });
    });

    expect(result.fullPassed).toBe(true);
    expect(attempts).toBe(2);

    let failedAttempts = 0;
    await expect(
      withValidFullControl(3, () => {
        failedAttempts += 1;
        return Promise.reject(new Error("persistent turn-error"));
      })
    ).rejects.toThrow("task pair failed after 3 attempts");
    expect(failedAttempts).toBe(3);
  });
});
