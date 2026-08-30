import { describe, expect, it } from "vitest";
import { agentNamespace } from "../../agent/identity/namespace";
import { createInMemoryHost } from "../../platform/memory";
import type {
  AgentHost,
  NotificationInbox,
  NotificationRecord,
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
    const { host, resumeCallCount } = hostWithResumeCounter(
      createInMemoryHost()
    );
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
    expect(resumeCallCount()).toBe(2);
  });

  it.each(["cancelled", "completed", "error", "needs-recovery"] as const)(
    "returns a deduplicated result without rescheduling a %s run",
    async (status) => {
      const { host, resumeCallCount } = hostWithResumeCounter(
        createInMemoryHost()
      );
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
      expect(resumeCallCount()).toBe(1);
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
});

function hostWithResumeCounter(baseHost: AgentHost): {
  readonly host: AgentHost;
  readonly resumeCallCount: () => number;
} {
  let resumeCalls = 0;
  return {
    host: {
      ...baseHost,
      scheduler: {
        enqueueRun: (runId, options) =>
          baseHost.scheduler.enqueueRun(runId, options),
        resumeThread: async (threadKey, options) => {
          resumeCalls += 1;
          await baseHost.scheduler.resumeThread(threadKey, options);
        },
      },
    },
    resumeCallCount: () => resumeCalls,
  };
}

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
