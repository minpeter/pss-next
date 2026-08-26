import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import { context, message } from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
  it("promotes a prepared candidate after tail append without summarizing twice", async () => {
    const summarize = vi.fn(async () => "summary");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });
    const preparedHistory = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    expect(
      await compaction(context(preparedHistory, summarize))
    ).toBeUndefined();
    const promoted = await compaction(
      context([...preparedHistory, message("tail")], summarize)
    );

    expect(promoted?.summary).toBe("summary");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("attempts replacement only when the selected range expands", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("replacement");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.9,
      retainRatio: 0.2,
    });
    const prepared = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    await compaction(context(prepared, summarize));
    await compaction(context(prepared, summarize));
    await compaction(
      context(prepared, summarize, {
        estimatedHistoryMessageTokens: prepared.map(() => 5),
      })
    );
    const widened = [...prepared, message("6"), message("7", "assistant")];
    await compaction(context(widened, summarize));
    const promoted = await compaction(
      context([...widened, message("8")], summarize)
    );

    expect(promoted).toEqual({
      endSeqExclusive: 6,
      startSeq: 0,
      summary: "replacement",
    });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("keeps an old candidate eligible until an expanded replacement installs", async () => {
    const controller = new AbortController();
    let resolveAbortedSummary: (summary: string) => void = () => {
      throw new TypeError("aborted summary promise was not initialized");
    };
    const abortedSummary = new Promise<string>((resolve) => {
      resolveAbortedSummary = resolve;
    });
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockReturnValueOnce(abortedSummary)
      .mockRejectedValueOnce(new TypeError("provider failed"))
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("replacement");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.9,
      retainRatio: 0.2,
    });
    const prepared = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    await compaction(context(prepared, summarize));
    const widened = [...prepared, message("6"), message("7", "assistant")];
    const abortedReplacement = compaction(
      context(widened, summarize, { signal: controller.signal })
    );
    expect(summarize).toHaveBeenCalledTimes(2);
    controller.abort();
    resolveAbortedSummary("aborted replacement");
    await expect(Promise.resolve(abortedReplacement)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      Promise.resolve(compaction(context(widened, summarize)))
    ).rejects.toThrow("provider failed");
    await compaction(context(widened, summarize));
    await compaction(context(widened, summarize));
    const promoted = await compaction(
      context([...widened, message("8")], summarize)
    );

    expect(promoted).toEqual({
      endSeqExclusive: 6,
      startSeq: 0,
      summary: "replacement",
    });
    expect(summarize).toHaveBeenCalledTimes(5);
  });

  it("promotes one successful bounded replacement without a third summary", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("replacement")
      .mockResolvedValueOnce("unexpected");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.9,
      retainRatio: 0.2,
    });
    const prepared = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    await compaction(context(prepared, summarize));
    const widened = [...prepared, message("6"), message("7", "assistant")];
    await compaction(context(widened, summarize));
    await compaction(context(widened, summarize));
    const promoted = await compaction(
      context([...widened, message("8")], summarize)
    );

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(promoted?.summary).toBe("replacement");
    expect(promoted?.endSeqExclusive).toBeGreaterThan(2);
  });

  it("discards a candidate when its source prefix changes", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("old summary")
      .mockResolvedValueOnce("new summary");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });
    const history = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );
    await compaction(context(history, summarize));
    const changed = history.map((entry, index) =>
      index === 0 ? message("changed") : entry
    );

    const promoted = await compaction(
      context([...changed, message("tail")], summarize)
    );

    expect(promoted?.summary).toBe("new summary");
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});
