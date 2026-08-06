import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import { MemoryThreadStore } from "../../platform/memory/storage/memory-thread-store";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";
import { AgentThread } from "./agent-thread";
import { inputMetaForQueuedKind } from "./durable-queue-send";
import { collect } from "./test-support";

describe("AgentThread follow-up queue", () => {
  it("derives event metadata from the durable inbox kind", () => {
    expect(inputMetaForQueuedKind("send")).toEqual({ source: "send" });
    expect(inputMetaForQueuedKind("follow-up")).toEqual({
      source: "follow-up",
      streaming: "follow-up",
    });
  });

  it("delivers active follow-ups as FIFO one-at-a-time turns, not steering input", async () => {
    const host = createInMemoryHost();
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return [assistantMessage(`DONE ${seenHistory.length}`)];
      }),
    });
    const thread = agent.thread("follow-up-fifo");
    const first = await thread.send("initial");
    let followUps: readonly Awaited<ReturnType<typeof thread.followUp>>[] = [];
    const firstEvents: AgentEvent[] = [];

    for await (const event of first.events()) {
      firstEvents.push(event);
      if (event.type === "step-start" && followUps.length === 0) {
        followUps = await Promise.all([
          thread.followUp("first follow-up"),
          thread.followUp("second follow-up"),
        ]);
      }
    }
    const followUpEvents = await Promise.all(followUps.map(collect));

    expect(firstEvents.some((event) => event.type === "runtime-input")).toBe(
      false
    );
    expect(followUpEvents.map((events) => events[0])).toEqual([
      {
        meta: { source: "follow-up", streaming: "follow-up" },
        text: "first follow-up",
        type: "user-input",
      },
      {
        meta: { source: "follow-up", streaming: "follow-up" },
        text: "second follow-up",
        type: "user-input",
      },
    ]);
    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("initial"))],
      [
        userTextToModelMessage(userText("initial")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("first follow-up")),
      ],
      [
        userTextToModelMessage(userText("initial")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("first follow-up")),
        assistantMessage("DONE 2"),
        userTextToModelMessage(userText("second follow-up")),
      ],
    ]);
    await expect(
      host.store.inputs.claimNext("follow-up-fifo", "turn-idle")
    ).resolves.toBeNull();
  });

  it("keeps a queued follow-up after the active turn is aborted", async () => {
    const seenHistory: ModelMessage[][] = [];
    const thread = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return [assistantMessage("DONE")];
      }),
    }).thread("follow-up-abort");
    const active = await thread.send("abort me");
    let followUp: Awaited<ReturnType<typeof thread.followUp>> | undefined;
    const activeEvents: AgentEvent[] = [];

    for await (const event of active.events()) {
      activeEvents.push(event);
      if (event.type === "step-start" && !followUp) {
        followUp = await thread.followUp("survives abort");
        thread.interrupt();
      }
    }
    if (!followUp) {
      throw new Error("Expected follow-up admission.");
    }
    const followUpEvents = await collect(followUp);

    expect(activeEvents.at(-1)?.type).toBe("turn-abort");
    expect(followUpEvents[0]).toMatchObject({
      meta: { source: "follow-up", streaming: "follow-up" },
      text: "survives abort",
      type: "user-input",
    });
    expect(seenHistory.at(-1)).toContainEqual(
      userTextToModelMessage(userText("survives abort"))
    );
  });

  it("recovers an orphaned follow-up claim and drains it after new work", async () => {
    const host = createInMemoryHost();
    await host.store.inputs.admit({
      admittedAtMs: 1,
      input: userText("orphaned follow-up"),
      kind: "follow-up",
      messageId: "orphaned-message",
      threadKey: "follow-up-recovery",
    });
    const claim = await host.store.inputs.claimNext(
      "follow-up-recovery",
      "turn-idle"
    );
    expect(claim).not.toBeNull();

    const seenHistory: ModelMessage[][] = [];
    const thread = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return [assistantMessage(`DONE ${seenHistory.length}`)];
      }),
    }).thread("follow-up-recovery");

    await collect(await thread.followUp("new follow-up"));
    await vi.waitFor(() => expect(seenHistory).toHaveLength(2));

    expect(seenHistory[0]).toEqual([
      userTextToModelMessage(userText("orphaned follow-up")),
    ]);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("orphaned follow-up")),
      assistantMessage("DONE 1"),
      userTextToModelMessage(userText("new follow-up")),
    ]);
    await expect(
      host.store.inputs.claimNext("follow-up-recovery", "turn-idle")
    ).resolves.toBeNull();
  });

  it("waits for a live owner before recovering an orphan claim", async () => {
    const host = createInMemoryHost();
    const activeStarted = createDeferred();
    const releaseActive = createDeferred();
    let calls = 0;
    const model = createCallbackModel(async () => {
      calls += 1;
      if (calls === 1) {
        activeStarted.resolve();
        await releaseActive.promise;
      }
      return [assistantMessage(`DONE ${calls}`)];
    });
    const activeThread = new Agent({ host, model }).thread(
      "recovery-during-active"
    );
    const recoveringThread = new Agent({ host, model }).thread(
      "recovery-during-active"
    );
    const activeTurn = await activeThread.followUp("active");
    const activeEvents = collect(activeTurn);
    await activeStarted.promise;

    await host.store.inputs.admit({
      input: userText("orphan"),
      kind: "follow-up",
      messageId: "orphan-during-active",
      threadKey: "recovery-during-active",
    });
    const orphanClaim = await host.store.inputs.claimNext(
      "recovery-during-active",
      "turn-idle"
    );
    expect(orphanClaim?.status).toBe("claiming");

    const recoveringTurn = await recoveringThread.followUp("after orphan");

    releaseActive.resolve();
    await activeEvents;
    await collect(recoveringTurn);
    await vi.waitFor(() => expect(calls).toBe(3));
    await expect(
      host.store.inputs.claimNext("recovery-during-active", "turn-idle")
    ).resolves.toBeNull();
  });

  it("releases an orphan claim when turn precreation fails", async () => {
    const host = createInMemoryHost();
    await host.store.inputs.admit({
      input: userText("orphan"),
      kind: "follow-up",
      messageId: "orphan-precreate-failure",
      threadKey: "precreate-failure",
    });
    const turns = host.store.turns as {
      create: typeof host.store.turns.create;
    };
    turns.create = () => Promise.reject(new Error("turn create failed"));
    const thread = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("DONE")]),
    }).thread("precreate-failure");

    const events = await collect(await thread.send("new"));

    expect(events.at(-1)).toMatchObject({
      message: "turn create failed",
      type: "turn-error",
    });
    await expect(
      host.store.inputs.claimNext("precreate-failure", "turn-idle")
    ).resolves.toMatchObject({
      messageId: "orphan-precreate-failure",
      status: "claiming",
    });
  });

  it("does not hang and can be retried after durable kill cancellation fails", async () => {
    const base = createInMemoryHost();
    let failTransactions = false;
    const store = new Proxy(base.store, {
      get(target, property) {
        if (property === "transaction" && failTransactions) {
          return (): Promise<never> =>
            Promise.reject(new Error("kill transaction failed"));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const enteredModel = createDeferred();
    const holdModel = createDeferred();
    const host = { ...base, store };
    const thread = new AgentThread(
      {
        model: createCallbackModel(async () => {
          enteredModel.resolve();
          await holdModel.promise;
          return [assistantMessage("DONE")];
        }),
      },
      { key: "retry-kill", store: new MemoryThreadStore() },
      { executionHost: host }
    );
    const activeEvents = collect(await thread.send("active"));
    await enteredModel.promise;
    const queued = await thread.followUp("queued");

    failTransactions = true;
    await expect(
      Promise.race([
        thread.kill(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("kill timed out")), 1000)
        ),
      ])
    ).rejects.toThrow("kill transaction failed");

    failTransactions = false;
    await expect(
      Promise.race([
        thread.kill(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("retry timed out")), 1000)
        ),
      ])
    ).resolves.toBeUndefined();
    holdModel.resolve();
    await activeEvents;
    expect((await collect(queued)).at(-1)?.type).toBe("turn-error");
  });
});
