import { describe, expect, it } from "vitest";
import { agentNamespace } from "../../agent/identity/namespace";
import { createInMemoryHost } from "../../platform/memory";
import { solidTestPng } from "../../testing/valid-image-fixture";
import {
  type HostAttachmentStore,
  isRuntimeAttachmentData,
  type RuntimeAttachmentReference,
} from "../../thread/input/attachments";
import type {
  AgentHost,
  NotificationInbox,
  NotificationRecord,
  TurnRecord,
  TurnStore,
} from "../host/types";
import { dispatchAgentNotification } from "./notification-dispatch";

const MISSING_NOTIFICATION_RECORD_PATTERN = /has no notification record/;
const CORRUPT_NOTIFICATION_RECORD_PATTERN =
  /does not match the deduplicated run/;

describe("dispatchAgentNotification", () => {
  it("creates and schedules an idempotent notification run", async () => {
    const host = createInMemoryHost();

    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:1",
      input: { text: "Reminder fired again", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(first).toMatchObject({
      deduplicated: false,
      idempotencyKey: "reminder:1",
    });
    expect(second).toEqual({ ...first, deduplicated: true });
    const run = await host.store.turns.get(first.runId);
    expect(run).toMatchObject({
      kind: "notification",
      ownerNamespace: agentNamespace("agent-a"),
      threadKey: "room:1:user:2",
      status: "queued",
    });
    expect(run?.dedupeKey).toEqual(expect.any(String));
    expect(run?.dedupeKey).not.toBe("reminder:1");
    await expect(
      host.store.notifications.getByIdempotencyKey(run?.dedupeKey ?? "")
    ).resolves.toMatchObject({
      idempotencyKey: run?.dedupeKey,
      input: { text: "Reminder fired", type: "user-input" },
      ownerNamespace: agentNamespace("agent-a"),
      runId: first.runId,
      threadKey: "room:1:user:2",
      status: "pending",
    });
  });

  it("dedupes notifications within the same owner instead of globally", async () => {
    const host = createInMemoryHost();

    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "Agent A reminder", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:1",
    });
    const second = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "Agent B reminder", type: "user-input" },
      namespace: "agent-b",
      threadKey: "room:1:user:2",
    });
    const duplicateFirst = await dispatchAgentNotification({
      host,
      idempotencyKey: "reminder:shared",
      input: { text: "ignored duplicate", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:1",
    });

    expect(second.deduplicated).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(duplicateFirst).toEqual({ ...first, deduplicated: true });
    await expect(host.store.turns.get(first.runId)).resolves.toMatchObject({
      ownerNamespace: agentNamespace("agent-a"),
      threadKey: "room:1:user:1",
    });
    await expect(host.store.turns.get(second.runId)).resolves.toMatchObject({
      ownerNamespace: agentNamespace("agent-b"),
      threadKey: "room:1:user:2",
    });
  });

  it("reschedules an active run on an idempotent retry", async () => {
    const baseHost = createInMemoryHost();
    let resumeCalls = 0;
    const host = {
      ...baseHost,
      scheduler: {
        enqueueRun: (runId, options) =>
          baseHost.scheduler.enqueueRun(runId, options),
        resumeThread: async (threadKey, options) => {
          resumeCalls += 1;
          await baseHost.scheduler.resumeThread(threadKey, options);
        },
      },
    } satisfies AgentHost;
    const input = {
      host,
      idempotencyKey: "reminder:retry",
      input: { text: "Reminder fired", type: "user-input" } as const,
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    };

    const first = await dispatchAgentNotification(input);
    const retry = await dispatchAgentNotification(input);

    expect(retry).toEqual({ ...first, deduplicated: true });
    expect(resumeCalls).toBe(2);
  });

  it.each(["cancelled", "completed", "error"] as const)(
    "returns a deduplicated result without rescheduling a %s run",
    async (status) => {
      const baseHost = createInMemoryHost();
      let resumeCalls = 0;
      const host = {
        ...baseHost,
        scheduler: {
          enqueueRun: (runId, options) =>
            baseHost.scheduler.enqueueRun(runId, options),
          resumeThread: async (threadKey, options) => {
            resumeCalls += 1;
            await baseHost.scheduler.resumeThread(threadKey, options);
          },
        },
      } satisfies AgentHost;
      const input = {
        host,
        idempotencyKey: `reminder:terminal:${status}`,
        input: { text: "Reminder fired", type: "user-input" } as const,
        namespace: "agent-a",
        threadKey: "room:1:user:2",
      };
      const first = await dispatchAgentNotification(input);
      const run = await host.store.turns.get(first.runId);
      if (!run) {
        throw new Error("expected notification run");
      }
      await host.store.turns.update({ ...run, status });

      const retry = await dispatchAgentNotification(input);

      expect(retry).toEqual({ ...first, deduplicated: true });
      expect(resumeCalls).toBe(1);
    }
  );

  it("rejects a deduplicated run with a missing notification record", async () => {
    const baseHost = createInMemoryHost();
    const input = {
      host: baseHost,
      idempotencyKey: "reminder:missing-record",
      input: { text: "Reminder fired", type: "user-input" } as const,
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    };
    await dispatchAgentNotification(input);
    const host = hostWithNotificationLookup(baseHost, () => null);

    await expect(dispatchAgentNotification({ ...input, host })).rejects.toThrow(
      MISSING_NOTIFICATION_RECORD_PATTERN
    );
  });

  it.each([
    [
      "run id",
      (record: NotificationRecord) => ({ ...record, runId: "wrong-run" }),
    ],
    [
      "idempotency key",
      (record: NotificationRecord) => ({
        ...record,
        idempotencyKey: "wrong-key",
      }),
    ],
    [
      "owner namespace",
      (record: NotificationRecord) => ({
        ...record,
        ownerNamespace: agentNamespace("agent-b"),
      }),
    ],
    [
      "thread key",
      (record: NotificationRecord) => ({
        ...record,
        threadKey: "wrong-thread",
      }),
    ],
    [
      "notification id",
      (record: NotificationRecord) => ({ ...record, notificationId: "" }),
    ],
  ] as const)(
    "rejects a notification record with a corrupt %s",
    async (_field, corrupt) => {
      const baseHost = createInMemoryHost();
      const input = {
        host: baseHost,
        idempotencyKey: `reminder:corrupt:${_field}`,
        input: { text: "Reminder fired", type: "user-input" } as const,
        namespace: "agent-a",
        threadKey: "room:1:user:2",
      };
      const first = await dispatchAgentNotification(input);
      const run = await baseHost.store.turns.get(first.runId);
      const record = await baseHost.store.notifications.getByIdempotencyKey(
        run?.dedupeKey ?? ""
      );
      if (!record) {
        throw new Error("expected notification record");
      }
      const host = hostWithNotificationLookup(baseHost, () => corrupt(record));

      await expect(
        dispatchAgentNotification({ ...input, host })
      ).rejects.toThrow(CORRUPT_NOTIFICATION_RECORD_PATTERN);
    }
  );

  it("stages notification file bytes before durable enqueue", async () => {
    const host = createInMemoryHost();
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "attachment:1",
      input: {
        content: [
          { text: "look", type: "text" },
          {
            data: solidTestPng(),
            filename: "photo.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        type: "user-input",
      },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    const run = await host.store.turns.get(dispatched.runId);
    const notification = await host.store.notifications.getByIdempotencyKey(
      run?.dedupeKey ?? ""
    );

    expect(JSON.stringify(notification)).toContain("pss-attachment:");
    expect(JSON.stringify(notification)).not.toContain('"0":1');
    if (!(notification && "content" in notification.input)) {
      throw new Error("expected multipart notification input");
    }
    const filePart = notification.input.content[1];
    expect(filePart?.type).toBe("file");
    if (filePart?.type !== "file") {
      throw new Error("expected staged file part");
    }
    expect(isRuntimeAttachmentData(filePart.data)).toBe(true);
  });

  it("stages notification observer event file bytes before durable enqueue", async () => {
    const host = createInMemoryHost();
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "attachment-observer:1",
      input: { text: "wake", type: "user-input" },
      namespace: "agent-a",
      observerEvents: [
        {
          content: [
            {
              data: solidTestPng(),
              filename: "context.png",
              mediaType: "image/png",
              type: "file",
            },
          ],
          type: "user-input",
        },
      ],
      threadKey: "room:1:user:2",
    });

    const run = await host.store.turns.get(dispatched.runId);
    const notification = await host.store.notifications.getByIdempotencyKey(
      run?.dedupeKey ?? ""
    );

    expect(JSON.stringify(notification)).toContain("pss-attachment:");
    expect(JSON.stringify(notification)).not.toContain('"0":7');
    const observerEvent = notification?.observerEvents?.[0];
    if (observerEvent?.type !== "user-input" || !("content" in observerEvent)) {
      throw new Error("expected staged multipart observer event");
    }
    const filePart = observerEvent.content[0];
    expect(filePart?.type).toBe("file");
    if (filePart?.type !== "file") {
      throw new Error("expected staged observer file part");
    }
    expect(isRuntimeAttachmentData(filePart.data)).toBe(true);
  });

  it("returns the existing notification when run dedupe wins a create race", async () => {
    const baseHost = createInMemoryHost();
    const first = await dispatchAgentNotification({
      host: baseHost,
      idempotencyKey: "reminder:race",
      input: { text: "first", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const racingHost = hostWithDuplicateRunCreate(baseHost);

    const duplicate = await dispatchAgentNotification({
      host: racingHost,
      idempotencyKey: "reminder:race",
      input: { text: "duplicate", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(duplicate).toEqual({ ...first, deduplicated: true });
  });

  it("deletes staged notification attachments when a create race dedupes", async () => {
    const baseHost = createInMemoryHost();
    const deletedRefs: RuntimeAttachmentReference[] = [];
    const attachmentStore = trackingAttachmentStore(
      baseHost.attachmentStore,
      deletedRefs
    );
    const host = { ...baseHost, attachmentStore } satisfies AgentHost;
    const first = await dispatchAgentNotification({
      host,
      idempotencyKey: "attachment-race",
      input: { text: "first", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });
    const racingHost = hostWithDuplicateRunCreateAfterFirstLookup(host);

    const duplicate = await dispatchAgentNotification({
      host: racingHost,
      idempotencyKey: "attachment-race",
      input: {
        content: [
          {
            data: solidTestPng(),
            filename: "duplicate.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        type: "user-input",
      },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    expect(duplicate).toEqual({ ...first, deduplicated: true });
    expect(deletedRefs).toHaveLength(1);
    const deletedRef = deletedRefs[0];
    if (!deletedRef) {
      throw new Error("expected deleted staged attachment ref");
    }
    await expect(attachmentStore.get(deletedRef)).resolves.toBeNull();
  });
});

function hostWithNotificationLookup(
  host: AgentHost,
  lookup: (idempotencyKey: string) => NotificationRecord | null
): AgentHost {
  const notifications = {
    claimByIdempotencyKey: (idempotencyKey) =>
      host.store.notifications.claimByIdempotencyKey(idempotencyKey),
    enqueue: (record) => host.store.notifications.enqueue(record),
    getByIdempotencyKey: async (idempotencyKey) => lookup(idempotencyKey),
    releaseByIdempotencyKey: (idempotencyKey) =>
      host.store.notifications.releaseByIdempotencyKey(idempotencyKey),
  } satisfies NotificationInbox;

  return {
    ...host,
    store: {
      ...host.store,
      notifications,
      transaction: (callback) =>
        callback({
          checkpoints: host.store.checkpoints,
          events: host.store.events,
          inputs: host.store.inputs,
          notifications,
          threads: host.store.threads,
          turns: host.store.turns,
        }),
    },
  };
}

function trackingAttachmentStore(
  store: HostAttachmentStore | undefined,
  deletedRefs: RuntimeAttachmentReference[]
): HostAttachmentStore {
  if (!store) {
    throw new Error("expected base host attachment store");
  }

  return {
    delete: async (ref) => {
      deletedRefs.push(ref);
      await store.delete(ref);
    },
    get: (ref) => store.get(ref),
    put: (input) => store.put(input),
  };
}

function hostWithDuplicateRunCreateAfterFirstLookup(
  host: AgentHost
): AgentHost {
  let dedupeLookups = 0;
  const runs = {
    claim: (runId, options) => host.store.turns.claim(runId, options),
    create: async (record: TurnRecord) => {
      const existing = record.dedupeKey
        ? await host.store.turns.getByDedupeKey(record.dedupeKey)
        : await host.store.turns.get(record.runId);
      if (!existing) {
        throw new Error("Expected pre-existing run for duplicate create race.");
      }
      return { ok: false, reason: "duplicate", record: existing } as const;
    },
    get: (runId) => host.store.turns.get(runId),
    getByDedupeKey: async (dedupeKey) => {
      dedupeLookups += 1;
      return dedupeLookups === 1
        ? null
        : await host.store.turns.getByDedupeKey(dedupeKey);
    },
    listByParentRunId: (parentRunId) =>
      host.store.turns.listByParentRunId(parentRunId),
    update: (record) => host.store.turns.update(record),
  } satisfies TurnStore;

  return hostWithRuns(host, runs);
}

function hostWithDuplicateRunCreate(host: AgentHost): AgentHost {
  const runs = {
    claim: (runId, options) => host.store.turns.claim(runId, options),
    create: async (record: TurnRecord) => {
      const existing = record.dedupeKey
        ? await host.store.turns.getByDedupeKey(record.dedupeKey)
        : await host.store.turns.get(record.runId);
      if (!existing) {
        throw new Error("Expected pre-existing run for duplicate create race.");
      }
      return { ok: false, reason: "duplicate", record: existing } as const;
    },
    get: (runId) => host.store.turns.get(runId),
    getByDedupeKey: (dedupeKey) => host.store.turns.getByDedupeKey(dedupeKey),
    listByParentRunId: (parentRunId) =>
      host.store.turns.listByParentRunId(parentRunId),
    update: (record) => host.store.turns.update(record),
  } satisfies TurnStore;

  return hostWithRuns(host, runs);
}

function hostWithRuns(host: AgentHost, runs: TurnStore): AgentHost {
  return {
    ...host,
    store: {
      ...host.store,
      turns: runs,
      transaction: (callback) =>
        callback({
          events: host.store.events,
          inputs: host.store.inputs,
          notifications: host.store.notifications,
          checkpoints: host.store.checkpoints,
          threads: host.store.threads,
          turns: runs,
        }),
    },
  };
}
