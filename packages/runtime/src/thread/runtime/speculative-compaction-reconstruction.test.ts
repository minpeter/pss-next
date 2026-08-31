import { describe, expect, it, vi } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import type { AgentCompactionContext } from "./auto-compaction-types";
import { createCompactionThreadIdentity } from "./compaction-thread-identity";
import { speculativeCompaction } from "./speculative-compaction";
import { context, message } from "./speculative-compaction-test-support";

describe("speculative compaction reconstruction", () => {
  it("reuses a prepared candidate after same-owner thread reconstruction", async () => {
    // Given: two reconstructed states for one host-controlled thread key.
    const store = new MemoryThreadStore();
    const owner = Object.freeze({});
    const firstState = new ThreadState({
      compactionOwner: owner,
      key: "alpha",
      store,
    });
    const secondState = new ThreadState({
      compactionOwner: owner,
      key: "alpha",
      store,
    });
    const summarize = vi
      .fn<AgentCompactionContext["summarize"]>()
      .mockResolvedValueOnce("summary 1")
      .mockResolvedValueOnce("summary 2");
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
    await compaction(
      context(prepared, summarize, {
        threadIdentity: firstState.compactionIdentity,
        threadKey: "alpha",
      })
    );

    // When: the reconstructed state promotes with one additional tail message.
    const promoted = await compaction(
      context([...prepared, message("tail")], summarize, {
        threadIdentity: secondState.compactionIdentity,
        threadKey: "alpha",
      })
    );

    // Then: the previously paid summary is reused.
    expect(promoted?.summary).toBe("summary 1");
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it.each(["a\u0000b", "a:b"])(
    "keeps hostile thread key %j in its exact owner slot",
    async (threadKey) => {
      // Given: equal histories under exact keys owned by one host.
      const owner = Object.freeze({});
      const otherKey = threadKey === "a:b" ? "a\u0000b" : "a:b";
      const summarize = vi
        .fn<AgentCompactionContext["summarize"]>()
        .mockResolvedValueOnce(`summary ${threadKey}`)
        .mockResolvedValueOnce(`summary ${otherKey}`);
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
      const identity = createCompactionThreadIdentity(owner, threadKey);
      const otherIdentity = createCompactionThreadIdentity(owner, otherKey);
      await compaction(
        context(history, summarize, { threadIdentity: identity, threadKey })
      );
      await compaction(
        context(history, summarize, {
          threadIdentity: otherIdentity,
          threadKey: otherKey,
        })
      );

      // When: the exact key is reconstructed and promoted.
      const promoted = await compaction(
        context([...history, message("tail")], summarize, {
          threadIdentity: createCompactionThreadIdentity(owner, threadKey),
          threadKey,
        })
      );

      // Then: it reuses only its own candidate.
      expect(promoted?.summary).toBe(`summary ${threadKey}`);
      expect(summarize).toHaveBeenCalledTimes(2);
    }
  );
});
