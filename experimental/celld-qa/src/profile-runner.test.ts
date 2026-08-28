import { describe, expect, it } from "vitest";
import { PROFILE_PLANS } from "./profile-plans";
import { runProfile } from "./profile-runner";

describe("profile runner", () => {
  it("bounds concurrency and reports binary correctness plus Celld native metrics", async () => {
    let active = 0;
    let maxActive = 0;
    let sample = 0;
    const report = await runProfile({
      clock: { now: () => 10 },
      fetchRequest: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { correct: request.index !== 3 };
      },
      plan: { ...PROFILE_PLANS.hot, concurrency: 2, requestCount: 5 },
      processSampler: async () => ({
        cpuSystemTicks: sample,
        cpuUserTicks: sample++,
        kind: "celld-native",
        maxRssBytes: sample * 10,
        openFiles: sample,
      }),
    });

    expect(maxActive).toBe(2);
    expect(report).toMatchObject({
      admitted: 5,
      cleanup: { drained: true, inFlight: 0 },
      completed: 5,
      correct: 4,
      incorrect: 1,
    });
    expect(report.processMetrics).toMatchObject({
      kind: "celld-native",
      cpuUserTicks: 1,
    });
  });

  it("does not label Docker launcher observations as Celld native metrics", async () => {
    const report = await runProfile({
      clock: { now: () => 0 },
      fetchRequest: () => Promise.resolve({ correct: true }),
      plan: { ...PROFILE_PLANS.hot, requestCount: 1 },
      processSampler: () =>
        Promise.resolve({
          cpuSystemTicks: 0,
          cpuUserTicks: 0,
          kind: "docker-launcher",
          maxRssBytes: 10,
          openFiles: 2,
        }),
    });
    expect(report.processMetrics?.kind).toBe("docker-launcher");
  });

  it("stops soak admission at 1800000ms and aborts at the bounded drain deadline", async () => {
    let now = 0;
    let releaseDrain: (() => void) | undefined;
    const waitUntil = () =>
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    const reportPromise = runProfile({
      clock: { now: () => now },
      fetchRequest: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ correct: false }));
          now = 1_800_000;
        }),
      plan: { ...PROFILE_PLANS.soak, concurrency: 1 },
      waitUntil,
    });
    await Promise.resolve();
    now = 1_920_000;
    releaseDrain?.();
    const report = await reportPromise;

    expect(report.admitted).toBe(1);
    expect(report.cleanup).toEqual({ aborted: 1, drained: false, inFlight: 1 });
  });

  it("stops admitting requests when the live process aborts the profile", async () => {
    const controller = new AbortController();
    let calls = 0;
    const report = await runProfile({
      clock: { now: () => 0 },
      fetchRequest: () => {
        calls += 1;
        controller.abort(new Error("Celld exited"));
        return Promise.resolve({ correct: false });
      },
      plan: { ...PROFILE_PLANS.hot, concurrency: 1, requestCount: 10 },
      signal: controller.signal,
    });

    expect(calls).toBe(1);
    expect(report.admitted).toBe(1);
  });
});
