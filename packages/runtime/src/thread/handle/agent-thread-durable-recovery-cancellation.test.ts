import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { RecoverThreadInputClaimsResult } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { collect } from "./test-support";

const EMPTY_RECOVERY = { acked: [], released: [] } as const;
const deadlinePolicy = Object.assign(() => undefined, {
  deadlineMs: () => 10,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentThread durable recovery cancellation", () => {
  it("starts a new recovery on another handle after a compaction deadline", async () => {
    // Given: persisted history and a first recovery that ignores cancellation.
    vi.useFakeTimers();
    const host = createInMemoryHost();
    const setup = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("HISTORY")]),
    });
    await collect(
      await setup.thread("deadline-recovery-retry").send("old ".repeat(100))
    );
    await setup.dispose();
    const firstRecoveryStarted = createDeferred();
    const secondRecoveryStarted = createDeferred();
    const legacyRecovery = deferred<RecoverThreadInputClaimsResult>();
    let firstFlightSignal: AbortSignal | undefined;
    let recoveryCalls = 0;
    vi.spyOn(host.store.inputs, "recoverClaims").mockImplementation(
      async (_threadKey, options) => {
        recoveryCalls += 1;
        if (recoveryCalls === 1) {
          firstFlightSignal = options?.signal;
          firstRecoveryStarted.resolve();
          return await legacyRecovery.promise;
        }
        secondRecoveryStarted.resolve();
        return EMPTY_RECOVERY;
      }
    );
    let providerCalls = 0;
    const model = createCallbackModel(() => {
      providerCalls += 1;
      return [assistantMessage("SUMMARY")];
    });
    const first = new Agent({
      compaction: deadlinePolicy,
      host,
      model,
    }).thread("deadline-recovery-retry");
    const second = new Agent({
      compaction: deadlinePolicy,
      host,
      model,
    }).thread("deadline-recovery-retry");

    // When: the first deadline expires and the second handle compacts.
    const expiredCompaction = first.compact();
    await firstRecoveryStarted.promise;
    const expired = expect(expiredCompaction).rejects.toMatchObject({
      deadlineMs: 10,
      reason: "manual",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expired;
    const healthyCompaction = second.compact();

    try {
      await secondRecoveryStarted.promise;

      // Then: cancellation evicts the legacy flight and provider runs once.
      await expect(healthyCompaction).resolves.toEqual({ status: "compacted" });
      expect(firstFlightSignal?.aborted).toBe(true);
      expect(firstFlightSignal?.reason).toMatchObject({
        deadlineMs: 10,
        reason: "manual",
      });
      expect(recoveryCalls).toBe(2);
      expect(providerCalls).toBe(1);
    } finally {
      legacyRecovery.resolve(EMPTY_RECOVERY);
      await Promise.allSettled([healthyCompaction]);
    }
  });
});
