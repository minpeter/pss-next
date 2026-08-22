import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { CompactionDeadlineExceededError } from "../runtime/auto-compaction-episode";
import type { AgentCompaction } from "../runtime/auto-compaction-types";
import { collect } from "./test-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentThread manual compaction deadline", () => {
  it("inherits the configured compaction deadline without invoking its policy", async () => {
    const automaticCompleted = createDeferred();
    const manualSummaryStarted = createDeferred();
    const cleanup = new AbortController();
    let modelCalls = 0;
    let policyCalls = 0;
    let deadlineCalls = 0;
    const compaction = Object.assign(
      (): undefined => {
        policyCalls += 1;
        automaticCompleted.resolve();
        return;
      },
      {
        deadlineMs: () => {
          deadlineCalls += 1;
          return 25;
        },
      }
    ) satisfies AgentCompaction;
    const agent = new Agent({
      compaction,
      model: createCallbackModel(({ signal }) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return [assistantMessage("OLD")];
        }
        manualSummaryStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    });
    const thread = agent.thread("manual-custom-deadline");
    await collect(await thread.send("old ".repeat(200)));
    await automaticCompleted.promise;
    vi.useFakeTimers();
    const policyCallsBeforeManual = policyCalls;
    let outcome: unknown;
    const compacting = thread.compact({ signal: cleanup.signal }).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      }
    );

    try {
      await manualSummaryStarted.promise;
      await vi.advanceTimersByTimeAsync(25);

      expect(outcome).toBeInstanceOf(CompactionDeadlineExceededError);
      expect(policyCalls).toBe(policyCallsBeforeManual);
      expect(deadlineCalls).toBe(2);
    } finally {
      cleanup.abort(new Error("test cleanup"));
      await compacting;
    }
  });
});
