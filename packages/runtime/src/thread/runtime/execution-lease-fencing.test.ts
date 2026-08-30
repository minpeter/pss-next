import { describe, expect, it } from "vitest";
import { transitionTurn } from "../../execution/host/turn-status";
import type {
  AgentHost,
  TurnTransitionExpected,
  TurnTransitionUpdate,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/input-fixtures";
import type { QueuedInput } from "../input/runtime-input";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";
import { createThreadToolExecutionContext } from "./execution-checkpoints";
import { queueThreadNotification } from "./notification";

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

  it("fences an execution that started before another owner claimed it", async () => {
    // Given: an unleased queued run starts without ownership.
    const host = createInMemoryHost();
    const runId = "initially-unleased";
    await createRun(host, runId);
    const execution = await startThreadExecutionRun({
      executionHost: host,
      executionRun: { kind: "user-turn", runId },
      state: createState(host),
      threadKey: "thread",
      turnId: "unused",
    });
    if (!execution) {
      throw new Error("Expected a running execution.");
    }

    // When: owner B becomes the first lease holder after execution starts.
    const claimedByOwnerB = await claim(host, runId, "owner-b", 10);

    // Then: the earlier unleased execution cannot settle owner B's run.
    await expect(execution.complete("completed")).rejects.toThrow(
      LEASE_ERROR_PATTERN
    );
    await expect(host.store.turns.get(runId)).resolves.toEqual(claimedByOwnerB);
  });

  it("uses the transition result instead of adopting a lease from a later get", async () => {
    // Given: owner A starts a queued run and a later read injects owner B's lease.
    const base = createInMemoryHost();
    const runId = "transition-result-owner";
    await createRun(base, runId);
    await claim(base, runId, "owner-a", 10);
    let injectOwnerB = false;
    const turns = new Proxy(base.store.turns, {
      get(target, property) {
        if (property === "transition") {
          return async (
            transitionedRunId: string,
            expected: TurnTransitionExpected,
            update: TurnTransitionUpdate
          ) => {
            const result = await transitionTurn(target, {
              expected,
              runId: transitionedRunId,
              update,
            });
            injectOwnerB = result.ok;
            return result;
          };
        }
        if (property === "get") {
          return async (requestedRunId: string) => {
            if (injectOwnerB) {
              injectOwnerB = false;
              await claim(base, requestedRunId, "owner-b", 200);
            }
            return await target.get(requestedRunId);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = new Proxy(base.store, {
      get(target, property) {
        if (property === "turns") {
          return turns;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const host: AgentHost = { ...base, store };

    // When: start transitions with owner A before the hooked get returns owner B.
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

    // Then: the execution remains fenced as owner A rather than adopting B.
    await expect(execution.complete("completed")).rejects.toThrow(
      LEASE_ERROR_PATTERN
    );
    await expect(base.store.turns.get(runId)).resolves.toMatchObject({
      lease: { leaseId: "owner-b" },
      status: "leased",
    });
  });

  it("preserves the initiating lease when queueing a notification run", async () => {
    // Given: notification owner A supplies its claimed execution run.
    const host = createInMemoryHost();
    const inputQueue: QueuedInput[] = [];

    // When: the notification is queued for a dedicated run.
    await queueThreadNotification(
      userText("notification"),
      {
        executionRun: {
          kind: "notification",
          leaseId: "owner-a",
          runId: "notification-owner",
        },
      },
      {
        activeRun: undefined,
        activeRuntimeInput: undefined,
        attachmentStore: undefined,
        drain: () => Promise.resolve(),
        emitObserverEvent: () => Promise.resolve(),
        executionHost: host,
        inputQueue,
        pendingRuntimeInputs: [],
        threadKey: "thread",
        throwIfTerminal: () => undefined,
      }
    );

    // Then: the queued execution retains the lease consumed by start.
    expect(inputQueue).toHaveLength(1);
    expect(inputQueue.at(0)?.executionRun).toEqual({
      kind: "notification",
      leaseId: "owner-a",
      runId: "notification-owner",
    });
  });
});

type Host = ReturnType<typeof createInMemoryHost>;

function createState(host: AgentHost): ThreadState {
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
