import { afterEach, describe, expect, it, vi } from "vitest";
import { DETACHED_SUMMARY_BACKSTOP_MS } from "./auto-compaction-types";
import { createCompactionThreadIdentity } from "./compaction-thread-identity";
import { DetachedSummaryJobs } from "./speculative-compaction-detached";
import { context, message } from "./speculative-compaction-test-support";

const range = { endSeqExclusive: 6, startSeq: 0 };
const history = Array.from({ length: 6 }, (_, index) =>
  message(String(index), index % 2 === 0 ? "user" : "assistant")
);

afterEach(() => {
  vi.useRealTimers();
});

describe("DetachedSummaryJobs", () => {
  it("bounds unresolved jobs and releases the oldest without provider settlement", () => {
    const owner = Object.freeze({});
    const jobs = new DetachedSummaryJobs();
    const releases = vi.fn();
    const signals: (AbortSignal | undefined)[] = [];
    const aborted = vi.fn();

    for (let index = 0; index < 33; index += 1) {
      const threadKey = `thread-${index}`;
      jobs.startOrJoin(
        context(
          history,
          vi.fn((_range, options) => {
            signals.push(options?.signal);
            options?.signal?.addEventListener("abort", aborted, { once: true });
            return new Promise<string>(() => undefined);
          }),
          {
            threadIdentity: createCompactionThreadIdentity(owner, threadKey),
            threadKey,
          }
        ),
        range,
        () => ({ install: vi.fn(), release: releases })
      );
    }

    expect(signals).toHaveLength(33);
    expect(signals[0]?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(releases).toHaveBeenCalledTimes(1);
  });

  it("releases an unresolved job when its backstop aborts", async () => {
    vi.useFakeTimers();
    const jobs = new DetachedSummaryJobs();
    const releases = vi.fn();
    const aborted = vi.fn();
    let signal: AbortSignal | undefined;

    jobs.startOrJoin(
      context(
        history,
        vi.fn((_range, options) => {
          signal = options?.signal;
          signal?.addEventListener("abort", aborted, { once: true });
          return new Promise<string>(() => undefined);
        })
      ),
      range,
      () => ({ install: vi.fn(), release: releases })
    );

    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(DETACHED_SUMMARY_BACKSTOP_MS);
    expect(signal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(releases).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and releases a replaced job exactly once across later settlement", async () => {
    vi.useFakeTimers();
    const jobs = new DetachedSummaryJobs();
    const releases = vi.fn();
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: (summary: string) => void = () => {
      throw new TypeError("first summary promise was not initialized");
    };
    const firstSummary = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const first = jobs.startOrJoin(
      context(
        history,
        vi.fn((_range, options) => {
          firstSignal = options?.signal;
          return firstSummary;
        }),
        { modelContext: [{ content: "A", role: "system" }, ...history] }
      ),
      range,
      () => ({ install: vi.fn(), release: releases })
    );

    jobs.startOrJoin(
      context(
        history,
        vi.fn(() => new Promise<string>(() => undefined)),
        {
          modelContext: [{ content: "B", role: "system" }, ...history],
        }
      ),
      range,
      () => ({ install: vi.fn(), release: releases })
    );

    expect(firstSignal?.aborted).toBe(true);
    expect(releases).toHaveBeenCalledTimes(1);
    resolveFirst("late");
    await expect(first.promise).resolves.toBe("late");
    expect(releases).toHaveBeenCalledTimes(1);
  });
});
