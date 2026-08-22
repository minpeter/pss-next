import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "../../diagnostics";
import {
  ContextTokenCalibrationRegistry,
  ContextTokenMeter,
} from "../../llm/context-tokens";
import {
  MemoryAttachmentStore,
  MemoryThreadStore,
} from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import {
  encodeRuntimeAttachmentData,
  type RuntimeAttachmentReference,
} from "../input/attachments";
import { ThreadState } from "../state/thread-state";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import {
  compactThreadBlocking,
  compactThreadManually,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  type AgentCompaction,
  DEFAULT_COMPACTION_DEADLINE_MS,
  type ThreadCompactionHandler,
} from "./auto-compaction-types";
import "./auto-compaction-runner-failure-cases";
import { runAgentLoopWithOverflowCompaction } from "./loop-overflow";
import { speculativeCompaction } from "./speculative-compaction";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-test",
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  const history: ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

function attachmentMessage(ref: RuntimeAttachmentReference): ModelMessage {
  return {
    content: [
      {
        data: encodeRuntimeAttachmentData(ref),
        filename: "payload.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ],
    role: "user",
  };
}

describe("compaction runner concurrency", () => {
  it("reports bounded lifecycle accounting without thread contents", async () => {
    const diagnostics: RuntimeDiagnostic[] = [];
    const state = await stateWithHistory();
    const localModel = {
      ...model,
      diagnostics: {
        report(diagnostic: RuntimeDiagnostic): void {
          diagnostics.push(diagnostic);
        },
      },
    };

    await compactThreadBlocking({
      compaction: async () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "secret summary",
      }),
      model: localModel,
      state,
      threadKey: "secret-thread",
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "compaction.completed",
        level: "info",
        compaction: expect.objectContaining({
          outcome: "committed",
          reason: "overflow",
          runnerAttempt: 1,
          summaryCalls: 0,
        }),
        phase: "auto-compaction",
      }),
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("secret summary");
    expect(serialized).not.toContain("secret-thread");
    expect(serialized).not.toContain("old");
    expect(serialized).not.toContain("tail");
  });

  it("applies the shared episode bound when a policy omits deadlineMs", async () => {
    const state = await stateWithHistory();
    let deadlineAt: number | undefined;
    const startedAt = Date.now();

    await compactThreadBlocking({
      compaction: (context) => {
        deadlineAt = context.deadlineAt;
        return;
      },
      model,
      state,
      threadKey: "thread",
    });

    expect(deadlineAt).toBeGreaterThanOrEqual(
      startedAt + DEFAULT_COMPACTION_DEADLINE_MS
    );
    expect(deadlineAt).toBeLessThan(
      startedAt + DEFAULT_COMPACTION_DEADLINE_MS + 1000
    );
  });

  it("falls back when scheduleThreadCompaction deadlineMs throws", async () => {
    const state = await stateWithHistory();
    const before = state.modelSnapshot();
    const compaction = Object.assign(
      async () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "summary",
      }),
      {
        deadlineMs: () => {
          throw new Error("boom");
        },
      }
    ) satisfies AgentCompaction;

    await expect(
      scheduleThreadCompaction({
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBeUndefined();
    expect(state.modelSnapshot()).toEqual(before);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "summary", role: "system" } },
    ]);
  });

  it("does not throw from scheduleThreadCompaction when deadlineMs is invalid", async () => {
    const state = await stateWithHistory();
    const before = state.modelSnapshot();
    const compaction = Object.assign(
      (): undefined => {
        return;
      },
      { deadlineMs: () => 0 }
    ) satisfies AgentCompaction;

    await expect(
      scheduleThreadCompaction({
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBeUndefined();
    expect(state.modelSnapshot()).toEqual(before);
  });

  it("applies the shared episode bound to manual compaction", async () => {
    const diagnostics: RuntimeDiagnostic[] = [];
    const state = new ThreadState({
      key: "runner-test",
      store: new MemoryThreadStore(),
    });
    await state.ensureLoaded();
    const paragraph = "lorem ipsum dolor sit amet ".repeat(12);
    for (let index = 0; index < 4; index += 1) {
      state.history.appendModelMessage({ content: paragraph, role: "user" });
    }
    const localModel = {
      diagnostics: {
        report(diagnostic: RuntimeDiagnostic): void {
          diagnostics.push(diagnostic);
        },
      },
      model: createCallbackModel(() => [assistantMessage("s")]),
    };
    const startedAt = Date.now();

    const compacted = await compactThreadManually({
      model: localModel,
      state,
      threadKey: "thread",
    });

    expect(compacted).toBe(true);
    const manualDeadlineAt = diagnostics[0]?.compaction?.deadlineAt;
    expect(manualDeadlineAt).toBeGreaterThanOrEqual(
      startedAt + DEFAULT_COMPACTION_DEADLINE_MS
    );
    expect(manualDeadlineAt).toBeLessThan(
      startedAt + DEFAULT_COMPACTION_DEADLINE_MS + 1000
    );
  });

  it("attaches sanitized overflow metadata when overflow compaction times out", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const overflow = new Error("context_length_exceeded: too many tokens");
    const callbackStarted = createDeferred();
    const compaction = Object.assign(
      () => {
        callbackStarted.resolve();
        return new Promise<never>(() => undefined);
      },
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;

    try {
      const observed = runAgentLoopWithOverflowCompaction({
        execution: { compaction },
        model,
        runLoop: () => Promise.reject(overflow),
        state,
        threadKey: "overflow-cause",
      }).then(
        () => undefined,
        (error: unknown) => error
      );
      await callbackStarted.promise;
      await vi.advanceTimersByTimeAsync(1);

      const failure = await observed;
      if (!(failure instanceof CompactionDeadlineExceededError)) {
        throw new Error("Expected a CompactionDeadlineExceededError.");
      }
      expect(failure.reason).toBe("overflow");
      expect(failure.cause).toEqual({
        error: { category: "context-overflow", version: 1 },
        message: "The request exceeded the context limit.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates a rejecting diagnostics sink from compaction", async () => {
    const state = await stateWithHistory();
    const localModel = {
      ...model,
      diagnostics: {
        report(): Promise<never> {
          return Promise.reject(new Error("sink failed"));
        },
      },
    };

    await expect(
      compactThreadBlocking({
        compaction: async () => ({
          endSeqExclusive: 2,
          startSeq: 0,
          summary: "summary",
        }),
        model: localModel,
        state,
        threadKey: "thread",
      })
    ).resolves.toBe(true);
  });

  it("waits for an already-started custom commit after the deadline", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    const compaction = Object.assign(
      async () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "summary",
      }),
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const compact: ThreadCompactionHandler = async (_input, context) => {
      context.signal.throwIfAborted();
      context.markCommitStarted();
      commitStarted.resolve();
      await releaseCommit.promise;
      return true;
    };

    try {
      const result = compactThreadBlocking({
        compact,
        compaction,
        model,
        state,
        threadKey: "commit-deadline",
      });
      await commitStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      releaseCommit.resolve();

      await expect(result).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves a background flight synchronously", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const compaction = vi.fn<AgentCompaction>(async () => {
      started.resolve();
      await release.promise;
      return;
    });
    const options = { compaction, model, state, threadKey: "same-key" };

    const first = scheduleThreadCompaction(options);
    const second = scheduleThreadCompaction(options);
    await started.promise;

    expect(compaction).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(compaction).toHaveBeenCalledTimes(2);
  });

  it("waits for background preparation then performs overflow fallback", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        started.resolve();
        await release.promise;
        return;
      }
      return { endSeqExclusive: 2, startSeq: 0, summary: "summary" };
    };
    const compact = vi.fn<ThreadCompactionHandler>(async (input, context) => {
      if (!context.freshnessGuard(input)) {
        return false;
      }
      context.signal.throwIfAborted();
      context.markCommitStarted();
      await state.compact(input);
      return true;
    });
    const options = { compact, compaction, model, state, threadKey: "thread" };

    scheduleThreadCompaction(options);
    await started.promise;
    const blocking = compactThreadBlocking(options);
    release.resolve();

    await expect(blocking).resolves.toBe(true);
    expect(reasons).toEqual(["completed-turn", "overflow"]);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("starts the overflow deadline after background work", async () => {
    vi.useFakeTimers();
    const state = await stateWithHistory();
    const backgroundStarted = createDeferred();
    const releaseBackground = createDeferred();
    const reasons: string[] = [];
    const compaction = Object.assign(
      async (
        context: Parameters<AgentCompaction>[0]
      ): Promise<Awaited<ReturnType<AgentCompaction>>> => {
        reasons.push(context.reason);
        if (context.reason === "completed-turn") {
          backgroundStarted.resolve();
          await releaseBackground.promise;
        }
        return;
      },
      { deadlineMs: () => 1 }
    ) satisfies AgentCompaction;
    const options = { compaction, model, state, threadKey: "wait-deadline" };

    try {
      scheduleThreadCompaction(options);
      await backgroundStarted.promise;
      const blocking = compactThreadBlocking(options);
      await vi.advanceTimersByTimeAsync(1);
      releaseBackground.resolve();

      await expect(blocking).resolves.toBe(false);
      expect(reasons).toEqual(["completed-turn", "overflow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a committed completed-turn flight for overflow", async () => {
    const state = await stateWithHistory();
    const started = createDeferred();
    const release = createDeferred();
    const reasons: string[] = [];
    const compaction: AgentCompaction = async (context) => {
      reasons.push(context.reason);
      if (context.reason === "completed-turn") {
        started.resolve();
        await release.promise;
        return { endSeqExclusive: 2, startSeq: 0, summary: "background" };
      }
      return;
    };
    const compact: ThreadCompactionHandler = async (input, context) => {
      if (!context.freshnessGuard(input)) {
        return false;
      }
      context.signal.throwIfAborted();
      context.markCommitStarted();
      await state.compact(input);
      return true;
    };
    const options = { compact, compaction, model, state, threadKey: "thread" };

    scheduleThreadCompaction(options);
    await started.promise;
    const blocking = compactThreadBlocking(options);
    release.resolve();

    await expect(blocking).resolves.toBe(true);
    expect(reasons).toEqual(["completed-turn"]);
  });

  it("rejects a callback result when the compaction baseline changes before commit", async () => {
    const state = await stateWithHistory();
    const compaction: AgentCompaction = () => ({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "candidate",
    });
    const compact: ThreadCompactionHandler = async (input, context) => {
      await state.compact({ ...input, summary: "newer baseline" });
      return context.freshnessGuard(input);
    };

    await expect(
      compactThreadBlocking({
        compact,
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBe(false);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "newer baseline", role: "system" } },
    ]);
  });

  it("passes deeply frozen snapshots to callbacks", async () => {
    const state = await stateWithHistory();
    const compaction: AgentCompaction = (context) => {
      expect(Object.isFrozen(context.history)).toBe(true);
      expect(Object.isFrozen(context.history[0])).toBe(true);
      expect(() =>
        (context.history as ModelMessage[]).push({
          content: "mutation",
          role: "user",
        })
      ).toThrow(TypeError);
      return;
    };

    await expect(
      compactThreadBlocking({
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBe(false);
  });

  it("forwards per-compaction summary options to the summarizer", async () => {
    const state = new ThreadState({
      key: "summary-options",
      store: new MemoryThreadStore(),
    });
    await state.ensureLoaded();
    state.history.appendModelMessage({
      content: "source context ".repeat(500),
      role: "user",
    });
    state.history.appendModelMessage(assistantMessage("source response"));
    state.history.appendModelMessage({ content: "tail", role: "user" });
    let summaryPrompt: readonly ModelMessage[] = [];
    const summaryModel = createCallbackModel(({ history }) => {
      summaryPrompt = history;
      return [assistantMessage("semantic summary")];
    });
    const compaction: AgentCompaction = async (context) => {
      const range = { endSeqExclusive: 2, startSeq: 0 };
      const summary = await context.summarize(range, {
        instructions: "CUSTOM SEMANTIC SUMMARY POLICY",
        toolEvidence: "omit",
      });
      return { ...range, summary };
    };

    await expect(
      compactThreadBlocking({
        compaction,
        model: { model: summaryModel },
        state,
        threadKey: "summary-options",
      })
    ).resolves.toBe(true);

    expect(JSON.stringify(summaryPrompt)).toContain(
      "CUSTOM SEMANTIC SUMMARY POLICY"
    );
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "semantic summary", role: "system" } },
    ]);
  });

  it("shares calibrated fixed and marginal costs with compaction", async () => {
    const state = await stateWithHistory();
    const registry = new ContextTokenCalibrationRegistry();
    const contextTokenMeter = new ContextTokenMeter(registry);
    const measurementProfile = {
      measureMessages: (messages: readonly ModelMessage[]) =>
        messages.map(() => 10),
      measurePrompt: () => ({
        fixedFingerprint: "fixed",
        fixedUnits: 10,
        messageUnits: [10],
        totalUnits: 20,
      }),
    };
    contextTokenMeter.begin({
      attemptId: "attempt",
      fixedFingerprint: "fixed",
      measurement: measurementProfile.measurePrompt(),
      scope: "provider\0model",
    });
    contextTokenMeter.report("attempt", {
      attemptId: "attempt",
      inputTokens: 100,
      modelId: "model",
      provider: "provider",
      type: "model-usage",
    });
    const compaction: AgentCompaction = (context) => {
      expect(context.instructionsTokens).toBe(100);
      expect(context.estimatedHistoryMessageTokens).toEqual([10, 10, 10]);
      expect(context.estimatedContextTokens).toBe(130);
      expect(
        context.estimateTokens?.([{ content: "wrapper", role: "user" }])
      ).toBe(10);
      return;
    };

    await expect(
      compactThreadBlocking({
        compaction,
        model: {
          ...model,
          contextTokenMeter,
          contextTokens: { measurementProfile },
        },
        latestContextTransform: () => {
          const input = state.modelContextSnapshot();
          return {
            input,
            output: [...input, { content: "added", role: "user" }],
          };
        },
        state,
        threadKey: "thread",
      })
    ).resolves.toBe(false);
  });

  it("hydrates transform-added attachments before estimating overhead", async () => {
    const attachmentStore = new MemoryAttachmentStore();
    const ref = await attachmentStore.put({
      bytes: new Uint8Array(8000),
      filename: "payload.bin",
      mediaType: "application/octet-stream",
    });
    const state = await stateWithHistory();
    let hydratedBytes = 0;
    const compaction = speculativeCompaction({
      estimateTokens: (messages) => {
        for (const message of messages) {
          if (!Array.isArray(message.content)) {
            continue;
          }
          for (const part of message.content) {
            if (part.type === "file" && part.data instanceof Uint8Array) {
              hydratedBytes = Math.max(hydratedBytes, part.data.byteLength);
            }
          }
        }
        return messages.length * 10;
      },
      maxInputTokens: 1_000_000,
    });

    await scheduleThreadCompaction({
      compaction,
      latestContextTransform: () => {
        const input = state.modelContextSnapshot();
        return { input, output: [...input, attachmentMessage(ref)] };
      },
      model: { ...model, attachmentStore },
      state,
      threadKey: "thread",
    });

    expect(hydratedBytes).toBe(8000);
  });
});
