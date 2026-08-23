import { describe, expect, it, vi } from "vitest";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";
import { context, message } from "./speculative-compaction-test-support";

describe("speculativeCompaction", () => {
  it("removes an initial candidate when its preparation episode later aborts", async () => {
    const controller = new AbortController();
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("aborted prepared")
      .mockResolvedValueOnce("fresh retry");
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
      context(preparedHistory, summarize, { signal: controller.signal })
    );

    controller.abort();
    const retried = await compaction(
      context([...preparedHistory, message("tail")], summarize, {
        reason: "overflow",
      })
    );

    expect(retried?.summary).toBe("fresh retry");
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("restores the prior candidate when an installed replacement episode aborts", async () => {
    const replacementController = new AbortController();
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockResolvedValueOnce("aborted replacement");
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
    await compaction(
      context(widened, summarize, {
        signal: replacementController.signal,
      })
    );

    replacementController.abort();
    const promoted = await compaction(
      context([...widened, message("8")], summarize, { reason: "overflow" })
    );

    expect(promoted?.summary).toBe("prepared");
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("does not restore an aborted predecessor when its replacement aborts", async () => {
    const preparedController = new AbortController();
    const replacementController = new AbortController();
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("candidate A")
      .mockResolvedValueOnce("candidate B")
      .mockResolvedValueOnce("fresh overflow");
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
    await compaction(
      context(prepared, summarize, { signal: preparedController.signal })
    );
    const widened = [...prepared, message("6"), message("7", "assistant")];
    await compaction(
      context(widened, summarize, {
        signal: replacementController.signal,
      })
    );

    preparedController.abort();
    replacementController.abort();
    const promoted = await compaction(
      context([...widened, message("8")], summarize, { reason: "overflow" })
    );

    expect(promoted?.summary).toBe("fresh overflow");
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("preserves an existing candidate when promotion fallback is aborted", async () => {
    const controller = new AbortController();
    let resolveFallback: (summary: string) => void = () => {
      throw new TypeError("fallback promise was not initialized");
    };
    const fallback = new Promise<string>((resolve) => {
      resolveFallback = resolve;
    });
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("prepared")
      .mockReturnValueOnce(fallback);
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
    const pending = compaction(
      context(promotedHistory, summarize, {
        modelContextProvenance: "transformed",
        signal: controller.signal,
      })
    );

    controller.abort();
    resolveFallback("late fallback");
    await expect(Promise.resolve(pending)).rejects.toMatchObject({
      name: "AbortError",
    });
    const promoted = await compaction(
      context(promotedHistory, summarize, { reason: "overflow" })
    );

    expect(promoted?.summary).toBe("prepared");
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});
