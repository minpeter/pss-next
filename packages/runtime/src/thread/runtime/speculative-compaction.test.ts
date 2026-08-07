import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";

const message = (
  content: string,
  role: "user" | "assistant" = "user"
): ModelMessage => ({ content, role });
const threadIdentity = Object.freeze({});

function context(
  history: readonly ModelMessage[],
  summarize: AgentCompactionContext["summarize"],
  overrides: Partial<AgentCompactionContext> = {}
): AgentCompactionContext {
  return {
    compactions: [],
    estimatedContextTokens: history.length * 10,
    estimatedHistory: history,
    history,
    instructionsTokens: 0,
    modelContext: history,
    reason: "completed-turn",
    signal: new AbortController().signal,
    summarize,
    threadIdentity,
    threadKey: "thread",
    ...overrides,
  };
}

describe("speculativeCompaction", () => {
  it.each([
    { maxInputTokens: 0 },
    { prepareRatio: 0 },
    { promoteRatio: 1 },
    { prepareRatio: 0.9, promoteRatio: 0.8 },
  ])("rejects invalid factory options: %o", (options) => {
    expect(() => speculativeCompaction(options)).toThrow(TypeError);
  });

  it("exposes its budget through the policy surface without an estimator", () => {
    const compaction = speculativeCompaction({ maxInputTokens: 100 });

    expect(compaction.estimateTokens).toBeUndefined();
    expect(compaction.maxInputTokens?.()).toBe(100);
    expect(compaction.onOverflow).toBe("compact");
  });

  it("preserves an explicit token estimator as a complete override", () => {
    const estimateTokens = vi.fn(() => 17);
    const compaction = speculativeCompaction({ estimateTokens });

    expect(
      compaction.estimateTokens?.({
        instructions: "system",
        messages: [message("user")],
      })
    ).toBe(17);
    expect(estimateTokens).toHaveBeenCalledWith([
      { content: "system", role: "system" },
      message("user"),
    ]);
  });

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

  it("keeps one prepared candidate while completed turns remain below promotion", async () => {
    const summarize = vi.fn(async () => "summary");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.2,
    });
    const history = Array.from({ length: 6 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    await compaction(context(history, summarize));
    await compaction(context([...history, message("tail")], summarize));

    expect(summarize).toHaveBeenCalledTimes(1);
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
    await compaction(context(prepared, summarize));
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
});
