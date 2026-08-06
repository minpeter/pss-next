import { describe, expect, it } from "vitest";
import { describeExecutionSchedulerContract } from "../../contracts/execution-scheduler/contract";
import { describeExecutionStoreContract } from "../../contracts/execution-store/contract";
import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../execution/scheduled-work";
import { InMemoryExecutionStore } from "../memory/execution/store";
import { drainSqlQueue } from "./drainer";
import { createSqlQueueHost } from "./host";
import type {
  SqlQueueClaim,
  SqlQueueClaimOptions,
  SqlQueueListOptions,
  SqlQueueNackOptions,
  SqlQueuePort,
  SqlQueueRenewLeaseOptions,
  SqlQueueWork,
} from "./queue";
import { reconcileSqlQueuedWork } from "./reconciliation";
import { SqlHostStore } from "./store";

describeExecutionStoreContract({
  createStore: () => new SqlHostStore(new InMemoryExecutionStore()),
  name: "SQL port adapter (in-memory reference)",
});

class ReferenceQueue implements SqlQueuePort {
  readonly #attempts = new Map<string, number>();
  readonly #leases = new Map<string, SqlQueueClaim>();
  #nextClaimId = 1;
  readonly work = new Map<string, SqlQueueWork>();

  ack(claim: SqlQueueClaim): Promise<void> {
    this.#assertCurrentClaim(claim);
    this.#leases.delete(claim.work.workId);
    this.work.delete(claim.work.workId);
    return Promise.resolve();
  }

  claim(options: SqlQueueClaimOptions): Promise<SqlQueueClaim | null> {
    const work = [...this.work.values()].find((item) => {
      const lease = this.#leases.get(item.workId);
      return (
        item.dueAtMs <= options.nowMs &&
        !options.excludeWorkIds?.includes(item.workId) &&
        (!lease || lease.leaseUntilMs <= options.nowMs)
      );
    });
    if (!work) {
      return Promise.resolve(null);
    }
    const attempt = (this.#attempts.get(work.workId) ?? 0) + 1;
    this.#attempts.set(work.workId, attempt);
    const claim: SqlQueueClaim = {
      attempt,
      claimId: `claim-${this.#nextClaimId++}`,
      leaseUntilMs: options.nowMs + options.leaseMs,
      work: structuredClone(work),
    };
    this.#leases.set(work.workId, claim);
    return Promise.resolve(claim);
  }

  enqueue(item: SqlQueueWork): Promise<void> {
    if (!this.work.has(item.workId)) {
      this.work.set(item.workId, structuredClone(item));
    }
    return Promise.resolve();
  }

  list(options: SqlQueueListOptions): Promise<readonly SqlQueueWork[]> {
    const due = [...this.work.values()].filter(
      (item) => item.dueAtMs <= options.nowMs
    );
    return Promise.resolve(
      due
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
        .map((item) => structuredClone(item))
    );
  }

  nack(claim: SqlQueueClaim, options: SqlQueueNackOptions): Promise<void> {
    this.#assertCurrentClaim(claim);
    this.#leases.delete(claim.work.workId);
    this.work.set(claim.work.workId, {
      ...claim.work,
      dueAtMs: options.retryAtMs,
    });
    return Promise.resolve();
  }

  renewLease(
    claim: SqlQueueClaim,
    options: SqlQueueRenewLeaseOptions
  ): Promise<SqlQueueClaim> {
    this.#assertCurrentClaim(claim);
    const current = this.#leases.get(claim.work.workId);
    if (!(current && current.leaseUntilMs > options.nowMs)) {
      return Promise.reject(new Error("queue lease expired"));
    }
    const renewed = { ...current, leaseUntilMs: options.leaseUntilMs };
    this.#leases.set(claim.work.workId, renewed);
    return Promise.resolve(structuredClone(renewed));
  }

  #assertCurrentClaim(claim: SqlQueueClaim): void {
    if (this.#leases.get(claim.work.workId)?.claimId !== claim.claimId) {
      throw new Error("stale queue claim");
    }
  }
}

