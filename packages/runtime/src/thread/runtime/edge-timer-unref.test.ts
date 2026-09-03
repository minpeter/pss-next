import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSummaryLifetimeSignal } from "./auto-compaction-summary-lifetime";
import { createCompactionThreadIdentity } from "./compaction-thread-identity";
import { DetachedSummaryJobs } from "./speculative-compaction-detached";
import { context, message } from "./speculative-compaction-test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detached compaction on web timers", () => {
  it("supports numeric timer handles for startup, cancellation, and cleanup", () => {
    const clearTimeoutMock = vi.fn();
    vi.stubGlobal(
      "setTimeout",
      vi.fn(() => 1)
    );
    vi.stubGlobal("clearTimeout", clearTimeoutMock);

    const lifetime = resolveSummaryLifetimeSignal({
      episodeSignal: new AbortController().signal,
      options: { lifetime: "detached" },
    });
    expect(lifetime.signal.aborted).toBe(false);
    lifetime.release();

    const owner = Object.freeze({});
    const releases = vi.fn();
    const jobs = new DetachedSummaryJobs();
    const job = jobs.startOrJoin(
      context(
        [message("history", "user")],
        vi.fn(() => new Promise<string>(() => undefined)),
        {
          threadIdentity: createCompactionThreadIdentity(owner, "edge"),
          threadKey: "edge",
        }
      ),
      { endSeqExclusive: 1, startSeq: 0 },
      () => ({ install: vi.fn(), release: releases })
    );

    job.cancel();

    expect(releases).toHaveBeenCalledTimes(1);
    expect(clearTimeoutMock).toHaveBeenCalledTimes(2);
  });
});
