import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
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
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import type {
  AgentCompaction,
  ThreadCompactionHandler,
} from "./auto-compaction-types";
import "./auto-compaction-runner-failure-cases";
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

    scheduleThreadCompaction(options);
    scheduleThreadCompaction(options);
    await started.promise;

    expect(compaction).toHaveBeenCalledTimes(1);
    release.resolve();
    await vi.waitFor(() => expect(compaction).toHaveBeenCalledTimes(2));
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
    const compact = vi.fn(async (input, guard) => {
      if (!guard?.(input)) {
        return false;
      }
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

  it("re-evaluates overflow after a completed-turn flight commits", async () => {
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
    const compact: ThreadCompactionHandler = async (input, guard) => {
      if (!guard?.(input)) {
        return false;
      }
      await state.compact(input);
      return true;
    };
    const options = { compact, compaction, model, state, threadKey: "thread" };

    scheduleThreadCompaction(options);
    await started.promise;
    const blocking = compactThreadBlocking(options);
    release.resolve();

    await expect(blocking).resolves.toBe(true);
    expect(reasons).toEqual(["completed-turn", "overflow"]);
  });

  it("rejects a callback result when the compaction baseline changes before commit", async () => {
    const state = await stateWithHistory();
    const compaction: AgentCompaction = () => ({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "candidate",
    });
    const compact = async (
      input: {
        endSeqExclusive: number;
        startSeq: number;
        summary: string;
      },
      guard?: (candidate: typeof input) => boolean
    ): Promise<boolean> => {
      await state.compact({ ...input, summary: "newer baseline" });
      return guard?.(input) ?? true;
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
        latestContextTransform: () => ({
          input: [{ content: "before", role: "user" }],
          output: [
            { content: "before", role: "user" },
            { content: "added", role: "user" },
          ],
        }),
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

    scheduleThreadCompaction({
      compaction,
      latestContextTransform: () => ({
        input: [],
        output: [attachmentMessage(ref)],
      }),
      model: { ...model, attachmentStore },
      state,
      threadKey: "thread",
    });

    await vi.waitFor(() => expect(hydratedBytes).toBe(8000));
  });
});
