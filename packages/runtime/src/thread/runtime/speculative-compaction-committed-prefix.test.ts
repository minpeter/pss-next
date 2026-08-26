import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import {
  committedProjection,
  context,
  message,
} from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
  it("reuses a candidate with an attachment-bearing standard projection", async () => {
    const summarize = vi.fn(async () => "summary");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });
    const rawAttachment: ModelMessage = {
      content: [
        {
          data: "pss-attachment:?v=1&p=stored",
          filename: "payload.bin",
          mediaType: "application/octet-stream",
          type: "file",
        },
      ],
      role: "user",
    };
    const hydratedAttachment: ModelMessage = {
      content: [
        {
          data: new Uint8Array([1, 2, 3]),
          filename: "payload.bin",
          mediaType: "application/octet-stream",
          type: "file",
        },
      ],
      role: "user",
    };
    const rawHistory = [
      rawAttachment,
      message("1", "assistant"),
      message("2"),
      message("3", "assistant"),
      message("4"),
      message("5", "assistant"),
    ];
    const estimatedHistory = [hydratedAttachment, ...rawHistory.slice(1)];

    await compaction(
      context(rawHistory, summarize, {
        estimatedHistory,
        modelContext: estimatedHistory,
      })
    );
    const promoted = await compaction(
      context([...rawHistory, message("tail")], summarize, {
        estimatedHistory: [...estimatedHistory, message("tail")],
        modelContext: [...estimatedHistory, message("tail")],
      })
    );

    expect(promoted?.summary).toBe("summary");
    expect(summarize).toHaveBeenCalledTimes(1);
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
});
