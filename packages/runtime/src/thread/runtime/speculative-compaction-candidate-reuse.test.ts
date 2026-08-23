import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import { context, message } from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
  it("isolates candidates by runtime thread identity even when keys match", async () => {
    const summarizeA = vi.fn(async () => "summary A");
    const summarizeB = vi.fn(async () => "summary B");
    const identityB = Object.freeze({});
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
    await compaction(context(history, summarizeA));

    const promoted = await compaction(
      context([...history, message("tail")], summarizeB, {
        threadIdentity: identityB,
      })
    );

    expect(promoted?.summary).toBe("summary B");
    expect(summarizeA).toHaveBeenCalledTimes(1);
    expect(summarizeB).toHaveBeenCalledTimes(1);
  });

  it("re-summarizes a broader range when an old candidate reaches overflow", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("overflow");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.2,
    });
    const prepared = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );
    await compaction(
      context(prepared, summarize, { estimatedContextTokens: 80 })
    );
    const overflowHistory = [
      ...prepared,
      message("6"),
      message("7", "assistant"),
      message("8"),
      message("9", "assistant"),
    ];

    const promoted = await compaction(
      context(overflowHistory, summarize, { reason: "overflow" })
    );

    expect(promoted?.summary).toBe("overflow");
    expect(promoted?.endSeqExclusive).toBeGreaterThan(2);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("reuses a widened candidate when its full uncovered tail still fits", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("unnecessary overflow");
    const estimateTokens = (messages: readonly ModelMessage[]) =>
      messages.reduce(
        (total, entry) =>
          total +
          (typeof entry.content === "string" &&
          entry.content.includes("<summary>")
            ? 20
            : 10),
        0
      );
    const compaction = speculativeCompaction({
      estimateTokens,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.2,
    });
    const prepared = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );
    await compaction(context(prepared, summarize));
    const overflowHistory = [
      ...prepared,
      message("6"),
      message("7", "assistant"),
    ];

    const promoted = await compaction(
      context(overflowHistory, summarize, {
        estimatedContextTokens: 80,
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("prepared");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("keeps broader fallback when the candidate leaves an oversized tail", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("overflow");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 20,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.2,
    });
    const prepared = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );
    await compaction(
      context(prepared, summarize, { estimatedContextTokens: 60 })
    );
    const overflowHistory = [
      ...prepared,
      message("6"),
      message("7", "assistant"),
      message("8"),
      message("9", "assistant"),
    ];

    const promoted = await compaction(
      context(overflowHistory, summarize, {
        estimatedContextTokens: 160,
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("overflow");
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it.each(["transformed", "unknown"] as const)(
    "refuses candidate reuse when model context provenance is %s",
    async (modelContextProvenance) => {
      const summarize = vi
        .fn<AgentCompactionContext["summarize"]>()
        .mockResolvedValueOnce("prepared")
        .mockResolvedValueOnce("fresh");
      const compaction = speculativeCompaction({
        estimateTokens: (messages) => messages.length * 10,
        maxInputTokens: 100,
        prepareRatio: 0.5,
        promoteRatio: 0.7,
        retainRatio: 0.2,
      });
      const prepared = Array.from({ length: 6 }, (_, index) =>
        message(String(index), index % 2 === 0 ? "user" : "assistant")
      );
      await compaction(context(prepared, summarize));
      const promotedHistory = [...prepared, message("tail")];

      const promoted = await compaction(
        context(promotedHistory, summarize, { modelContextProvenance })
      );

      expect(promoted?.summary).toBe("fresh");
      expect(summarize).toHaveBeenCalledTimes(2);
    }
  );
});
