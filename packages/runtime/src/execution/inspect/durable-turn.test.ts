import { describe, expect, it, vi } from "vitest";
import { createInMemoryHost, MemoryThreadStore } from "../../platform/memory";
import type {
  Checkpoint,
  HostStore,
  TurnRecord,
  TurnStatus,
} from "../host/types";
import { inspectDurableTurn } from "./durable-turn";

const runId = "inspect-run";

describe("inspectDurableTurn", () => {
  it("reports unsupported and unknown-run boundaries explicitly", async () => {
    await expect(
      inspectDurableTurn(new MemoryThreadStore(), runId)
    ).resolves.toEqual({ runId, state: "unsupported" });

    const host = createInMemoryHost();
    const latest = vi.spyOn(host.store.checkpoints, "latest");
    await expect(inspectDurableTurn(host, runId)).resolves.toEqual({
      runId,
      state: "unknown-run",
    });
    expect(latest).not.toHaveBeenCalled();
  });

  it.each([
    ["queued", "queued"],
    ["running", "running"],
    ["resumed", "leased"],
    ["completed", "completed"],
    ["failed", "error"],
    ["cancelled", "cancelled"],
  ] satisfies readonly (readonly [string, TurnStatus])[])(
    "reports the %s lifecycle boundary without a checkpoint",
    async (_boundary, status) => {
      const host = createInMemoryHost();
      const turn = turnRecord(status);
      await host.store.turns.create(turn);

      await expect(inspectDurableTurn(host.store, runId)).resolves.toEqual({
        checkpointVersion: 0,
        latestCheckpoint: null,
        runId,
        state: "no-checkpoint",
        status,
        threadKey: "inspect-thread",
      });
    }
  );

  it("returns the latest checkpoint and matching version atomically", async () => {
    const host = createInMemoryHost();
    await host.store.turns.create(turnRecord("running"));
    const checkpoint = inspectionCheckpoint();
    await host.store.checkpoints.append(checkpoint, { expectedVersion: 0 });
    const transaction = vi.spyOn(host.store, "transaction");

    await expect(inspectDurableTurn(host, runId)).resolves.toEqual({
      checkpointVersion: 1,
      latestCheckpoint: checkpoint,
      runId,
      state: "checkpointed",
      status: "running",
      threadKey: "inspect-thread",
    });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("uses transaction ports instead of reading the outer store", async () => {
    const host = createInMemoryHost();
    await host.store.turns.create(turnRecord("queued"));
    const source: HostStore = {
      ...host.store,
      checkpoints: {
        ...host.store.checkpoints,
        latest: () => Promise.reject(new Error("outer checkpoint read")),
      },
      transaction: (callback) => host.store.transaction(callback),
      turns: {
        ...host.store.turns,
        get: () => Promise.reject(new Error("outer turn read")),
      },
    };

    await expect(inspectDurableTurn(source, runId)).resolves.toMatchObject({
      runId,
      state: "no-checkpoint",
      status: "queued",
    });
  });
});

function turnRecord(status: TurnStatus): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status,
    threadKey: "inspect-thread",
  };
}

function inspectionCheckpoint(): Checkpoint {
  return {
    checkpointId: "inspect-checkpoint-1",
    phase: "before-model",
    runId,
    runtimeState: { runtimeStepIndex: 1 },
    threadSnapshot: { history: [] },
    version: 1,
  };
}
