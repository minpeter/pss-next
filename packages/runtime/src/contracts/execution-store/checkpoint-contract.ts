import { describe, expect, it } from "vitest";
import type {
  Checkpoint,
  HostStore,
  LeaseFencedCheckpointStore,
  TurnStatus,
} from "../../execution";
import { createQueuedRun } from "./fixtures";

interface CheckpointContractOptions {
  readonly createStore: () => HostStore;
}

const TERMINAL_STATUSES = [
  "cancelled",
  "completed",
  "error",
  "needs-recovery",
] as const satisfies readonly TurnStatus[];

export function describeCheckpointStoreContract({
  createStore,
}: CheckpointContractOptions): void {
  describe("checkpoint writes", () => {
    it("preserves the released legacy append result", async () => {
      // Given: a run at checkpoint version zero.
      const store = createStore();
      await store.turns.create(createQueuedRun());

      // When: legacy append writes the next checkpoint.
      const result = await store.checkpoints.append(checkpoint(1), {
        expectedVersion: 0,
      });

      // Then: the released success shape and authority update are preserved.
      expect(result).toEqual({ ok: true, version: 1 });
      await expect(store.turns.get("run-1")).resolves.toMatchObject({
        checkpointVersion: 1,
      });
    });

    it("preserves the released legacy stale-version result", async () => {
      // Given: a run at checkpoint version zero.
      const store = createStore();
      await store.turns.create(createQueuedRun());

      // When: legacy append expects a different authority version.
      const result = await store.checkpoints.append(checkpoint(1), {
        expectedVersion: 7,
      });

      // Then: only the released stale-version variant is returned.
      expect(result).toEqual({
        currentVersion: 0,
        ok: false,
        reason: "stale-version",
      });
    });

    it.each([
      ["missing", undefined, "not-found"],
      ["replacement owner", leasedRun("owner-b"), "lease-conflict"],
      ["terminal", createQueuedRunWithStatus("completed"), "status-conflict"],
    ] as const)("fences %s authority", async (_caseName, run, reason) => {
      // Given: fenced checkpoint authority that cannot authorize owner A.
      const store = createStore();
      if (run) {
        await store.turns.create(run);
      }

      // When: owner A attempts a fenced append.
      const result = await fenced(store).appendFenced(checkpoint(1), {
        expectedLeaseId: "owner-a",
        expectedVersion: 0,
      });

      // Then: the precise authority conflict is returned without a write.
      expect(result).toEqual({ ok: false, reason });
      await expect(store.checkpoints.latest("run-1")).resolves.toBeNull();
    });

    it.each(TERMINAL_STATUSES)(
      "rejects fenced writes after %s settlement",
      async (status) => {
        // Given: a terminal run.
        const store = createStore();
        await store.turns.create(createQueuedRunWithStatus(status));

        // When: an unleased fenced write is attempted.
        const result = await fenced(store).appendFenced(checkpoint(1), {
          expectedLeaseId: null,
          expectedVersion: 0,
        });

        // Then: terminal settlement remains immutable.
        expect(result).toEqual({ ok: false, reason: "status-conflict" });
      }
    );

    it("accepts the exact next version for the captured owner", async () => {
      // Given: a run leased to owner A.
      const store = createStore();
      await store.turns.create(leasedRun());

      // When: owner A appends the exact next checkpoint.
      const result = await fenced(store).appendFenced(checkpoint(1), {
        expectedLeaseId: "owner-a",
        expectedVersion: 0,
      });

      // Then: checkpoint payload and run authority advance together.
      expect(result).toEqual({ ok: true, version: 1 });
      await expect(store.checkpoints.latest("run-1")).resolves.toEqual(
        checkpoint(1)
      );
      await expect(store.turns.get("run-1")).resolves.toMatchObject({
        checkpointVersion: 1,
      });
    });

    it("rejects non-successor fenced versions", async () => {
      // Given: an unleased run at version zero.
      const store = createStore();
      await store.turns.create(createQueuedRun());

      // When: fenced append skips the exact successor.
      const result = await fenced(store).appendFenced(checkpoint(2), {
        expectedLeaseId: null,
        expectedVersion: 0,
      });

      // Then: the authoritative version is returned without mutation.
      expect(result).toEqual({
        currentVersion: 0,
        ok: false,
        reason: "stale-version",
      });
    });
  });
}

function fenced(store: HostStore): LeaseFencedCheckpointStore {
  const capability = store.leaseFencedCheckpoints;
  if (!capability) {
    throw new Error("First-party store lacks checkpoint fencing.");
  }
  return capability;
}

function checkpoint(version: number): Checkpoint {
  return {
    checkpointId: `checkpoint-${version}`,
    phase: "before-model",
    runId: "run-1",
    runtimeState: {},
    threadSnapshot: {},
    version,
  };
}

function leasedRun(leaseId = "owner-a") {
  return {
    ...createQueuedRun(),
    lease: { attempt: 1, leaseId, leaseUntilMs: 100 },
    status: "leased" as const,
  };
}

function createQueuedRunWithStatus(status: TurnStatus) {
  return { ...createQueuedRun(), status };
}