describeExecutionSchedulerContract({
  createHarness: () => {
    const queue = new ReferenceQueue();
    const scheduler = createSqlQueueHost({
      queue,
      store: new InMemoryExecutionStore(),
    }).scheduler;
    return {
      ackRun: (runId: string) => {
        queue.work.delete(`run:${runId}`);
        return Promise.resolve();
      },
      ackThreadPrompt: (prompt: ScheduledThreadPrompt) => {
        queue.work.delete(
          `thread-prompt:${threadPromptScheduledWorkId(prompt)}`
        );
        return Promise.resolve();
      },
      listRuns: (options: { limit?: number; nowMs?: number } = {}) =>
        Promise.resolve(
          [...queue.work.values()]
            .filter(
              (item) =>
                item.kind === "run" &&
                item.dueAtMs <= (options.nowMs ?? Date.now())
            )
            .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
            .map((item) => (item.kind === "run" ? item.runId : ""))
        ),
      listThreadPrompts: (options: { limit?: number; nowMs?: number } = {}) =>
        Promise.resolve(
          [...queue.work.values()]
            .filter(
              (item) =>
                item.kind === "thread-prompt" &&
                item.dueAtMs <= (options.nowMs ?? Date.now())
            )
            .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
            .flatMap((item) =>
              item.kind === "thread-prompt" ? [item.prompt] : []
            )
        ),
      scheduler,
    };
  },
  name: "SQL queue reference",
  supportsDueTimeFiltering: true,
});

describe("SQL queue wake behavior", () => {
  it("persists work before signaling wake", async () => {
    const calls: string[] = [];
    const queue: SqlQueuePort = {
      ack: () => Promise.resolve(),
      claim: () => Promise.resolve(null),
      enqueue: () => {
        calls.push("enqueue");
        return Promise.resolve();
      },
      list: () => Promise.resolve([]),
      nack: () => Promise.resolve(),
      renewLease: (claim) => Promise.resolve(claim),
    };
    const host = createSqlQueueHost({
      clock: () => 1000,
      queue,
      store: new InMemoryExecutionStore(),
      wake: (dueAtMs) => {
        calls.push(`wake:${dueAtMs}`);
      },
    });

    await host.scheduler.enqueueRun("run-1", { runAfterMs: 250 });

    expect(calls).toEqual(["enqueue", "wake:1250"]);
  });

  it("leaves durably enqueued work available when wake fails", async () => {
    const queue = new ReferenceQueue();
    const host = createSqlQueueHost({
      queue,
      store: new InMemoryExecutionStore(),
      wake: () => {
        throw new Error("broker unavailable");
      },
    });

    await expect(host.scheduler.enqueueRun("run-1")).rejects.toThrow(
      "broker unavailable"
    );
    expect(queue.work.get("run:run-1")).toMatchObject({
      kind: "run",
      runId: "run-1",
    });
  });
});

