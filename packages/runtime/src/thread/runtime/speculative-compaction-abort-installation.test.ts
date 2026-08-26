import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import { context, message } from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
  it("throws after an aborted summary resolves while its candidate still installs", async () => {
    const controller = new AbortController();
    let resolveSummary: (summary: string) => void = () => {
      throw new TypeError("summary promise was not initialized");
    };
    const summaryPromise = new Promise<string>((resolve) => {
      resolveSummary = resolve;
    });
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockReturnValueOnce(summaryPromise)
      .mockResolvedValueOnce("fresh summary");
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

    const pending = compaction(
      context(preparedHistory, summarize, {
        signal: controller.signal,
      })
    );
    expect(summarize).toHaveBeenCalledTimes(1);
    controller.abort();
    resolveSummary("late summary");
    await expect(Promise.resolve(pending)).rejects.toMatchObject({
      name: "AbortError",
    });
    const promoted = await compaction(
      context([...preparedHistory, message("tail")], summarize)
    );

    expect(promoted?.summary).toBe("late summary");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it.each(["transformed", "unknown"] as const)(
    "does not reuse a candidate prepared with %s provenance",
    async (modelContextProvenance) => {
      let phase: "prepare" | "promote" = "prepare";
      const summarize = vi.fn<AgentCompactionContext["summarize"]>(async () =>
        phase === "prepare" ? "unsafe prepared" : "fresh standard"
      );
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
      await compaction(
        context(preparedHistory, summarize, { modelContextProvenance })
      );
      phase = "promote";

      const promoted = await compaction(
        context([...preparedHistory, message("tail")], summarize, {
          modelContextProvenance: "standard",
          reason: "overflow",
        })
      );

      expect(promoted?.summary).toBe("fresh standard");
      expect(summarize).toHaveBeenCalledTimes(1);
    }
  );

  it("does not reuse a candidate when an attachment hydrates to different bytes", async () => {
    const attachmentReference: ModelMessage = {
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
    const hydratedAttachment = (data: readonly number[]): ModelMessage => ({
      content: [
        {
          data: new Uint8Array(data),
          filename: "payload.bin",
          mediaType: "application/octet-stream",
          type: "file",
        },
      ],
      role: "user",
    });
    const rawHistory = [
      attachmentReference,
      message("1", "assistant"),
      message("2"),
      message("3", "assistant"),
      message("4"),
      message("5", "assistant"),
    ];
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("summary of old private attachment")
      .mockResolvedValueOnce("fresh summary");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });
    const preparedHydration = [
      hydratedAttachment([1, 2, 3]),
      ...rawHistory.slice(1),
    ];
    await compaction(
      context(rawHistory, summarize, {
        estimatedHistory: preparedHydration,
        modelContext: preparedHydration,
      })
    );
    const promotedRawHistory = [...rawHistory, message("tail")];
    const currentHydration = [
      hydratedAttachment([9, 9, 9]),
      ...rawHistory.slice(1),
      message("tail"),
    ];

    const promoted = await compaction(
      context(promotedRawHistory, summarize, {
        estimatedHistory: currentHydration,
        modelContext: currentHydration,
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("fresh summary");
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("does not restore a stale predecessor when its replacement aborts", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("generation A")
      .mockResolvedValueOnce("generation B")
      .mockResolvedValueOnce("fresh retry");
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });
    const generationA = Array.from({ length: 6 }, (_, index) =>
      message(`A-${index}`, index % 2 === 0 ? "user" : "assistant")
    );
    const generationB = Array.from({ length: 6 }, (_, index) =>
      message(`B-${index}`, index % 2 === 0 ? "user" : "assistant")
    );
    await compaction(context(generationA, summarize));
    const replacementEpisode = new AbortController();
    await compaction(
      context(generationB, summarize, {
        signal: replacementEpisode.signal,
      })
    );
    replacementEpisode.abort();

    const promoted = await compaction(
      context([...generationA, message("tail")], summarize, {
        reason: "overflow",
      })
    );

    expect(promoted?.summary).toBe("fresh retry");
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("preserves a prepared candidate when its selected promotion aborts before commit", async () => {
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("unexpected fresh");
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
    await compaction(context(preparedHistory, summarize));
    const promotedHistory = [...preparedHistory, message("tail")];
    const abortedEpisode = new AbortController();

    const selected = await compaction(
      context(promotedHistory, summarize, {
        reason: "overflow",
        signal: abortedEpisode.signal,
      })
    );
    expect(selected?.summary).toBe("prepared");
    abortedEpisode.abort();
    const retried = await compaction(
      context(promotedHistory, summarize, { reason: "overflow" })
    );

    expect(retried?.summary).toBe("prepared");
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
