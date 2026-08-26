import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import type { ThreadContextMessage } from "../state/context";
import { ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-provenance-test",
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

describe("compaction model-context provenance", () => {
  it("passes the observed transformed projection to the real policy context", async () => {
    const state = await stateWithHistory();
    const transformed: readonly ThreadContextMessage[] = [
      { content: "transformed current projection", role: "user" },
    ];
    let observedContext: Parameters<AgentCompaction>[0] | undefined;
    const compaction: AgentCompaction = (context): undefined => {
      observedContext = context;
      return;
    };

    await compactThreadBlocking({
      compaction,
      latestContextTransform: () => ({
        input: state.modelContextSnapshot(),
        output: transformed,
      }),
      model,
      state,
      threadKey: "transformed-provenance",
    });

    expect(observedContext?.modelContextProvenance).toBe("transformed");
    expect(observedContext?.modelContext).toEqual(transformed);
  });

  it("marks an observer without an observation as unknown", async () => {
    const state = await stateWithHistory();
    let provenance: string | undefined;
    const compaction: AgentCompaction = (context): undefined => {
      provenance = context.modelContextProvenance;
      return;
    };

    await compactThreadBlocking({
      compaction,
      latestContextTransform: () => undefined,
      model,
      state,
      threadKey: "missing-observation",
    });

    expect(provenance).toBe("unknown");
  });

  it("does not present a stale transform observation as current", async () => {
    const state = await stateWithHistory();
    let provenance: string | undefined;
    let modelContext: readonly ModelMessage[] = [];
    const compaction: AgentCompaction = (context): undefined => {
      provenance = context.modelContextProvenance;
      modelContext = context.modelContext;
      return;
    };

    await compactThreadBlocking({
      compaction,
      latestContextTransform: () => ({
        input: [{ content: "stale", role: "user" }],
        output: [{ content: "stale transformed", role: "user" }],
      }),
      model,
      state,
      threadKey: "stale-observation",
    });

    expect(provenance).toBe("unknown");
    expect(modelContext).toEqual(state.modelSnapshot());
  });

  it("marks an identity observation over the current projection as standard", async () => {
    const state = await stateWithHistory();
    let provenance: string | undefined;
    const compaction: AgentCompaction = (context): undefined => {
      provenance = context.modelContextProvenance;
      return;
    };

    await compactThreadBlocking({
      compaction,
      latestContextTransform: () => {
        const current = state.modelContextSnapshot();
        return { input: current, output: current };
      },
      model,
      state,
      threadKey: "identity-observation",
    });

    expect(provenance).toBe("standard");
  });

  it("reuses a prepared candidate across completed-turn episodes", async () => {
    // Given
    const state = new ThreadState({
      key: "cross-episode-candidate-reuse",
      store: new MemoryThreadStore(),
    });
    await state.ensureLoaded();
    for (let index = 0; index < 6; index += 1) {
      state.history.appendModelMessage(
        index % 2 === 0
          ? { content: String(index), role: "user" }
          : assistantMessage(String(index))
      );
    }
    let summaryCalls = 0;
    const summaryModel = {
      model: createCallbackModel(() => {
        summaryCalls += 1;
        return [assistantMessage(`summary-${summaryCalls}`)];
      }),
    };
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 100,
      prepareRatio: 0.5,
      promoteRatio: 0.7,
      retainRatio: 0.2,
    });

    // When
    await scheduleThreadCompaction({
      compaction,
      model: summaryModel,
      state,
      threadKey: "cross-episode-candidate-reuse",
    });
    state.history.appendModelMessage({ content: "tail", role: "user" });
    await scheduleThreadCompaction({
      compaction,
      model: summaryModel,
      state,
      threadKey: "cross-episode-candidate-reuse",
    });

    // Then
    expect({
      persistedSummary: state.compactionSnapshot()[0]?.summary.content,
      summaryCalls,
    }).toEqual({ persistedSummary: "summary-1", summaryCalls: 1 });
  });

  it("re-summarizes instead of reusing when the real provider projection is transformed", async () => {
    const state = await stateWithHistory();
    let summaryCalls = 0;
    const summaryModel = {
      model: createCallbackModel(() => {
        summaryCalls += 1;
        return [assistantMessage(`summary-${summaryCalls}`)];
      }),
    };
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => messages.length * 10,
      maxInputTokens: 50,
      prepareRatio: 0.5,
      promoteRatio: 0.8,
      retainRatio: 0.2,
    });
    const identityProjection = () => {
      const current = state.modelContextSnapshot();
      return { input: current, output: current };
    };

    await scheduleThreadCompaction({
      compaction,
      latestContextTransform: identityProjection,
      model: summaryModel,
      state,
      threadKey: "real-transformed-reuse",
    });
    state.history.appendModelMessage({
      content: "new tail",
      role: "user",
    });
    await scheduleThreadCompaction({
      compaction,
      latestContextTransform: () => {
        const current = state.modelContextSnapshot();
        return {
          input: current,
          output: [
            ...current,
            { content: "hook-injected", role: "user" as const },
          ],
        };
      },
      model: summaryModel,
      state,
      threadKey: "real-transformed-reuse",
    });

    expect(summaryCalls).toBe(2);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "summary-2", role: "system" } },
    ]);
  });
});
