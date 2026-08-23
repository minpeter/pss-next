import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
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
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  attachmentMessage,
  model,
  stateWithHistory,
} from "./auto-compaction-runner-core-support";
import type { AgentCompaction } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";

describe("compaction runner concurrency", () => {
  it("passes deeply frozen snapshots to callbacks", async () => {
    const state = await stateWithHistory();
    const compaction: AgentCompaction = (context): undefined => {
      expect(Object.isFrozen(context.history)).toBe(true);
      expect(Object.isFrozen(context.history[0])).toBe(true);
      expect(() =>
        Object.defineProperty(context.history, context.history.length, {
          value: { content: "mutation", role: "user" } satisfies ModelMessage,
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
    const compaction: AgentCompaction = (context): undefined => {
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

  it("preserves an active zero-cost fixed prompt during preparation", async () => {
    const state = await stateWithHistory();
    const contextTokenMeter = new ContextTokenMeter(
      new ContextTokenCalibrationRegistry()
    );
    const measurementProfile = {
      measureMessages: (messages: readonly ModelMessage[]) =>
        messages.map(() => 10),
      measurePrompt: () => ({
        fixedFingerprint: "zero-fixed",
        fixedUnits: 0,
        messageUnits: [10, 10, 10],
        totalUnits: 30,
      }),
    };
    contextTokenMeter.begin({
      attemptId: "attempt",
      fixedFingerprint: "zero-fixed",
      measurement: measurementProfile.measurePrompt(),
    });
    const compaction: AgentCompaction = (context): undefined => {
      expect(context.instructionsTokens).toBe(0);
      expect(context.estimatedContextTokens).toBe(30);
      return;
    };

    await expect(
      compactThreadBlocking({
        compaction,
        model: {
          ...model,
          contextTokenMeter,
          contextTokens: { measurementProfile },
          instructions: "zero-cost instructions",
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
