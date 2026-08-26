import { describe, expect, it, vi } from "vitest";
import type { RecoverThreadInputClaimsResult } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";
import { createInMemoryHost } from "../../platform/memory";
import { createDeferred } from "../../testing/test-fixtures";
import {
  DurableInputRecoveryState,
  recoverThreadDurableInputClaims,
} from "./durable-queue-claims";

const EMPTY_RECOVERY = { acked: [], released: [] } as const;

describe("durable queue claim recovery cancellation", () => {
  it("preserves a shared flight when one of two waiters cancels", async () => {
    // Given: two handle states lease one blocked store recovery.
    const host = createInMemoryHost();
    const recoveryStarted = createDeferred();
    const storeRecovery = deferred<RecoverThreadInputClaimsResult>();
    let flightSignal: AbortSignal | undefined;
    const recoverClaims = vi
      .spyOn(host.store.inputs, "recoverClaims")
      .mockImplementation(async (_threadKey, options) => {
        flightSignal = options?.signal;
        recoveryStarted.resolve();
        return await storeRecovery.promise;
      });
    const firstState = new DurableInputRecoveryState();
    const secondState = new DurableInputRecoveryState();
    const firstController = new AbortController();
    const first = recoverThreadDurableInputClaims({
      executionHost: host,
      signal: firstController.signal,
      state: firstState,
      threadKey: "cancel-one-shared-recovery",
    });
    await recoveryStarted.promise;
    const second = recoverThreadDurableInputClaims({
      executionHost: host,
      state: secondState,
      threadKey: "cancel-one-shared-recovery",
    });

    // When: only the first waiter cancels.
    const reason = new TypeError("first recovery waiter cancelled");
    firstController.abort(reason);

    // Then: its exact state resets while the other waiter keeps the flight alive.
    await expect(first).rejects.toBe(reason);
    expect(firstState.machine.state.tag).toBe("pending");
    expect(secondState.machine.state.tag).toBe("recovering");
    expect(flightSignal?.aborted).toBe(false);
    expect(recoverClaims).toHaveBeenCalledOnce();
    storeRecovery.resolve(EMPTY_RECOVERY);
    await expect(second).resolves.toBeUndefined();
    expect(secondState.machine.state.tag).toBe("recovered");
  });

  it("evicts and aborts a final cancelled waiter before an immediate retry", async () => {
    // Given: one waiter owns a legacy store recovery that ignores cancellation.
    const host = createInMemoryHost();
    const firstStarted = createDeferred();
    const retryStarted = createDeferred();
    const firstStoreRecovery = deferred<RecoverThreadInputClaimsResult>();
    const retryStoreRecovery = deferred<RecoverThreadInputClaimsResult>();
    let firstFlightSignal: AbortSignal | undefined;
    const recoverClaims = vi
      .spyOn(host.store.inputs, "recoverClaims")
      .mockImplementationOnce(async (_threadKey, options) => {
        firstFlightSignal = options?.signal;
        firstStarted.resolve();
        return await firstStoreRecovery.promise;
      })
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        return await retryStoreRecovery.promise;
      });
    const state = new DurableInputRecoveryState();
    const controller = new AbortController();
    const firstOptions = {
      executionHost: host,
      signal: controller.signal,
      state,
      threadKey: "cancel-final-recovery",
    };
    const first = recoverThreadDurableInputClaims(firstOptions);
    await firstStarted.promise;
    const abandonedFlight =
      state.machine.expect("recovering").lease.flight.observed;
    const repeated = recoverThreadDurableInputClaims(firstOptions);

    // When: the final waiter cancels and immediately retries.
    const reason = new TypeError("final recovery waiter cancelled");
    controller.abort(reason);
    const retry = recoverThreadDurableInputClaims({
      executionHost: host,
      state,
      threadKey: "cancel-final-recovery",
    });

    // Then: the old flight is aborted before a second store call owns the retry.
    expect(repeated).toBe(first);
    await expect(first).rejects.toBe(reason);
    await retryStarted.promise;
    expect(firstFlightSignal?.aborted).toBe(true);
    expect(firstFlightSignal?.reason).toBe(reason);
    expect(recoverClaims).toHaveBeenCalledTimes(2);
    expect(state.machine.state.tag).toBe("recovering");
    retryStoreRecovery.resolve(EMPTY_RECOVERY);
    await expect(retry).resolves.toBeUndefined();
    expect(state.machine.state.tag).toBe("recovered");
    firstStoreRecovery.resolve(EMPTY_RECOVERY);
    await abandonedFlight;
  });

  it("ignores an old success while another state joins the retry generation", async () => {
    // Given: an abandoned generation and a pending retry generation.
    const host = createInMemoryHost();
    const firstStarted = createDeferred();
    const retryStarted = createDeferred();
    const firstStoreRecovery = deferred<RecoverThreadInputClaimsResult>();
    const retryStoreRecovery = deferred<RecoverThreadInputClaimsResult>();
    const recoverClaims = vi
      .spyOn(host.store.inputs, "recoverClaims")
      .mockImplementationOnce(async () => {
        firstStarted.resolve();
        return await firstStoreRecovery.promise;
      })
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        return await retryStoreRecovery.promise;
      });
    const firstState = new DurableInputRecoveryState();
    const controller = new AbortController();
    const abandoned = recoverThreadDurableInputClaims({
      executionHost: host,
      signal: controller.signal,
      state: firstState,
      threadKey: "late-old-recovery",
    });
    await firstStarted.promise;
    const oldFlightObserved =
      firstState.machine.expect("recovering").lease.flight.observed;
    const abandonedReason = new TypeError("abandon old recovery");
    controller.abort(abandonedReason);
    await expect(abandoned).rejects.toBe(abandonedReason);
    const retry = recoverThreadDurableInputClaims({
      executionHost: host,
      state: firstState,
      threadKey: "late-old-recovery",
    });
    await retryStarted.promise;

    // When: the old generation succeeds before a second state joins.
    firstStoreRecovery.resolve(EMPTY_RECOVERY);
    await oldFlightObserved;
    const secondState = new DurableInputRecoveryState();
    const joined = recoverThreadDurableInputClaims({
      executionHost: host,
      state: secondState,
      threadKey: "late-old-recovery",
    });

    // Then: old completion changes neither the retry state nor its map identity.
    expect(firstState.machine.state.tag).toBe("recovering");
    expect(secondState.machine.state.tag).toBe("recovering");
    expect(recoverClaims).toHaveBeenCalledTimes(2);
    retryStoreRecovery.resolve(EMPTY_RECOVERY);
    await expect(Promise.all([retry, joined])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(firstState.machine.state.tag).toBe("recovered");
    expect(secondState.machine.state.tag).toBe("recovered");
  });

  it("rejects an already-aborted caller before touching recovery ownership", async () => {
    // Given: a pre-aborted caller and a pending handle state.
    const host = createInMemoryHost();
    const recoverClaims = vi.spyOn(host.store.inputs, "recoverClaims");
    const state = new DurableInputRecoveryState();
    const controller = new AbortController();
    const reason = new TypeError("recovery already aborted");
    controller.abort(reason);

    // When: recovery admission is requested.
    const recovery = recoverThreadDurableInputClaims({
      executionHost: host,
      signal: controller.signal,
      state,
      threadKey: "pre-aborted-recovery",
    });

    // Then: its Promise rejects exactly before state or store ownership changes.
    expect(recovery).toBeInstanceOf(Promise);
    await expect(recovery).rejects.toBe(reason);
    expect(state.machine.state.tag).toBe("pending");
    expect(recoverClaims).not.toHaveBeenCalled();
  });
});
