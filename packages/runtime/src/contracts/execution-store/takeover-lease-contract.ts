import { describe, expect, it } from "vitest";
import { type HostStore, transitionTurn } from "../../execution";
import { createQueuedRun } from "./fixtures";

export function describeTakeoverOnlyLeaseContract(
  name: string,
  createStore: () => HostStore
): void {
  describe(`${name} takeover-only lease authority`, () => {
    it("keeps captured authority after the reclaim deadline without takeover", async () => {
      // Given: owner A captured a lease whose reclaim deadline has passed.
      const store = createStore();
      const runId = "run-expired-without-takeover";
      await store.turns.create(createQueuedRun(runId));
      await claim(store, runId, "owner-a", 0);

      // When: owner A writes using its still-persisted lease ID.
      const result = await capability(store).appendFenced(
        checkpoint(runId, "checkpoint-expired-without-takeover"),
        { expectedLeaseId: "owner-a", expectedVersion: 0 }
      );

      // Then: time alone has not revoked captured authority.
      expect(result).toEqual({ ok: true, version: 1 });
    });

    it("fences the old owner only after replacement claim persists", async () => {
      // Given: owner B atomically replaces owner A after its reclaim deadline.
      const store = createStore();
      const runId = "run-replaced-owner";
      await store.turns.create(createQueuedRun(runId));
      await claim(store, runId, "owner-a", 0);
      await claim(store, runId, "owner-b", 100);

      // When: owner A writes with its captured lease ID.
      const result = await capability(store).appendFenced(
        checkpoint(runId, "checkpoint-replaced-owner"),
        { expectedLeaseId: "owner-a", expectedVersion: 0 }
      );

      // Then: the persisted replacement lease fences owner A.
      expect(result).toEqual({ ok: false, reason: "lease-conflict" });
    });

    it("makes terminal settlement unclaimable before replacement", async () => {
      // Given: owner A settles the run after its reclaim deadline but before
      // another worker claims it.
      const store = createStore();
      const runId = "run-terminal-before-replacement";
      await store.turns.create(createQueuedRun(runId));
      await claim(store, runId, "owner-a", 0);
      await transitionTurn(store.turns, {
        expected: { leaseId: "owner-a", status: "leased" },
        runId,
        update: { status: "completed" },
      });

      // When: owner B attempts replacement at the reclaim deadline.
      const replacement = store.turns.claim(
        runId,
        claimOptions("owner-b", 100)
      );

      // Then: terminal status wins and cannot be reclaimed.
      await expect(replacement).resolves.toEqual({
        ok: false,
        reason: "not-claimable",
      });
    });
  });
}

function capability(store: HostStore) {
  const fenced = store.leaseFencedCheckpoints;
  if (!fenced) {
    throw new Error("First-party store lacks checkpoint fencing.");
  }
  return fenced;
}

function checkpoint(runId: string, checkpointId: string) {
  return {
    checkpointId,
    phase: "before-model" as const,
    runId,
    runtimeState: {},
    threadSnapshot: {},
    version: 1,
  };
}

function claimOptions(leaseId: string, nowMs: number) {
  return { attempt: 1, leaseId, leaseMs: 100, nowMs };
}

async function claim(
  store: HostStore,
  runId: string,
  leaseId: string,
  nowMs: number
): Promise<void> {
  const result = await store.turns.claim(runId, claimOptions(leaseId, nowMs));
  if (!result.ok) {
    throw new Error(`Expected ${leaseId} to claim ${runId}.`);
  }
}
