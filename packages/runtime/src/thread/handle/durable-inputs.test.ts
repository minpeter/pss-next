import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import type {
  AgentHost,
  HostStore,
  HostStoreTransaction,
  ThreadInputBoundary,
  ThreadInputInbox,
  ThreadInputKind,
} from "../../execution";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  sentUserText,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect } from "./test-support";

describe("AgentThread durable inputs", () => {
  it("admits and consumes thread.send through the durable inbox", async () => {
    const { host, trace } = createTracedExecutionHost();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return [assistantMessage("DONE")];
      }),
    });

    const events = await collect(await agent.thread("durable-send").send("hi"));

    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "model-usage",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hi"))]]);
    expect(nonEmptyClaims(trace)).toEqual([
      "recover",
      "admit:send:none",
      "claim:turn-idle:any:send",
      "promote:send",
      "ack:send",
    ]);
  });

  it("admits active thread.steer and claims it at the active boundary", async () => {
    const { host, trace } = createTracedExecutionHost();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("durable-steer");
    const run = await thread.send("initial");
    const events: AgentEvent[] = [];
    let steered = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "step-start" && !steered) {
        steered = true;
        await thread.steer("extra");
      }
    }

    expect(events).toContainEqual(steerRuntimeInput("extra", "step-start"));
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        userTextToModelMessage(userText("extra")),
      ],
    ]);
    expect(nonEmptyClaims(trace)).toEqual([
      "recover",
      "admit:send:none",
      "claim:turn-idle:any:send",
      "promote:send",
      "ack:send",
      "admit:steer:step-start",
      "claim:step-start:any:steer",
      "promote:steer",
      "ack:steer",
    ]);
  });

  it("runs an older recovered follow-up before a newly admitted send", async () => {
    const base = createInMemoryHost();
    await base.store.inputs.admit({
      admittedAtMs: 1,
      input: userText("old"),
      kind: "follow-up",
      messageId: "old-message",
      threadKey: "durable-recovery",
    });
    const oldClaim = await base.store.inputs.claimNext(
      "durable-recovery",
      "turn-idle"
    );
    if (!oldClaim) {
      throw new Error("expected old input to be claimed");
    }
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      host: base,
      model: createCallbackModel(({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return [assistantMessage(`DONE ${calls}`)];
      }),
    });

    const events = await collect(
      await agent.thread("durable-recovery").send("new")
    );

    expect(events[0]).toEqual(sentUserText("new"));
    expect(seenHistory[0]).toEqual([userTextToModelMessage(userText("old"))]);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("old")),
      assistantMessage("DONE 1"),
      userTextToModelMessage(userText("new")),
    ]);
    await expect(base.store.inputs.releaseClaim(oldClaim)).resolves.toBeNull();
    await expect(
      base.store.inputs.claimNext("durable-recovery", "turn-idle")
    ).resolves.toBeNull();
  });

  it("drains pending durable sends left behind before in-memory queueing", async () => {
    const host = createInMemoryHost();
    await host.store.inputs.admit({
      admittedAtMs: 1,
      input: userText("old"),
      kind: "send",
      messageId: "old-message",
      threadKey: "durable-pending-orphan",
    });
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return [assistantMessage(`DONE ${seenHistory.length}`)];
      }),
    });

    const events = await collect(
      await agent.thread("durable-pending-orphan").send("new")
    );

    expect(events[0]).toEqual(sentUserText("new"));
    expect(seenHistory[0]).toEqual([userTextToModelMessage(userText("old"))]);
    await vi.waitFor(() => expect(seenHistory).toHaveLength(2));
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("old")),
      assistantMessage("DONE 1"),
      userTextToModelMessage(userText("new")),
    ]);
    await expect(
      host.store.inputs.claimNext("durable-pending-orphan", "turn-idle")
    ).resolves.toBeNull();
  });
});

function createTracedExecutionHost(): {
  readonly host: AgentHost;
  readonly trace: string[];
} {
  const base = createInMemoryHost();
  const trace: string[] = [];
  const store = executionStoreWithInputTrace(base.store, trace);
  return {
    host: {
      attachmentStore: base.attachmentStore,
      diagnostics: base.diagnostics,
      scheduler: base.scheduler,
      store,
    },
    trace,
  };
}

function tracedInputs(
  baseInputs: ThreadInputInbox,
  trace: string[]
): ThreadInputInbox {
  return {
    ack: async (record) => {
      trace.push(`ack:${record.kind}`);
      return await baseInputs.ack(record);
    },
    admit: async (input) => {
      trace.push(`admit:${input.kind}:${input.placement ?? "none"}`);
      return await baseInputs.admit(input);
    },
    claimNext: async (threadKey, boundary, options) => {
      const claimed = await baseInputs.claimNext(threadKey, boundary, options);
      trace.push(claimTrace(boundary, options?.messageId, claimed?.kind));
      return claimed;
    },
    markPromoted: async (record) => {
      trace.push(`promote:${record.kind}`);
      return await baseInputs.markPromoted(record);
    },
    recoverClaims: async (threadKey) => {
      trace.push("recover");
      return await baseInputs.recoverClaims(threadKey);
    },
    releaseClaim: async (record) => {
      trace.push(`release:${record.kind}`);
      return await baseInputs.releaseClaim(record);
    },
  };
}

function executionStoreWithInputTrace(
  store: HostStore,
  trace: string[]
): HostStore {
  return {
    checkpoints: store.checkpoints,
    events: store.events,
    inputs: tracedInputs(store.inputs, trace),
    notifications: store.notifications,
    threads: store.threads,
    transaction: (fn) =>
      store.transaction(
        async (tx) => await fn(transactionWithInputTrace(tx, trace))
      ),
    turns: store.turns,
  };
}

function transactionWithInputTrace(
  tx: HostStoreTransaction,
  trace: string[]
): HostStoreTransaction {
  return {
    checkpoints: tx.checkpoints,
    events: tx.events,
    inputs: tracedInputs(tx.inputs, trace),
    notifications: tx.notifications,
    threads: tx.threads,
    turns: tx.turns,
  };
}

function claimTrace(
  boundary: ThreadInputBoundary,
  messageId: string | undefined,
  kind: ThreadInputKind | undefined
): string {
  const target = messageId ? "targeted" : "any";
  return `claim:${boundary}:${target}:${kind ?? "none"}`;
}

function nonEmptyClaims(trace: readonly string[]): readonly string[] {
  return trace.filter(
    (entry) => !(entry.startsWith("claim:") && entry.endsWith(":none"))
  );
}
