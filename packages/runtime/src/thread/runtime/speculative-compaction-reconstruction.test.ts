import { describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "../../diagnostics";
import { MemoryThreadStore } from "../../platform/memory";
import { createDeferred } from "../../testing/async-fixtures";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { agentWithCompaction } from "../handle/automatic-compaction.test-support";
import { collect, SpyStore } from "../handle/test-support";
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

  it("isolates and reuses shared-policy candidates through real Agent reconstruction", async () => {
    // Given: separate Agent owners share a policy and thread key but have distinct instructions.
    const storeA = new SpyStore();
    const storeB = new SpyStore();
    const preparedA = createDeferred();
    const preparedB = createDeferred();
    const completedA = createDeferred();
    const completedB = createDeferred();
    const baseHostA = hostWithThreads(storeA);
    const baseHostB = hostWithThreads(storeB);
    const hostA = {
      ...baseHostA,
      diagnostics: {
        report(diagnostic: RuntimeDiagnostic): void {
          if (
            diagnostic.code === "compaction.skipped" &&
            diagnostic.compaction?.summaryCalls === 1
          ) {
            preparedA.resolve();
          }
          if (diagnostic.code === "compaction.completed") {
            completedA.resolve();
          }
        },
      },
    };
    const hostB = {
      ...baseHostB,
      diagnostics: {
        report(diagnostic: RuntimeDiagnostic): void {
          if (
            diagnostic.code === "compaction.skipped" &&
            diagnostic.compaction?.summaryCalls === 1
          ) {
            preparedB.resolve();
          }
          if (diagnostic.code === "compaction.completed") {
            completedB.resolve();
          }
        },
      },
    };
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });
    let providerCallsA = 0;
    let providerCallsB = 0;
    const agentA = agentWithCompaction({
      compaction,
      host: hostA,
      instructions: "AGENT_A",
      model: createCallbackModel(() => {
        providerCallsA += 1;
        if (providerCallsA <= 2) {
          return [assistantMessage("DONE")];
        }
        if (providerCallsA === 3 || providerCallsA === 5) {
          return [];
        }
        return [assistantMessage("AGENT_A")];
      }),
    });
    const agentB = agentWithCompaction({
      compaction,
      host: hostB,
      instructions: "AGENT_B",
      model: createCallbackModel(() => {
        providerCallsB += 1;
        if (providerCallsB <= 2) {
          return [assistantMessage("DONE")];
        }
        if (providerCallsB === 3 || providerCallsB === 5) {
          return [];
        }
        return [assistantMessage("AGENT_B")];
      }),
    });
    const threadA = agentA.thread("alpha");
    const threadB = agentB.thread("alpha");
    const inputs = ["turn-1", "turn-2", "turn-3", "turn-4"] as const;
    for (const input of inputs.slice(0, 3)) {
      await Promise.all([
        collect(await threadA.send(input)),
        collect(await threadB.send(input)),
      ]);
    }
    await Promise.all([preparedA.promise, preparedB.promise]);
    await Promise.all([threadA.dispose(), threadB.dispose()]);

    // When: each Agent reacquires alpha and sends the same promotion turn.
    await Promise.all([
      collect(await agentA.thread("alpha").send(inputs[3])),
      collect(await agentB.thread("alpha").send(inputs[3])),
    ]);
    await Promise.all([completedA.promise, completedB.promise]);

    // Then: each reconstructed Agent commits only its own prepared candidate.
    expect(storeA.threads.get("alpha")?.state).toMatchObject({
      compactions: [{ summary: { content: "AGENT_A", role: "system" } }],
    });
    expect(storeB.threads.get("alpha")?.state).toMatchObject({
      compactions: [{ summary: { content: "AGENT_B", role: "system" } }],
    });
    expect(providerCallsA).toBe(5);
    expect(providerCallsB).toBe(5);
  }, 5000);
});
