import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentHost } from "../../execution/host/types";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage,
} from "../../platform/durable-object/host/storage-host";
import {
  createFileHost,
  listScheduledNodeRuns,
  listScheduledNodeThreadPrompts,
} from "../../platform/file";
import { createInMemoryHost } from "../../platform/memory";
import { createCallbackModel } from "../../testing/test-fixtures";

const durableHosts = [
  ["memory", () => createInMemoryHost()],
  [
    "Durable Object",
    () =>
      createDurableObjectStorageHost({
        storage: new InMemoryDurableObjectStorage(),
      }),
  ],
] as const;

describe("public durable thread deletion", () => {
  it.each(durableHosts)(
    "removes all %s execution data",
    async (_name, createHost) => {
      // Given: aggregate runtime data reachable through a public thread.
      const host = createHost();
      await seedThreadData(host);

      // When: the public thread is deleted.
      await new Agent({
        host,
        model: createCallbackModel(() => Promise.resolve([])),
      })
        .thread("victim")
        .delete();

      // Then: no durable execution data survives.
      await expectThreadDataDeleted(host);
    }
  );

  it("removes file execution data and scheduled work atomically", async () => {
    // Given: a file host with aggregate and scheduled thread work.
    const directory = await mkdtemp(join(tmpdir(), "pss-thread-delete-"));
    try {
      const host = createFileHost({ directory });
      await seedThreadData(host);
      await host.scheduler.enqueueRun("run-victim");
      await host.scheduler.resumeThread("victim", {
        idempotencyKey: "delete-notification",
        notificationId: "delete-notification",
        runId: "run-victim",
      });

      // When: the public thread is deleted.
      await new Agent({
        host,
        model: createCallbackModel(() => Promise.resolve([])),
      })
        .thread("victim")
        .delete();

      // Then: the generation and its scheduled work are both clean.
      await expectThreadDataDeleted(host);
      await expect(listScheduledNodeRuns(directory)).resolves.toEqual([]);
      await expect(listScheduledNodeThreadPrompts(directory)).resolves.toEqual(
        []
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("removes memory scheduled work while preserving unrelated work", async () => {
    // Given: memory scheduling contains victim and survivor aggregates.
    const host = createInMemoryHost();
    await seedThreadData(host);
    await host.scheduler.enqueueRun("run-victim");
    await host.scheduler.enqueueRun("run-survivor");
    await host.scheduler.resumeThread("victim", {
      idempotencyKey: "delete-notification",
      notificationId: "delete-notification",
      runId: "run-victim",
    });
    await host.scheduler.resumeThread("survivor", {
      idempotencyKey: "keep-notification",
      notificationId: "keep-notification",
      runId: "run-survivor",
    });

    // When: the victim thread is deleted through the public API.
    await new Agent({
      host,
      model: createCallbackModel(() => Promise.resolve([])),
    })
      .thread("victim")
      .delete();

    // Then: only unrelated scheduled work remains reachable.
    await expect(host.scheduler.listScheduledRuns()).resolves.toEqual([
      "run-survivor",
    ]);
    await expect(host.scheduler.listScheduledThreadPrompts()).resolves.toEqual([
      {
        idempotencyKey: "keep-notification",
        notificationId: "keep-notification",
        runId: "run-survivor",
        threadKey: "survivor",
      },
    ]);
  });
});

async function seedThreadData(host: AgentHost): Promise<void> {
  await host.store.threads.commit(
    "victim",
    { state: { compactions: [], history: [], version: 2 } },
    { expectedVersion: null }
  );
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "notification",
    dedupeKey: "delete-notification",
    rootRunId: "run-victim",
    runId: "run-victim",
    status: "queued",
    threadKey: "victim",
  });
  await host.store.events.append("run-victim", { type: "turn-start" });
  await host.store.threadEvents?.append("victim", { type: "turn-start" });
  await host.store.checkpoints.append(
    {
      checkpointId: "delete-checkpoint",
      phase: "before-model",
      runId: "run-victim",
      runtimeState: {},
      threadSnapshot: {},
      version: 1,
    },
    { expectedVersion: 0 }
  );
  await host.store.notifications.enqueue({
    idempotencyKey: "delete-notification",
    input: { text: "delete", type: "user-input" },
    notificationId: "delete-notification",
    runId: "run-victim",
    status: "pending",
    threadKey: "victim",
  });
  await host.store.inputs.admit({
    input: { text: "delete", type: "user-input" },
    kind: "send",
    messageId: "delete-input",
    threadKey: "victim",
  });
}

async function expectThreadDataDeleted(host: AgentHost): Promise<void> {
  await expect(host.store.threads.load("victim")).resolves.toBeNull();
  await expect(host.store.turns.get("run-victim")).resolves.toBeNull();
  await expect(host.store.checkpoints.latest("run-victim")).resolves.toBeNull();
  await expect(
    host.store.notifications.getByIdempotencyKey("delete-notification")
  ).resolves.toBeNull();
  await expect(
    host.store.inputs.claimNext("victim", "turn-idle")
  ).resolves.toBeNull();
  expect(await collect(host.store.events.read("run-victim"))).toEqual([]);
  expect(
    host.store.threadEvents
      ? await collect(host.store.threadEvents.read("victim"))
      : []
  ).toEqual([]);
}

async function collect<T>(items: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const item of items) {
    values.push(item);
  }
  return values;
}
