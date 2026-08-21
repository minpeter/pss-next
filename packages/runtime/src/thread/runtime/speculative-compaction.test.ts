import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import {
  type AgentCompactionContext,
  DEFAULT_COMPACTION_DEADLINE_MS,
} from "./auto-compaction-types";
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

function committedProjection(
  record: ThreadCompactionRecord,
  history: readonly ModelMessage[]
): Partial<AgentCompactionContext> {
  return {
    compactions: [record],
    modelContext: [
      compactionContextForModel(compactionContextMessage(record)),
      ...history.slice(record.endSeqExclusive),
    ],
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

    expect(compaction.deadlineMs?.()).toBe(DEFAULT_COMPACTION_DEADLINE_MS);
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

  it("retains the last valid candidate after one failed replacement attempt", async () => {
    const ranges: {
      readonly endSeqExclusive: number;
      readonly startSeq: number;
    }[] = [];
    const summarize = vi.fn<AgentCompactionContext["summarize"]>((range) => {
      ranges.push(range);
      return Promise.resolve(ranges.length === 1 ? "prepared" : "   ");
    });
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
    expect(ranges[1]?.endSeqExclusive).toBeGreaterThan(
      ranges[0]?.endSeqExclusive ?? Number.POSITIVE_INFINITY
    );
    expect(promoted).toEqual({ ...ranges[0], summary: "prepared" });
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
          entry.content.includes("compacted into")
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

  it("promotes a candidate prepared after a committed prefix compaction", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("hop1")
      .mockResolvedValueOnce("hop2")
      .mockResolvedValueOnce("unexpected");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.1,
    });
    const history = Array.from({ length: 12 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    expect(
      await compaction(context(history.slice(0, 6), summarize))
    ).toBeUndefined();
    const hop1 = await compaction(context(history.slice(0, 8), summarize));
    expect(hop1).toEqual({
      endSeqExclusive: 4,
      startSeq: 0,
      summary: "hop1",
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    const record: ThreadCompactionRecord = {
      endSeqExclusive: 4,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: "hop1", role: "system" },
    };
    const prepared = history.slice(0, 7);
    const promotedHistory = history.slice(0, 8);

    expect(
      await compaction(
        context(prepared, summarize, committedProjection(record, prepared))
      )
    ).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(2);
    const hop2 = await compaction(
      context(
        promotedHistory,
        summarize,
        committedProjection(record, promotedHistory)
      )
    );

    expect(hop2).toEqual({ endSeqExclusive: 6, startSeq: 0, summary: "hop2" });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("reuses a candidate prepared after a committed prefix compaction on overflow", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("hop1")
      .mockResolvedValueOnce("hop2")
      .mockResolvedValueOnce("unexpected");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.1,
    });
    const history = Array.from({ length: 10 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    expect(
      await compaction(context(history.slice(0, 6), summarize))
    ).toBeUndefined();
    await compaction(context(history.slice(0, 8), summarize));
    const record: ThreadCompactionRecord = {
      endSeqExclusive: 4,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: "hop1", role: "system" },
    };
    const prepared = history.slice(0, 7);
    expect(
      await compaction(
        context(prepared, summarize, committedProjection(record, prepared))
      )
    ).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(2);

    const promoted = await compaction(
      context(history, summarize, {
        ...committedProjection(record, history),
        reason: "overflow",
      })
    );

    expect(promoted).toEqual({
      endSeqExclusive: 6,
      startSeq: 0,
      summary: "hop2",
    });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("refuses reuse when a hook transformed the compacted model context", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("hop1")
      .mockResolvedValueOnce("hop2")
      .mockResolvedValueOnce("overflow");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.1,
    });
    const history = Array.from({ length: 10 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    expect(
      await compaction(context(history.slice(0, 6), summarize))
    ).toBeUndefined();
    await compaction(context(history.slice(0, 8), summarize));
    const record: ThreadCompactionRecord = {
      endSeqExclusive: 4,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: "hop1", role: "system" },
    };
    const prepared = history.slice(0, 7);
    expect(
      await compaction(
        context(prepared, summarize, committedProjection(record, prepared))
      )
    ).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(2);

    const promoted = await compaction(
      context(history, summarize, {
        compactions: [record],
        modelContext: [
          compactionContextForModel(compactionContextMessage(record)),
          message("hook-injected"),
          ...history.slice(record.endSeqExclusive),
        ],
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("overflow");
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("refuses reuse when wrapper plus tail exceeds the remaining budget", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("hop1")
      .mockResolvedValueOnce("hop2")
      .mockResolvedValueOnce("overflow");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.1,
    });
    const history = Array.from({ length: 10 }, (_, index) =>
      message(String(index), index % 2 === 0 ? "user" : "assistant")
    );

    expect(
      await compaction(context(history.slice(0, 6), summarize))
    ).toBeUndefined();
    await compaction(context(history.slice(0, 8), summarize));
    const record: ThreadCompactionRecord = {
      endSeqExclusive: 4,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: "hop1", role: "system" },
    };
    const prepared = history.slice(0, 7);
    expect(
      await compaction(
        context(prepared, summarize, committedProjection(record, prepared))
      )
    ).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(2);

    const promoted = await compaction(
      context(history, summarize, {
        ...committedProjection(record, history),
        instructionsTokens: 100,
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("overflow");
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("counts fixed instructions and calibrated tail marginals before reuse", async () => {
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
    ];

    const promoted = await compaction(
      context(overflowHistory, summarize, {
        estimatedContextTokens: 120,
        estimatedHistoryMessageTokens: Array.from(
          { length: overflowHistory.length },
          () => 10
        ),
        instructionsTokens: 60,
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("overflow");
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});
