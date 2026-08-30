import { describe, expect, it } from "vitest";
import { transitionTurn } from "../../execution/host/turn-status";
import type {
  AgentHost,
  TurnTransitionExpected,
  TurnTransitionUpdate,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { createRuntimeInputState } from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { cancelThreadExecutionRun } from "./execution";
import { closeKilledRuntimeInputs } from "./kill";

describe("thread execution cancellation races", () => {
  it("does not adopt a replacement live lease during run-id-only cancellation", async () => {
    // Given: owner B has replaced the expired owner of a queued run.
    const host = createInMemoryHost();
    const runId = "replacement-owner-cancellation";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread",
    });
    const ownerA = await host.store.turns.claim(runId, {
      attempt: 1,
      leaseId: "owner-a",
      leaseMs: 100,
      nowMs: 10,
    });
    if (!ownerA.ok) {
      throw new TypeError("Expected owner A to claim the run.");
    }
    const ownerB = await host.store.turns.claim(runId, {
      attempt: 2,
      leaseId: "owner-b",
      leaseMs: 100,
      nowMs: 200,
    });
    if (!ownerB.ok) {
      throw new TypeError("Expected owner B to replace the expired lease.");
    }

    // When: explicit kill has only the active turn's ownerless run id.
    const cancellation = closeKilledRuntimeInputs({
      activeRuntimeInput: createRuntimeInputState([]),
      executionHost: host,
      inputQueue: [],
      message: "killed",
      runToClose: new BufferedAgentTurn(runId),
      threadKey: "thread",
    });

    // Then: cancellation cannot borrow owner B's lease.
    await expect(cancellation).rejects.toMatchObject({
      name: "TurnTransitionConflictError",
      reason: "lease-conflict",
      runId,
    });
    await expect(host.store.turns.get(runId)).resolves.toEqual(ownerB.record);
  });

  it("cancels the active run with its captured lease", async () => {
    // Given: an active turn retains the lease captured when it was claimed.
    const host = createInMemoryHost();
    const runId = "owned-active-cancellation";
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
    const run = new BufferedAgentTurn();
    run.bindRunId(runId, "owner-a");

    // When: explicit kill cancels the active turn.
    await closeKilledRuntimeInputs({
      activeRuntimeInput: createRuntimeInputState([]),
      executionHost: host,
      inputQueue: [],
      message: "killed",
      runToClose: run,
      threadKey: "thread",
    });

    // Then: cancellation uses owner A's authority.
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      lease: { leaseId: "owner-a" },
      status: "cancelled",
    });
  });

  it("treats a concurrent terminal transition as completed cancellation", async () => {
    // Given: cancellation reads a queued run before another path completes it.
    const base = createInMemoryHost();
    const runId = "concurrent-terminal-cancellation";
    await base.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread",
    });
    const turns = new Proxy(base.store.turns, {
      get(target, property) {
        if (property === "transition") {
          return async (
            transitionedRunId: string,
            expected: TurnTransitionExpected,
            update: TurnTransitionUpdate
          ) => {
            const current = await target.get(transitionedRunId);
            if (!current) {
              throw new Error("Expected the cancellation run.");
            }
            await target.update({ ...current, status: "completed" });
            return await transitionTurn(target, {
              expected,
              runId: transitionedRunId,
              update,
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const host: AgentHost = { ...base, store: { ...base.store, turns } };

    // When: cancellation loses its transition race to terminal completion.
    await cancelThreadExecutionRun({
      cancellation: { kind: "unleased", runId },
      executionHost: host,
    });

    // Then: the already-terminal outcome is accepted idempotently.
    await expect(base.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });
});
