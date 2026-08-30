import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";
import { createThreadToolExecutionContext } from "./execution-checkpoints";

const LEASE_ERROR_PATTERN = /lease/i;

describe("thread execution lease fencing", () => {
  it("rejects checkpoints from a stale run lease", async () => {
    const host = createInMemoryHost();
    await createReclaimedRun(host, "checkpoint-stale");
    const context = Reflect.apply(createThreadToolExecutionContext, undefined, [
      {
        executionHost: host,
        leaseId: "owner-a",
        runId: "checkpoint-stale",
        state: createState(host),
      },
    ]);
    if (!context.beforeTool) {
      throw new Error("Expected a before-tool checkpoint hook.");
    }
    await expect(
      context.beforeTool({
        attempt: 1,
        idempotencyKey: "checkpoint-stale:tool-1",
        input: {},
        policy: "idempotent",
        toolCallId: "tool-1",
        toolName: "test",
      })
    ).rejects.toThrow(LEASE_ERROR_PATTERN);
    await expect(
      host.store.checkpoints.latest("checkpoint-stale")
    ).resolves.toBeNull();
  });

  it("rejects terminal settlement from a stale run lease", async () => {
    const host = createInMemoryHost();
    const runId = "completion-stale";
    await createRun(host, runId);
    const first = await claim(host, runId, "owner-a", 10);
    const execution = await startThreadExecutionRun({
      executionHost: host,
      executionRun: { kind: "user-turn", leaseId: "owner-a", runId },
      state: createState(host),
      threadKey: "thread",
      turnId: "unused",
    });
    if (!execution) {
      throw new Error("Expected a running execution.");
    }
    const second = await claim(host, runId, "owner-b", 200);

    await expect(execution.complete("completed")).rejects.toThrow(
      LEASE_ERROR_PATTERN
    );
    await expect(host.store.turns.get(runId)).resolves.toEqual(second);
    expect(first.lease?.leaseId).toBe("owner-a");
  });
});

type Host = ReturnType<typeof createInMemoryHost>;

function createState(host: Host): ThreadState {
  return new ThreadState({ key: "thread", store: host.store.threads });
}

async function createRun(host: Host, runId: string): Promise<void> {
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status: "queued",
    threadKey: "thread",
  });
}

async function createReclaimedRun(host: Host, runId: string): Promise<void> {
  await createRun(host, runId);
  const first = await claim(host, runId, "owner-a", 10);
  await host.store.turns.update({ ...first, status: "running" });
  await claim(host, runId, "owner-b", 200);
}

async function claim(
  host: Host,
  runId: string,
  leaseId: string,
  nowMs: number
) {
  const result = await host.store.turns.claim(runId, {
    attempt: 1,
    leaseId,
    leaseMs: 100,
    nowMs,
  });
  if (!result.ok) {
    throw new Error(`Expected ${leaseId} to claim ${runId}.`);
  }
  return result.record;
}
