import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";

const signalTimeoutMs = 1000;

describe("terminal ownership durable commit", () => {
  it("does not commit terminal state or events after the worker loses ownership", async () => {
    // Given: a durable turn paused inside its model call.
    const host = createInMemoryHost();
    const modelStarted = createDeferred();
    const allowModelCompletion = createDeferred();
    const threadKey = "terminal-ownership";
    const agent = new Agent({
      host,
      model: createCallbackModel(async () => {
        modelStarted.resolve();
        await allowModelCompletion.promise;
        return [assistantMessage("stale result")];
      }),
    });
    const turn = await agent.thread(threadKey).send("start owned work");
    const draining = collect(turn);
    await bounded(modelStarted.promise);
    const runId = turn.runId;
    if (runId === undefined) {
      throw new Error("Expected a durable run id.");
    }
    const stateBeforeOwnershipLoss = await host.store.threads.load(threadKey);
    const eventsBeforeOwnershipLoss = await readEventTypes(host, threadKey);

    // When: another worker acquires the run before terminal settlement.
    const claim = await host.store.turns.claim(runId, {
      attempt: 2,
      leaseId: "replacement-owner",
      leaseMs: 300_000,
      nowMs: Date.now(),
    });
    expect(claim.ok).toBe(true);
    allowModelCompletion.resolve();
    await draining;

    // Then: the stale worker must not durably commit its result or events.
    await expect(host.store.threads.load(threadKey)).resolves.toEqual(
      stateBeforeOwnershipLoss
    );
    await expect(readEventTypes(host, threadKey)).resolves.toEqual(
      eventsBeforeOwnershipLoss
    );
  });
});

async function readEventTypes(
  host: ReturnType<typeof createInMemoryHost>,
  threadKey: string
): Promise<string[]> {
  const types: string[] = [];
  for await (const record of host.store.threadEvents.read(threadKey)) {
    types.push(record.event.type);
  }
  return types;
}

async function bounded(signal: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Deferred signal timed out.")),
          signalTimeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
