import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";

describe("turn transition conflict errors", () => {
  it("rejects stale terminal settlement with typed lease-conflict fields", async () => {
    // Given: owner A starts a run before owner B reclaims its expired lease.
    const host = createInMemoryHost();
    const runId = "typed-terminal-conflict";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread",
    });
    const firstClaim = await host.store.turns.claim(runId, {
      attempt: 1,
      leaseId: "owner-a",
      leaseMs: 100,
      nowMs: 10,
    });
    if (!firstClaim.ok) {
      throw new Error("Expected owner A to claim the run.");
    }
    const execution = await startThreadExecutionRun({
      executionHost: host,
      executionRun: { kind: "user-turn", leaseId: "owner-a", runId },
      state: new ThreadState({ key: "thread", store: host.store.threads }),
      threadKey: "thread",
      turnId: "unused",
    });
    if (!execution) {
      throw new Error("Expected a running execution.");
    }
    const secondClaim = await host.store.turns.claim(runId, {
      attempt: 2,
      leaseId: "owner-b",
      leaseMs: 100,
      nowMs: 200,
    });
    if (!secondClaim.ok) {
      throw new Error("Expected owner B to reclaim the run.");
    }

    // When: stale owner A attempts terminal settlement.
    const completion = execution.complete("completed");

    // Then: rejection exposes the typed transition-conflict contract.
    await expect(completion).rejects.toMatchObject({
      name: "TurnTransitionConflictError",
      operation: "complete",
      reason: "lease-conflict",
      runId,
    });
  });
});
