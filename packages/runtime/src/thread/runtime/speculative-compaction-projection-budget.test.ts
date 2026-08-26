import { describe, expect, it, vi } from "vitest";
import {
  compactionContextForModel,
  compactionContextMessage,
} from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import {
  committedProjection,
  context,
  message,
} from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
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
        modelContextProvenance: "transformed",
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

  it("refuses completed-turn reuse when a hook transformed the compacted model context", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("hop1")
      .mockResolvedValueOnce("hop2")
      .mockResolvedValueOnce("completed-turn");
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
    const promotedHistory = history.slice(0, 8);
    expect(
      await compaction(
        context(prepared, summarize, committedProjection(record, prepared))
      )
    ).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(2);

    const promoted = await compaction(
      context(promotedHistory, summarize, {
        ...committedProjection(record, promotedHistory),
        modelContext: [
          compactionContextForModel(compactionContextMessage(record)),
          message("hook-injected"),
          ...promotedHistory.slice(record.endSeqExclusive),
        ],
        modelContextProvenance: "transformed",
      })
    );

    expect(promoted?.summary).not.toBe("hop2");
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("refuses completed-turn reuse when wrapper plus tail exceeds the remaining budget", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("hop1")
      .mockResolvedValueOnce("hop2")
      .mockResolvedValueOnce("completed-turn");
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
    const promotedHistory = history.slice(0, 8);
    expect(
      await compaction(
        context(prepared, summarize, committedProjection(record, prepared))
      )
    ).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(2);

    const promoted = await compaction(
      context(promotedHistory, summarize, {
        ...committedProjection(record, promotedHistory),
        instructionsTokens: 100,
      })
    );

    expect(promoted?.summary).not.toBe("hop2");
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
