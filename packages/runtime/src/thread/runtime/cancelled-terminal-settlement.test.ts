import { describe, expect, it, vi } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";

describe("cancelled terminal settlement", () => {
  it("does not persist terminal effects after cancellation already wins", async () => {
    // Given: an owned execution whose durable run is already cancelled.
    const host = createInMemoryHost();
    const runId = "cancelled-before-completion";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread",
    });
    const claimed = await host.store.turns.claim(runId, {
      attempt: 1,
      leaseId: "owner-a",
      leaseMs: 100,
      nowMs: 10,
    });
    if (!claimed.ok) {
      throw new TypeError("Expected owner A to claim the run.");
    }
    const execution = await startThreadExecutionRun({
      executionHost: host,
      executionRun: { kind: "user-turn", leaseId: "owner-a", runId },
      state: new ThreadState({ key: "thread", store: host.store.threads }),
      threadKey: "thread",
      turnId: "unused",
    });
    if (!execution) {
      throw new TypeError("Expected a running execution.");
    }
    await execution.complete("cancelled");
    const persist = vi.fn(() =>
      Promise.resolve({ ok: true, version: "forged" } as const)
    );

    // When/Then: neither completion nor a split cancellation can persist.
    for (const status of ["completed", "cancelled"] as const) {
      await expect(execution.settle(status, persist)).rejects.toMatchObject({
        name: "TurnTransitionConflictError",
        reason: "status-conflict",
        runId,
      });
    }
    expect(persist).not.toHaveBeenCalled();
  });
});
