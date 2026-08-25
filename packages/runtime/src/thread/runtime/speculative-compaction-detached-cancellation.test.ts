import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelContextTokenEstimateInput } from "../../llm/context-gate";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";
import { DETACHED_SUMMARY_BACKSTOP_MS } from "./auto-compaction-types";
import {
  DEADLINE_MS,
  hangingSummaryProvider,
  stateWithHistory,
} from "./speculative-compaction-detached-test-support";

function detachedPolicy(
  summaryOptions: { readonly signal?: AbortSignal } = {}
): AgentCompaction {
  return Object.assign(
    async (context: Parameters<AgentCompaction>[0]) => {
      const summary = await context.summarize(
        { endSeqExclusive: 2, startSeq: 0 },
        { lifetime: "detached", ...summaryOptions }
      );
      return { endSeqExclusive: 2, startSeq: 0, summary };
    },
    {
      deadlineMs: () => DEADLINE_MS,
      estimateTokens: ({ messages }: ModelContextTokenEstimateInput) =>
        messages.length * 10,
    }
  ) satisfies AgentCompaction;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("detached summary cancellation", () => {
  it("cancels detached provider work through an explicit summary signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory("detached-explicit-cancel");
    const { model, provider } = hangingSummaryProvider();
    const explicit = new AbortController();

    const first = compactThreadBlocking({
      compaction: detachedPolicy({ signal: explicit.signal }),
      model,
      state,
      threadKey: "detached-explicit-cancel",
    });
    const settled = expect(first).rejects.toMatchObject({
      name: "CompactionDeadlineExceededError",
    });
    await provider.started.promise;

    explicit.abort(new TypeError("operator cancelled"));
    expect(provider.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await settled;
    expect(provider.called).toBe(1);
    expect(state.compactionSnapshot()).toEqual([]);
  });

  it("aborts a runaway detached summary at the safety backstop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory("detached-backstop");
    const { model, provider } = hangingSummaryProvider();

    const first = compactThreadBlocking({
      compaction: detachedPolicy(),
      model,
      state,
      threadKey: "detached-backstop",
    });
    const settled = expect(first).rejects.toMatchObject({
      name: "CompactionDeadlineExceededError",
    });
    await provider.started.promise;
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await settled;
    expect(provider.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(DETACHED_SUMMARY_BACKSTOP_MS);
    expect(provider.signal?.aborted).toBe(true);
  });

  it("contains a detached provider rejection landing after the episode settled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory("detached-late-rejection");
    const started = createDeferred();
    let rejectSummary: (reason: unknown) => void = () => {
      throw new TypeError("provider failure was not armed");
    };
    const gate = new Promise<never>((_resolve, reject) => {
      rejectSummary = reject;
    });
    const provider = {
      called: 0,
      signal: undefined as AbortSignal | undefined,
    };
    const model = {
      model: createCallbackModel(async ({ signal }) => {
        provider.called += 1;
        provider.signal = signal;
        started.resolve();
        await gate;
        return [assistantMessage("unreachable")];
      }),
    };

    const first = compactThreadBlocking({
      compaction: detachedPolicy(),
      model,
      state,
      threadKey: "detached-late-rejection",
    });
    const settled = expect(first).rejects.toMatchObject({
      name: "CompactionDeadlineExceededError",
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await settled;

    const lateRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      lateRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      rejectSummary(new Error("late provider failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(lateRejections).toEqual([]);
      expect(provider.called).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
