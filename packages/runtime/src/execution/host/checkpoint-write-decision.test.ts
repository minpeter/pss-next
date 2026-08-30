import { describe, expect, it } from "vitest";
import { decideLeaseFencedCheckpointWrite } from "./checkpoint-write-decision";
import type { Checkpoint, TurnRecord } from "./types";

describe("lease-fenced checkpoint identity", () => {
  it("rejects a stored run whose identity differs from the addressed run", () => {
    // Given: all authority fields match except the persisted record identity.
    const foreignRun: TurnRecord = {
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: "foreign-run",
      runId: "foreign-run",
      status: "running",
      threadKey: "thread",
    };
    const checkpoint: Checkpoint = {
      checkpointId: "addressed-checkpoint",
      phase: "before-model",
      runId: "addressed-run",
      runtimeState: { marker: "must-not-persist" },
      threadSnapshot: {},
      version: 1,
    };

    // When/Then: the addressed identity fails closed before version writes.
    expect(
      decideLeaseFencedCheckpointWrite(
        "addressed-run",
        foreignRun,
        checkpoint,
        { expectedLeaseId: null, expectedVersion: 0 }
      )
    ).toEqual({ ok: false, reason: "not-found" });
  });
});
