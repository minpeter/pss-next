import { describe, expect, it, vi } from "vitest";
import {
  recoverOrCancelReleasedDrain,
  removeQueuedInputsByIdentity,
  retryReleasedThreadDrain,
} from "./agent-thread-drain";

describe("released thread drain restart", () => {
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
