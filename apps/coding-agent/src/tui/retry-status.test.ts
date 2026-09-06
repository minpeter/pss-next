import { describe, expect, it, vi } from "vitest";
import { createRetryStatus, retryWaitMessage } from "./retry-status";

describe("retryWaitMessage", () => {
  it("names the next physical attempt and the budget including this retry", () => {
    expect(
      retryWaitMessage({ attempt: 1, remainingMs: 4000, remainingRetries: 2 })
    ).toBe("Retrying in 4s · attempt 2 · 2 retries left");
  });

  it("uses the singular budget noun for a final retry", () => {
    expect(
      retryWaitMessage({ attempt: 2, remainingMs: 1000, remainingRetries: 1 })
    ).toBe("Retrying in 1s · attempt 3 · 1 retry left");
  });

  it("rounds a partial second up so the countdown never shows a dead 0s", () => {
    expect(
      retryWaitMessage({ attempt: 1, remainingMs: 1, remainingRetries: 2 })
    ).toBe("Retrying in 1s · attempt 2 · 2 retries left");
  });

  it("drops the countdown once the deadline has passed", () => {
    expect(
      retryWaitMessage({ attempt: 1, remainingMs: 0, remainingRetries: 2 })
    ).toBe("Retrying now · attempt 2 · 2 retries left");
  });

  it("reports the first attempt when the failure preceded any physical call", () => {
    expect(
      retryWaitMessage({ attempt: 0, remainingMs: 2000, remainingRetries: 3 })
    ).toBe("Retrying in 2s · attempt 1 · 3 retries left");
  });
});

const createHarness = () => {
  const messages: Array<string | null> = [];
  let now = 10_000;
  const status = createRetryStatus({
    now: () => now,
    setMessage: (message) => messages.push(message),
  });
  return {
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    messages,
    status,
  };
};

describe("createRetryStatus", () => {
  it("shows the countdown immediately and ticks it down once per second", () => {
    vi.useFakeTimers();
    const h = createHarness();

    h.status.scheduled({
      attempt: 1,
      delayMs: 3000,
      remainingRetries: 2,
      retryAt: 13_000,
    });
    expect(h.messages).toEqual(["Retrying in 3s · attempt 2 · 2 retries left"]);

    h.advance(1000);
    expect(h.messages.at(-1)).toBe(
      "Retrying in 2s · attempt 2 · 2 retries left"
    );

    h.advance(1000);
    expect(h.messages.at(-1)).toBe(
      "Retrying in 1s · attempt 2 · 2 retries left"
    );

    h.status.stop();
    vi.useRealTimers();
  });

  it("clears the status and stops ticking when the wait completes", () => {
    vi.useFakeTimers();
    const h = createHarness();

    h.status.scheduled({
      attempt: 1,
      delayMs: 3000,
      remainingRetries: 2,
      retryAt: 13_000,
    });
    h.status.clear();
    expect(h.messages.at(-1)).toBeNull();

    const settled = h.messages.length;
    h.advance(5000);
    expect(h.messages).toHaveLength(settled);

    h.status.stop();
    vi.useRealTimers();
  });

  it("replaces an in-flight countdown when a later retry is scheduled", () => {
    vi.useFakeTimers();
    const h = createHarness();

    h.status.scheduled({
      attempt: 1,
      delayMs: 4000,
      remainingRetries: 2,
      retryAt: 14_000,
    });
    h.status.scheduled({
      attempt: 2,
      delayMs: 8000,
      remainingRetries: 1,
      retryAt: 18_000,
    });
    expect(h.messages.at(-1)).toBe("Retrying in 8s · attempt 3 · 1 retry left");

    h.advance(1000);
    expect(h.messages.at(-1)).toBe("Retrying in 7s · attempt 3 · 1 retry left");

    h.status.stop();
    vi.useRealTimers();
  });

  it("stops the timer on teardown without emitting a stale clear", () => {
    vi.useFakeTimers();
    const h = createHarness();

    h.status.scheduled({
      attempt: 1,
      delayMs: 3000,
      remainingRetries: 2,
      retryAt: 13_000,
    });
    h.status.stop();

    const settled = h.messages.length;
    h.advance(5000);
    expect(h.messages).toHaveLength(settled);
    vi.useRealTimers();
  });

  it("reports whether a wait is currently active", () => {
    vi.useFakeTimers();
    const h = createHarness();

    expect(h.status.isWaiting()).toBe(false);
    h.status.scheduled({
      attempt: 1,
      delayMs: 3000,
      remainingRetries: 2,
      retryAt: 13_000,
    });
    expect(h.status.isWaiting()).toBe(true);
    h.status.clear();
    expect(h.status.isWaiting()).toBe(false);

    h.status.stop();
    vi.useRealTimers();
  });

  it("holds the deadline message instead of counting into the past", () => {
    vi.useFakeTimers();
    const h = createHarness();

    h.status.scheduled({
      attempt: 1,
      delayMs: 2000,
      remainingRetries: 2,
      retryAt: 12_000,
    });
    h.advance(4000);
    expect(h.messages.at(-1)).toBe("Retrying now · attempt 2 · 2 retries left");

    h.status.stop();
    vi.useRealTimers();
  });
});
