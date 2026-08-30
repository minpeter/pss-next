import { describe, expect, it } from "vitest";
import type { HostStore, TurnStatus } from "../../execution";
import { createQueuedRun } from "./fixtures";

export function describeExecutionLeaseContract(
  name: string,
  createStore: () => HostStore
): void {
  describe(`${name} lease fencing`, () => {
    it.each([
      ["queued", true],
      ["leased", true],
      ["running", true],
      ["suspended", true],
      ["needs-recovery", false],
      ["completed", false],
      ["cancelled", false],
      ["error", false],
    ] satisfies readonly (readonly [TurnStatus, boolean])[])(
      "uses the shared claim decision for %s",
      async (status, claimable) => {
        const store = createStore();
        const runId = `run-${status}`;
        const created = await store.turns.create(createQueuedRun(runId));
        await store.turns.update({ ...created.record, status });

        const result = await store.turns.claim(
          runId,
          claimOptions("owner", 10)
        );
        expect(result.ok).toBe(claimable);
        if (!claimable) {
          expect(result).toEqual({
            ok: false,
            reason: "not-claimable",
          });
        }
      }
    );

    it("keeps a live running lease and rejects recovery claims", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-live"));
      const claimed = await claim(store, "run-live", "owner-a", 10);
      await store.turns.update({ ...claimed, status: "running" });
      await expect(
        store.turns.claim("run-live", claimOptions("owner-b", 20))
      ).resolves.toEqual({ ok: false, reason: "leased" });

      const recovery = await store.turns.create(
        createQueuedRun("run-recovery")
      );
      await store.turns.update({
        ...recovery.record,
        status: "needs-recovery",
      });
      await expect(
        store.turns.claim("run-recovery", claimOptions("owner", 10))
      ).resolves.toEqual({ ok: false, reason: "not-claimable" });
    });

    it.each([
      "cancelled",
      "completed",
      "error",
      "needs-recovery",
    ] satisfies readonly TurnStatus[])(
      "reports non-claimable %s before considering stale lease data",
      async (status) => {
        const store = createStore();
        const runId = `run-live-${status}`;
        await store.turns.create(createQueuedRun(runId));
        const claimed = await claim(store, runId, "owner-a", 10);
        await store.turns.update({ ...claimed, status });

        await expect(
          store.turns.claim(runId, claimOptions("owner-b", 20))
        ).resolves.toEqual({ ok: false, reason: "not-claimable" });
      }
    );

    it("rejects stale-owner transitions and checkpoints", async () => {
      const store = createStore();
      await store.turns.create(createQueuedRun("run-fenced"));
      const first = await claim(store, "run-fenced", "owner-a", 10);
      await store.turns.update({ ...first, status: "running" });
      const second = await claim(store, "run-fenced", "owner-b", 200);

      await expect(
        store.turns.transition(
          "run-fenced",
          { leaseId: "owner-a", status: "leased" },
          { ...first, lease: undefined, status: "completed" }
        )
      ).resolves.toEqual({ ok: false, reason: "lease-conflict" });
      await expect(
        store.checkpoints.append(
          {
            checkpointId: "checkpoint-fenced",
            phase: "before-model",
            runId: "run-fenced",
            runtimeState: {},
            threadSnapshot: {},
            version: 1,
          },
          { expectedLeaseId: "owner-a", expectedVersion: 0 }
        )
      ).resolves.toEqual({ ok: false, reason: "lease-conflict" });
      await expect(store.turns.get("run-fenced")).resolves.toEqual(second);
      await expect(store.checkpoints.latest("run-fenced")).resolves.toBeNull();
    });
  });
}

function claimOptions(leaseId: string, nowMs: number) {
  return { attempt: 1, leaseId, leaseMs: 100, nowMs };
}

async function claim(
  store: HostStore,
  runId: string,
  leaseId: string,
  nowMs: number
) {
  const result = await store.turns.claim(runId, claimOptions(leaseId, nowMs));
  if (!result.ok) {
    throw new Error(`Expected ${leaseId} to claim ${runId}.`);
  }
  return result.record;
}
