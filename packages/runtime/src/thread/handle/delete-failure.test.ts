import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "./test-support";

class RejectingDeleteStore extends SpyStore {
  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("delete failed"));
  }
}

class RecoveringDeleteStore extends SpyStore {
  failDeletes = 1;

  override delete(key: string): Promise<void> {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      return Promise.reject(new Error("delete failed"));
    }
    return super.delete(key);
  }
}

class BlockingFailingDeleteStore extends SpyStore {
  readonly allowFailure = createDeferred();
  readonly deleteStarted = createDeferred();

  override async delete(_key: string): Promise<void> {
    this.deleteStarted.resolve();
    await this.allowFailure.promise;
    throw new Error("delete failed");
  }
}

describe("Agent thread delete failure", () => {
  it("hard-stops the thread handle when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("delete-failure");

    await collect(await thread.send("before"));

    await expect(thread.delete()).rejects.toThrow("delete failed");

    await expect(thread.send("after")).rejects.toThrow("Thread killed");
    expect(JSON.stringify(store.threads.get("delete-failure"))).not.toContain(
      "after"
    );
  });

  it("retries a failed delete and completes once the store recovers", async () => {
    const store = new RecoveringDeleteStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("delete-retry");

    await collect(await thread.send("before"));
    expect(store.threads.has("delete-retry")).toBe(true);

    // First delete fails and rolls back to killed; the retry succeeds.
    await expect(thread.delete()).rejects.toThrow("delete failed");
    await expect(thread.delete()).resolves.toBeUndefined();

    expect(store.threads.has("delete-retry")).toBe(false);
    await expect(thread.send("after")).rejects.toThrow("Thread killed");
  });

  it("retains the cached handle when durable deletion fails", async () => {
    // Given
    const store = new RecoveringDeleteStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("delete-owner");
    await collect(await thread.send("before"));

    // When
    await expect(thread.delete()).rejects.toThrow("delete failed");

    // Then
    expect(agent.thread("delete-owner")).toBe(thread);
  });

  it("evicts the cached handle after durable deletion succeeds", async () => {
    // Given
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("deleted-owner");
    await collect(await thread.send("before"));

    // When
    await thread.delete();

    // Then
    expect(agent.thread("deleted-owner")).not.toBe(thread);
  });

  it("keeps a replacement cached after stale repeated disposal", async () => {
    // Given
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const stale = agent.thread("replaced-owner");
    await stale.dispose();
    const replacement = agent.thread("replaced-owner");

    // When
    await stale.dispose();

    // Then
    expect(agent.thread("replaced-owner")).toBe(replacement);
  });

  it("rejects durable deletion through a disposed stale handle", async () => {
    // Given
    const store = new SpyStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const stale = agent.thread("stale-delete");
    await collect(await stale.send("first"));
    await stale.dispose();
    const replacement = agent.thread("stale-delete");
    await collect(await replacement.send("second"));

    // When
    const deletion = stale.delete();

    // Then
    await expect(deletion).rejects.toThrow("disposed");
    expect(agent.thread("stale-delete")).toBe(replacement);
    expect(store.threads.has("stale-delete")).toBe(true);
  });

  it("keeps failed deletion authoritative over concurrent disposal", async () => {
    // Given
    const store = new BlockingFailingDeleteStore();
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });
    const thread = agent.thread("delete-dispose-race");
    await collect(await thread.send("before"));

    // When
    const deletion = thread.delete();
    await store.deleteStarted.promise;
    const disposal = thread.dispose();

    // Then
    store.allowFailure.resolve();
    await expect(deletion).rejects.toThrow("delete failed");
    await expect(disposal).rejects.toThrow("delete failed");
    expect(agent.thread("delete-dispose-race")).toBe(thread);
  });
});
