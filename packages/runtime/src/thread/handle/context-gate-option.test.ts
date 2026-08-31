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

const oversizedText = "x".repeat(400);

describe("Agent contextGate option", () => {
  it("uses the explicit gate as a whole object instead of compaction metadata", async () => {
    const seenReasons: AgentCompactionReason[] = [];
    const compactionMax = vi.fn(() => 64);
    const compaction = Object.assign(
      (context: { readonly reason: AgentCompactionReason }) => {
        if (context.reason !== "overflow") {
          return;
        }
        seenReasons.push(context.reason);
        return { endSeqExclusive: 1, startSeq: 0, summary: "S" };
      },
      { maxInputTokens: compactionMax, onOverflow: "compact" as const }
    );
    let calls = 0;
    const agent = agentWithCompaction({
      compaction,
      contextGate: { maxInputTokens: () => 100_000 },
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });

    const events = await collect(
      await agent.thread("explicit").send(oversizedText)
    );

    expect(events).toContainEqual({ text: "DONE", type: "assistant-output" });
    expect(seenReasons).toEqual([]);
    expect(calls).toBe(1);
    expect(compactionMax).not.toHaveBeenCalled();
  });

  it("admits input beyond the compaction budget without replacing history", async () => {
    const input = "y".repeat(600_000);
    const histories: ModelMessage[][] = [];
    let calls = 0;
    const agent = agentWithCompaction({
      compaction: Object.assign((): undefined => undefined, {
        maxInputTokens: () => 128_000,
        onOverflow: "compact" as const,
      }),
      contextGate: { maxInputTokens: () => 200_000 },
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(({ history }) => {
        calls += 1;
        histories.push([...history]);
        return [assistantMessage("DONE")];
      }),
    });

    const events = await collect(await agent.thread("large").send(input));

    expect(events).toContainEqual({ text: "DONE", type: "assistant-output" });
    expect(calls).toBe(1);
    expect(
      histories.some((history) => JSON.stringify(history).includes(input))
    ).toBe(true);
  });

  it("enforces an explicit gate without compaction", async () => {
    let calls = 0;
    const agent = agentWithCompaction({
      contextGate: { maxInputTokens: () => 64, onOverflow: "error" },
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });

    const events = await collect(
      await agent.thread("gate-only").send(oversizedText)
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        error: { category: "unknown", version: 1 },
        type: "turn-error",
      })
    );
    expect(calls).toBe(0);
  });

  it("preserves compaction budget fallback when no explicit gate exists", async () => {
    const seenReasons: AgentCompactionReason[] = [];
    let calls = 0;
    const compaction = Object.assign(
      (context: { readonly reason: AgentCompactionReason }) => {
        if (context.reason !== "overflow") {
          return;
        }
        seenReasons.push(context.reason);
        return { endSeqExclusive: 1, startSeq: 0, summary: "S" };
      },
      { maxInputTokens: () => 64, onOverflow: "compact" as const }
    );
    const agent = agentWithCompaction({
      compaction,
      host: hostWithThreads(new SpyStore()),
      model: createCallbackModel(() => {
        calls += 1;
        return [assistantMessage("DONE")];
      }),
    });

    await collect(await agent.thread("fallback").send(oversizedText));

    expect(seenReasons).toEqual(["overflow"]);
    expect(calls).toBe(1);
  });
});
