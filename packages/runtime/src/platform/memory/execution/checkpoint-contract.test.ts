import { describe, expect, it } from "vitest";
import { describeCheckpointStoreContract } from "../../../contracts/execution-store/checkpoint-contract";
import { InMemoryCheckpointStore } from "./checkpoint-store";
import { createInMemoryHost } from "./execution-host";
import { createEmptyState } from "./state";

describeCheckpointStoreContract({
  createStore: () => createInMemoryHost().store,
});

describe("in-memory checkpoint identity", () => {
  it("rejects a foreign run record without writing checkpoint state", async () => {
    // Given: the addressed map key contains another run's record.
    const state = createEmptyState();
    state.turns.set("addressed-run", {
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: "foreign-run",
      runId: "foreign-run",
      status: "running",
      threadKey: "thread",
    });
    const store = new InMemoryCheckpointStore(() => state);

    // When: fenced checkpointing addresses the corrupt key.
    const result = await store.appendFenced(
      {
        checkpointId: "addressed-checkpoint",
        phase: "before-model",
        runId: "addressed-run",
        runtimeState: {},
        threadSnapshot: {},
        version: 1,
      },
      { expectedLeaseId: null, expectedVersion: 0 }
    );

    // Then: neither addressed payload nor foreign authority is written.
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(state.checkpoints.has("addressed-run")).toBe(false);
    expect(state.turns.has("foreign-run")).toBe(false);
  });
});
