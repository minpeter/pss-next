import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect, SpyStore } from "./test-support";

const timeoutMarker = Symbol("timeout");

describe("Agent thread terminal state", () => {
  it("rejects runtime input after dispose and settles queued runs", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const agent = await createAgent({
      model: createCallbackModel(async () => {
        llmStarted.resolve();
        await llmGate.promise;
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("kill-terminal");
    const firstRun = await thread.send("first");
    const secondRun = await thread.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    await llmStarted.promise;
    thread.dispose();
    llmGate.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-error");
    expect(eventTypes(await secondEvents)).toEqual([
      "user-input",
      "turn-error",
    ]);
    await expect(thread.steer("late")).rejects.toThrow("Thread killed");
  });

  it("closes the active run when a disposed thread has a pending model call", async () => {
    const llmStarted = createDeferred();
    const agent = await createAgent({
      model: createCallbackModel(() => {
        llmStarted.resolve();
        return new Promise<never>(() => undefined);
      }),
    });
    const thread = agent.thread("kill-pending-model");
    const collecting = collect(await thread.send("hello"));
    await llmStarted.promise;

    thread.dispose();

    const events = await withShortTimeout(collecting);
    if (events === timeoutMarker) {
      throw new Error("thread.dispose() did not close the active run");
    }
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
  });

  it("closes the active run when a disposed thread has a pending model-step hook", async () => {
    const modelStepHookStarted = createDeferred();
    const agent = await createAgent({
      hooks: {
        transformModelStep: () => {
          modelStepHookStarted.resolve();
          return new Promise<never>(() => undefined);
        },
      },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("kill-pending-model-step-hook");
    const collecting = collect(await thread.send("hello"));
    await modelStepHookStarted.promise;

    thread.dispose();

    const events = await withShortTimeout(collecting);
    if (events === timeoutMarker) {
      throw new Error("thread.dispose() did not close the model-step hook run");
    }
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "model-usage",
      "turn-error",
    ]);
  });

  it("does not persist an active turn after thread delete", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    const agent = await createAgent({
      model: createCallbackModel(async ({ history }) => {
        seenHistory.push([...history]);
        if (seenHistory.length === 1) {
          llmStarted.resolve();
          await llmGate.promise;
        }
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("delete-active");
    const deletedRun = collect(await thread.send("first"));

    await llmStarted.promise;
    await thread.delete();
    llmGate.resolve();
    await deletedRun;
    await collect(await agent.thread("delete-active").send("fresh"));

    expect(seenHistory.at(-1)).toEqual([
      userTextToModelMessage(userText("fresh")),
    ]);
  });

  it("closes the active run while thread delete is pending", async () => {
    const llmStarted = createDeferred();
    const store = new BlockingDeleteStore();
    const agent = await createAgent({
      host: hostWithThreads(store),
      model: createCallbackModel(() => {
        llmStarted.resolve();
        return new Promise<never>(() => undefined);
      }),
    });
    const thread = agent.thread("delete-pending-active");
    const collecting = collect(await thread.send("hello"));

    await llmStarted.promise;
    const deletion = thread.delete();
    await store.deleteStarted.promise;
    const events = await withShortTimeout(collecting);
    store.allowDelete.resolve();
    await deletion;

    if (events === timeoutMarker) {
      throw new Error("thread.delete() did not close the active run");
    }
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "step-start",
      "turn-error",
    ]);
  });

  it("rejects new input while thread delete is pending", async () => {
    const store = new BlockingDeleteStore();
    const agent = await createAgent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("delete-pending");

    await collect(await thread.send("before"));
    const deletion = thread.delete();
    await store.deleteStarted.promise;
    await expect(thread.send("during")).rejects.toThrow("Thread killed");
    await expect(thread.steer("during")).rejects.toThrow("Thread killed");
    store.allowDelete.resolve();
    await deletion;

    await expect(thread.send("after")).rejects.toThrow("Thread killed");
  });
});

function withShortTimeout<T>(
  promise: Promise<T>
): Promise<T | typeof timeoutMarker> {
  return Promise.race([
    promise,
    new Promise<typeof timeoutMarker>((resolve) => {
      setTimeout(() => resolve(timeoutMarker), 100);
    }),
  ]);
}

class BlockingDeleteStore extends SpyStore {
  readonly allowDelete = createDeferred();
  readonly deleteStarted = createDeferred();

  override async delete(key: string): Promise<void> {
    this.deleteStarted.resolve();
    await this.allowDelete.promise;
    await super.delete(key);
  }
}
