import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentHost, ThreadInputInbox } from "../../execution";
import { deferred } from "../../internal/deferred";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../testing/test-fixtures";
import {
  recoverOrCancelReleasedDrain,
  removeQueuedInputsByIdentity,
  retryReleasedThreadDrain,
} from "./agent-thread-drain";
import { collect } from "./test-support";

describe("released thread drain restart", () => {
  it("does not fail a queued turn that executes during restart", async () => {
    const claimFailure = deferred();
    const host = hostWithOneBlockedClaimFailure(claimFailure.promise);
    const queuedExecuted = deferred();
    let modelCalls = 0;
    const thread = new Agent({
      host,
      model: createCallbackModel(({ history }) => {
        modelCalls += 1;
        if (JSON.stringify(history).includes("second")) {
          queuedExecuted.resolve();
        }
        return [assistantMessage(`DONE ${modelCalls}`)];
      }),
    }).thread("drain-restart-race");

    const first = await thread.send("first");
    const second = await thread.send("second");
    const firstEvents = collect(first);
    const secondEvents = collect(second);

    claimFailure.reject(new Error("transient claim failure"));

    await queuedExecuted.promise;
    await firstEvents;
    const queuedEvents = await secondEvents;
    expect(modelCalls).toBe(2);
    expect(eventTypes(queuedEvents)).not.toContain("turn-error");
    expect(queuedEvents.at(-1)?.type).toBe("turn-end");
  });

  it("retries a transient restart failure without another notification", async () => {
    const drain = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValue(undefined);
    const permanentFailure = vi.fn();

    await retryReleasedThreadDrain(drain, permanentFailure);

    expect(drain).toHaveBeenCalledTimes(2);
    expect(permanentFailure).not.toHaveBeenCalled();
  });

  it("surfaces a permanent restart failure after bounded retries", async () => {
    const failure = new Error("refresh permanently failed");
    const drain = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const permanentFailure = vi.fn();

    await retryReleasedThreadDrain(drain, permanentFailure);

    expect(drain).toHaveBeenCalledTimes(3);
    expect(permanentFailure).toHaveBeenCalledWith(failure);
  });

  it("recovers normally without a terminal event when cancellation fails once", async () => {
    const cancel = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("cancel unavailable"));
    const drain = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onCancelled = vi.fn();

    await recoverOrCancelReleasedDrain({ cancel, drain, onCancelled });

    expect(drain).toHaveBeenCalledOnce();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("leaves the caller protected without a terminal event on persistent failure", async () => {
    const cancel = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("cancel unavailable"));
    const drain = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("refresh unavailable"));
    const onCancelled = vi.fn();

    await recoverOrCancelReleasedDrain({ cancel, drain, onCancelled });

    expect(drain).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("removes only snapshotted callers still present after cancellation", async () => {
    const first = { id: "first" };
    const second = { id: "second" };
    const later = { id: "later" };
    const queue = [first, second];
    const snapshot = [...queue];
    const removed: { id: string }[] = [];

    await recoverOrCancelReleasedDrain({
      cancel: async () => {
        await Promise.resolve();
        queue.shift();
        queue.push(later);
      },
      drain: () => Promise.resolve(),
      onCancelled: () => {
        removed.push(...removeQueuedInputsByIdentity(queue, snapshot));
      },
    });

    expect(removed).toEqual([second]);
    expect(queue).toEqual([later]);
  });
});

function hostWithOneBlockedClaimFailure(
  claimFailure: Promise<void>
): AgentHost {
  const host = createInMemoryHost();
  let failNextClaim = true;
  const inputs: ThreadInputInbox = {
    ack: (record) => host.store.inputs.ack(record),
    admit: (input) => host.store.inputs.admit(input),
    claimNext: async (threadKey, boundary, options) => {
      if (failNextClaim) {
        failNextClaim = false;
        await claimFailure;
      }
      return await host.store.inputs.claimNext(threadKey, boundary, options);
    },
    markPromoted: (record) => host.store.inputs.markPromoted(record),
    recoverClaims: (threadKey) => host.store.inputs.recoverClaims(threadKey),
    releaseClaim: (record) => host.store.inputs.releaseClaim(record),
  };
  return {
    attachmentStore: host.attachmentStore,
    diagnostics: host.diagnostics,
    scheduler: host.scheduler,
    store: {
      checkpoints: host.store.checkpoints,
      events: host.store.events,
      inputs,
      notifications: host.store.notifications,
      threadEvents: host.store.threadEvents,
      threads: host.store.threads,
      transaction: (callback) => host.store.transaction(callback),
      turns: host.store.turns,
    },
  };
}