describe("SQL queue consumer contract", () => {
  it("lists due work for inspection with a limit", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue({
      dueAtMs: 100,
      kind: "run",
      runId: "run-1",
      workId: "run:run-1",
    });
    await queue.enqueue({
      dueAtMs: 200,
      kind: "run",
      runId: "run-2",
      workId: "run:run-2",
    });

    await expect(queue.list({ limit: 1, nowMs: 150 })).resolves.toEqual([
      expect.objectContaining({ workId: "run:run-1" }),
    ]);
    await expect(queue.list({ nowMs: 99 })).resolves.toEqual([]);
  });

  it("acks work only after its handler succeeds", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue({
      dueAtMs: 100,
      kind: "run",
      runId: "run-1",
      workId: "run:run-1",
    });
    const handled: string[] = [];

    const result = await drainSqlQueue({
      clock: () => 100,
      handle: (work) => {
        handled.push(work.workId);
        return Promise.resolve();
      },
      queue,
    });

    expect(result).toEqual({ claimed: 1, failed: 0, succeeded: 1 });
    expect(handled).toEqual(["run:run-1"]);
    expect(queue.work.size).toBe(0);
  });

  it("nacks failed handlers for a later retry without losing work", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue({
      dueAtMs: 100,
      kind: "run",
      runId: "run-1",
      workId: "run:run-1",
    });

    const result = await drainSqlQueue({
      clock: () => 100,
      handle: () => Promise.reject(new Error("worker failed")),
      queue,
      retryDelayMs: 50,
    });

    expect(result).toEqual({ claimed: 1, failed: 1, succeeded: 0 });
    await expect(
      queue.claim({ leaseMs: 1000, nowMs: 149 })
    ).resolves.toBeNull();
    await expect(
      queue.claim({ leaseMs: 1000, nowMs: 150 })
    ).resolves.toMatchObject({
      attempt: 2,
      work: { workId: "run:run-1" },
    });
  });

  it("renews a long handler lease before another worker can reclaim it", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue({
      dueAtMs: 0,
      kind: "run",
      runId: "run-long",
      workId: "run:run-long",
    });
    let nowMs = 0;

    await drainSqlQueue({
      clock: () => nowMs,
      handle: async () => {
        nowMs = 20;
        await new Promise((resolve) => setTimeout(resolve, 15));
        await expect(
          queue.claim({ leaseMs: 30, nowMs: 31 })
        ).resolves.toBeNull();
      },
      heartbeatMs: 5,
      leaseMs: 30,
      queue,
    });

    expect(queue.work.size).toBe(0);
  });

  it("reports handler failures through onError after nacking", async () => {
    const queue = new ReferenceQueue();
    const error = new Error("handler failed");
    const observed: unknown[] = [];
    await queue.enqueue({
      dueAtMs: 0,
      kind: "run",
      runId: "run-error",
      workId: "run:run-error",
    });

    await drainSqlQueue({
      clock: () => 0,
      handle: () => Promise.reject(error),
      onError: (context) => {
        observed.push(context);
      },
      queue,
    });

    expect(observed).toEqual([
      expect.objectContaining({
        error,
        work: expect.objectContaining({ workId: "run:run-error" }),
      }),
    ]);
  });

  it("surfaces uncertain ack errors without nacking", async () => {
    const queue = new ReferenceQueue();
    let nackCalls = 0;
    await queue.enqueue({
      dueAtMs: 0,
      kind: "run",
      runId: "run-ack",
      workId: "run:run-ack",
    });
    const uncertainAckQueue: SqlQueuePort = {
      ack: () => Promise.reject(new Error("ack result unknown")),
      claim: queue.claim.bind(queue),
      enqueue: queue.enqueue.bind(queue),
      list: queue.list.bind(queue),
      nack: (...args) => {
        nackCalls += 1;
        return queue.nack(...args);
      },
      renewLease: queue.renewLease.bind(queue),
    };

    await expect(
      drainSqlQueue({
        clock: () => 0,
        handle: () => Promise.resolve(),
        queue: uncertainAckQueue,
      })
    ).rejects.toThrow("ack result unknown");
    expect(nackCalls).toBe(0);
    expect(queue.work.has("run:run-ack")).toBe(true);
  });

  it("handles zero-delay poison work at most once per drain pass", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue({
      dueAtMs: 0,
      kind: "run",
      runId: "poison",
      workId: "run:poison",
    });
    await queue.enqueue({
      dueAtMs: 0,
      kind: "run",
      runId: "healthy",
      workId: "run:healthy",
    });
    const handled: string[] = [];

    const result = await drainSqlQueue({
      clock: () => 0,
      handle: (work) => {
        handled.push(work.workId);
        return work.workId === "run:poison"
          ? Promise.reject(new Error("poison"))
          : Promise.resolve();
      },
      limit: 10,
      queue,
      retryDelayMs: 0,
    });

    expect(result).toEqual({ claimed: 2, failed: 1, succeeded: 1 });
    expect(handled).toEqual(["run:poison", "run:healthy"]);
    expect(queue.work.has("run:poison")).toBe(true);
    expect(queue.work.has("run:healthy")).toBe(false);
  });

  it("makes unacked work claimable after its lease expires", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue({
      dueAtMs: 0,
      kind: "run",
      runId: "run-1",
      workId: "run:run-1",
    });

    await expect(
      queue.claim({ leaseMs: 100, nowMs: 0 })
    ).resolves.toMatchObject({
      attempt: 1,
    });
    await expect(queue.claim({ leaseMs: 100, nowMs: 99 })).resolves.toBeNull();
    await expect(
      queue.claim({ leaseMs: 100, nowMs: 100 })
    ).resolves.toMatchObject({
      attempt: 2,
    });
  });
});

