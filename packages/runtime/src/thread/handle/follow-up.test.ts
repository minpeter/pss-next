import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect } from "./test-support";

describe("AgentThread follow-up queue", () => {
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
      userTextToModelMessage(userText("new follow-up")),
    ]);
    expect(seenHistory[1]).toContainEqual(
      userTextToModelMessage(userText("orphaned follow-up"))
    );
    await expect(
      host.store.inputs.claimNext("follow-up-recovery", "turn-idle")
    ).resolves.toBeNull();
  });
});
