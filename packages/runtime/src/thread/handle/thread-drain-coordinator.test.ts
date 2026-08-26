import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../internal/deferred";
import { createInMemoryHost } from "../../platform/memory";
import { createDeferred } from "../../testing/test-fixtures";
import { retryReleasedThreadDrain } from "./agent-thread-drain";
import {
  withAbortableThreadDrainOwnership,
  withThreadDrainOwnership,
} from "./thread-drain-coordinator";

describe("thread drain ownership refresh tracking", () => {
  it("releases ownership when an acquired operation is aborted", async () => {
    // Given: the current owner has entered an operation that will not settle.
    vi.useFakeTimers();
    const host = createInMemoryHost();
    const operationStarted = createDeferred();
    const operation = deferred();
    const secondStarted = createDeferred();
    const controller = new AbortController();
    const reason = new TypeError("owned operation aborted");
    const first = withAbortableThreadDrainOwnership({
      executionHost: host,
      operation: async () => {
        operationStarted.resolve();
        await operation.promise;
      },
      owner: {},
      signal: controller.signal,
      threadKey: "abort-owned-operation",
    });
    const firstOutcome = first.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ error, kind: "rejected" as const })
    );
    await operationStarted.promise;
    const second = withThreadDrainOwnership(
      host,
      "abort-owned-operation",
      {},
      () => {
        secondStarted.resolve();
        return Promise.resolve();
      }
    );
    const acquiredBeforeGuard = Promise.race([
      secondStarted.promise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 1);
      }),
    ]);

    // When: the owner is aborted while a second acquisition is waiting.
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(1);
    const acquired = await acquiredBeforeGuard;
    operation.reject(new Error("late detached operation failure"));
    const outcome = await firstOutcome;
    await second;
    vi.useRealTimers();

    // Then: the caller sees the abort and the second owner acquired promptly.
    expect(outcome).toEqual({ error: reason, kind: "rejected" });
    expect(acquired).toBe(true);
  });

  it("keeps refresh required when a new owner's operation fails", async () => {
    const host = createInMemoryHost();
    const firstOwner = {};
    const secondOwner = {};
    const observed: boolean[] = [];
    await withThreadDrainOwnership(
      host,
      "refresh-retry",
      firstOwner,
      async ({ refreshRequired }) => {
        await Promise.resolve();
        observed.push(refreshRequired);
      }
    );
    await expect(
      withThreadDrainOwnership(
        host,
        "refresh-retry",
        secondOwner,
        async ({ refreshRequired }) => {
          await Promise.resolve();
          observed.push(refreshRequired);
          throw new Error("refresh failed");
        }
      )
    ).rejects.toThrow("refresh failed");
    await withThreadDrainOwnership(
      host,
      "refresh-retry",
      secondOwner,
      async ({ refreshRequired }) => {
        await Promise.resolve();
        observed.push(refreshRequired);
      }
    );
    await withThreadDrainOwnership(
      host,
      "refresh-retry",
      secondOwner,
      async ({ refreshRequired }) => {
        await Promise.resolve();
        observed.push(refreshRequired);
      }
    );

    expect(observed).toEqual([false, true, true, false]);
  });

  it("preserves refresh-required state through all permanent restart retries", async () => {
    const host = createInMemoryHost();
    await withThreadDrainOwnership(
      host,
      "permanent",
      {},
      async () => undefined
    );
    const owner = {};
    const refreshValues: boolean[] = [];
    const permanentFailure = vi.fn();

    await retryReleasedThreadDrain(
      () =>
        withThreadDrainOwnership(
          host,
          "permanent",
          owner,
          async ({ refreshRequired }) => {
            await Promise.resolve();
            refreshValues.push(refreshRequired);
            throw new Error("refresh permanently failed");
          }
        ),
      permanentFailure
    );

    expect(refreshValues).toEqual([true, true, true]);
    expect(permanentFailure).toHaveBeenCalledOnce();
  });
});