describe("SQL queue reconciliation", () => {
  const runWork: SqlQueueWork = {
    dueAtMs: 500,
    kind: "run",
    runId: "orphan-run",
    workId: "run:orphan-run",
  };
  const notificationPrompt: ScheduledThreadPrompt = {
    idempotencyKey: "notify-idem",
    notificationId: "notification-1",
    runId: "notification-run",
    threadKey: "thread-1",
  };
  const promptWork: SqlQueueWork = {
    dueAtMs: 700,
    kind: "thread-prompt",
    prompt: notificationPrompt,
    workId: `thread-prompt:${threadPromptScheduledWorkId(notificationPrompt)}`,
  };

  const sourceFor = (...items: readonly SqlQueueWork[]) => ({
    async *listQueuedWork() {
      await Promise.resolve();
      yield* items;
    },
  });

  it("recreates exact run work for a durable orphan", async () => {
    const queue = new ReferenceQueue();

    await expect(
      reconcileSqlQueuedWork({ queue, source: sourceFor(runWork) })
    ).resolves.toEqual({ enqueued: 1 });
    expect(queue.work.get(runWork.workId)).toEqual(runWork);
  });

  it("recreates an exact missed thread prompt without converting it to run work", async () => {
    const queue = new ReferenceQueue();

    await reconcileSqlQueuedWork({
      queue,
      source: sourceFor(promptWork),
    });

    expect(queue.work.get(promptWork.workId)).toEqual(promptWork);
    expect(queue.work.has("run:notification-run")).toBe(false);
    expect(queue.work.size).toBe(1);
  });

  it("keeps an existing notification row singular across racing reconciliation", async () => {
    const queue = new ReferenceQueue();
    await queue.enqueue(promptWork);

    await Promise.all([
      reconcileSqlQueuedWork({ queue, source: sourceFor(promptWork) }),
      reconcileSqlQueuedWork({ queue, source: sourceFor(promptWork) }),
    ]);

    expect([...queue.work.values()]).toEqual([promptWork]);
    expect(queue.work.has("run:notification-run")).toBe(false);
  });

  it("can retry reconciliation after enqueue fails", async () => {
    const durableQueue = new ReferenceQueue();
    let shouldFail = true;
    const queue = {
      enqueue: async (work: SqlQueueWork) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("queue unavailable");
        }
        await durableQueue.enqueue(work);
      },
    };

    await expect(
      reconcileSqlQueuedWork({ queue, source: sourceFor(runWork) })
    ).rejects.toThrow("queue unavailable");
    expect(durableQueue.work.size).toBe(0);
    await expect(
      reconcileSqlQueuedWork({ queue, source: sourceFor(runWork) })
    ).resolves.toEqual({ enqueued: 1 });
    expect(durableQueue.work.get(runWork.workId)).toEqual(runWork);
  });
});
