import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import type { AgentCompactionReason } from "../runtime/auto-compaction-types";
import { agentWithCompaction } from "./automatic-compaction.test-support";
import { collect, SpyStore } from "./test-support";

const oversizedUserText = "x".repeat(400);
const beyondLegacyDefaultUserText = "y".repeat(600_000);
const gateRejectedPattern = /context gate rejected prompt/;

describe("Agent compaction budget policy", () => {
  it("rejects an over-budget prompt through the policy methods and recovers by invoking compact with reason overflow", async () => {
    const seenReasons: AgentCompactionReason[] = [];
    const maxInputTokens = vi.fn(() => 64);
    const compact = vi.fn(
      (context: {
        readonly history: readonly ModelMessage[];
        readonly reason: AgentCompactionReason;
      }) => {
        seenReasons.push(context.reason);
        return { endSeqExclusive: 1, startSeq: 0, summary: "S" };
      }
    );
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: { compact, maxInputTokens, onOverflow: "compact" },
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("policy-overflow");

    const events = await collect(await thread.send(oversizedUserText));

    expect(maxInputTokens.mock.calls.length).toBeGreaterThan(0);
    expect(seenReasons).toEqual(["overflow"]);
    expect(events).toContainEqual({ text: "DONE", type: "assistant-output" });
    expect(calls).toBe(1);
  });

  it("does not locally gate a bare compaction function against any default budget", async () => {
    const seenReasons: AgentCompactionReason[] = [];
    let calls = 0;
    const histories: ModelMessage[][] = [];
    const agent = agentWithCompaction({
      compaction: (context: { readonly reason: AgentCompactionReason }) => {
        seenReasons.push(context.reason);
        return;
      },
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(({ history }) => {
        calls += 1;
        histories.push([...history]);
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("bare-function-no-gate");

    const events = await collect(
      await thread.send(beyondLegacyDefaultUserText)
    );

    expect(events).toContainEqual({ text: "DONE", type: "assistant-output" });
    expect(calls).toBe(1);
    expect(seenReasons).not.toContain("overflow");
    expect(
      histories[0]?.some((message) =>
        JSON.stringify(message).includes(beyondLegacyDefaultUserText)
      )
    ).toBe(true);
  });

  it("propagates ContextBudgetExceededError when the budget source selects error mode without a compact method", async () => {
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: { maxInputTokens: () => 64, onOverflow: "error" },
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("policy-error-mode");

    const events = await collect(await thread.send(oversizedUserText));

    expect(
      events.some(
        (event) =>
          event.type === "turn-error" &&
          gateRejectedPattern.test(event.message)
      )
    ).toBe(true);
    expect(calls).toBe(0);
  });
});
