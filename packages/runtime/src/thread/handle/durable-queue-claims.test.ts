import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../internal/deferred";
import { createInMemoryHost } from "../../platform/memory";
import { createDeferred } from "../../testing/test-fixtures";
import {
  DurableInputRecoveryState,
  recoverThreadDurableInputClaims,
} from "./durable-queue-claims";
import { withThreadDrainOwnership } from "./thread-drain-coordinator";

describe("durable queue claim recovery", () => {
  it("shares an in-flight recovery with a concurrent caller", async () => {
    // Given: store recovery is blocked after the first caller starts it.
    const host = createInMemoryHost();
    const recoveryStarted = createDeferred();
    const releaseRecovery = createDeferred();
    const recoverClaims = vi
      .spyOn(host.store.inputs, "recoverClaims")
      .mockImplementation(async () => {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return { acked: [], released: [] };
      });
    const state = new DurableInputRecoveryState();
    const options = {
      executionHost: host,
      state,
      threadKey: "shared-recovery",
    };
    const first = recoverThreadDurableInputClaims(options);
    await recoveryStarted.promise;

    // When: another caller requests recovery before the store settles.
    const second = recoverThreadDurableInputClaims(options);
    const immediateOutcome = await Promise.race([
      second.then(() => "settled" as const),
      Promise.resolve("pending" as const),
    ]);

    // Then: both callers share the exact pending recovery and one store call.
    expect(second).toBe(first);
    expect(immediateOutcome).toBe("pending");
    releaseRecovery.resolve();
    await Promise.all([first, second]);
    expect(recoverClaims).toHaveBeenCalledOnce();
    expect(state.machine.state.tag).toBe("recovered");
  });

  it("shares a failed recovery and resets state for one retry", async () => {
    // Given: the first store recovery is blocked and then fails.
    const host = createInMemoryHost();
    const recoveryStarted = createDeferred();
    const failRecovery = deferred();
    const failure = new TypeError("recovery failed");
    const recoverClaims = vi
      .spyOn(host.store.inputs, "recoverClaims")
      .mockImplementationOnce(async () => {
        recoveryStarted.resolve();
        await failRecovery.promise;
        return { acked: [], released: [] };
      });
    const state = new DurableInputRecoveryState();
    const options = {
      executionHost: host,
      state,
      threadKey: "failed-shared-recovery",
    };
    const first = recoverThreadDurableInputClaims(options);
    await recoveryStarted.promise;
    const second = recoverThreadDurableInputClaims(options);

    // When: the shared store recovery rejects.
    failRecovery.reject(failure);
    const outcomes = await Promise.allSettled([first, second]);

    // Then: both callers receive that failure and a later caller retries once.
    expect(second).toBe(first);
    expect(outcomes).toEqual([
      { reason: failure, status: "rejected" },
      { reason: failure, status: "rejected" },
    ]);
    expect(state.machine.state.tag).toBe("pending");
    await expect(recoverThreadDurableInputClaims(options)).resolves.toBe(
      undefined
    );
    expect(recoverClaims).toHaveBeenCalledTimes(2);
    expect(state.machine.state.tag).toBe("recovered");
  });

  it("requires explicit permission to recover while drain ownership is held", async () => {
    // Given: the thread drain is owned and recovery is still pending.
    const host = createInMemoryHost();
    const recoverClaims = vi.spyOn(host.store.inputs, "recoverClaims");
    const state = new DurableInputRecoveryState();

    // When: default and explicitly owned recovery are requested in order.
    await withThreadDrainOwnership(host, "owned-recovery", {}, async () => {
      await recoverThreadDurableInputClaims({
        executionHost: host,
        state,
        threadKey: "owned-recovery",
      });
      expect(recoverClaims).not.toHaveBeenCalled();
      await recoverThreadDurableInputClaims({
        allowOwned: true,
        executionHost: host,
        state,
        threadKey: "owned-recovery",
      });
    });

    // Then: only the explicitly authorized request reaches the store.
    expect(recoverClaims).toHaveBeenCalledOnce();
    expect(state.machine.state.tag).toBe("recovered");
  });
});
