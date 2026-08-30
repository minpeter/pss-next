import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  Checkpoint,
  CheckpointStore,
  CheckpointWriteResult,
} from "../execution";
import { UnsupportedCheckpointFencingError } from "../execution";
import { createInMemoryHost } from "../platform/memory";
import { createThreadToolExecutionContext } from "../thread/runtime/execution-checkpoints";
import { ThreadState } from "../thread/state/thread-state";

const originShapedStore: CheckpointStore = {
  append: (_checkpoint, _options) => Promise.resolve({ ok: true, version: 1 }),
  latest: (_runId) => Promise.resolve(null),
};

function exhaustReleasedResult(result: CheckpointWriteResult): number {
  if (result.ok) {
    return result.version;
  }
  return result.currentVersion;
}

const releasedResultValue = exhaustReleasedResult({
  currentVersion: 0,
  ok: false,
  reason: "stale-version",
});

const checkpointFixture: Checkpoint = {
  checkpointId: "compatibility-checkpoint",
  phase: "before-model",
  runId: "compatibility-run",
  runtimeState: {},
  threadSnapshot: {},
  version: 1,
};

describe("checkpoint API compatibility", () => {
  it("keeps the released result exhaustive and origin store assignable", async () => {
    // Given: the released stale result and an origin-shaped store.
    // When: consumers exhaust the result and call the legacy append shape.
    const append = originShapedStore.append(checkpointFixture, {
      expectedVersion: 0,
    });

    // Then: both compile and retain their released machine values.
    expect(releasedResultValue).toBe(0);
    await expect(append).resolves.toEqual({ ok: true, version: 1 });
  });

  it("fails closed before calling an origin-shaped legacy append", async () => {
    // Given: a host whose third-party checkpoint store implements only the
    // released append/latest contract.
    const base = createInMemoryHost();
    const runId = "legacy-checkpoint-store";
    await base.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "running",
      threadKey: "thread",
    });
    let appendCalls = 0;
    const legacyCheckpoints: CheckpointStore = {
      append: () => {
        appendCalls += 1;
        return Promise.resolve({ ok: true, version: 1 });
      },
      latest: originShapedStore.latest,
    };
    const host: AgentHost = {
      ...base,
      store: {
        checkpoints: legacyCheckpoints,
        events: base.store.events,
        inputs: base.store.inputs,
        notifications: base.store.notifications,
        threadEvents: base.store.threadEvents,
        threads: base.store.threads,
        transaction: base.store.transaction.bind(base.store),
        turns: base.store.turns,
      },
    };
    const context = createThreadToolExecutionContext({
      executionHost: host,
      leaseId: null,
      runId,
      state: new ThreadState({ key: "thread", store: host.store.threads }),
    });
    if (!context.beforeTool) {
      throw new Error("Expected a before-tool checkpoint hook.");
    }

    // When: runtime-owned checkpointing requires lease fencing.
    const write = context.beforeTool({
      attempt: 1,
      idempotencyKey: "legacy-checkpoint-store:tool",
      input: {},
      policy: "idempotent",
      toolCallId: "tool-1",
      toolName: "test",
    });

    // Then: the capability error is actionable and legacy append is untouched.
    await expect(write).rejects.toBeInstanceOf(
      UnsupportedCheckpointFencingError
    );
    await expect(write).rejects.toMatchObject({ runId });
    expect(appendCalls).toBe(0);
  });
});
