import { describe, expect, it } from "vitest";
import {
  createDurableObjectStorageHost,
  InMemoryDurableObjectStorage,
  listScheduledDurableObjectThreadPrompts,
} from "../../host/storage-host";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import {
  dispatchCloudflareAgentNotification,
  sourceCloudflareAgentNotificationIdempotencyKey,
} from "./notification-dispatch";

describe("dispatchCloudflareAgentNotification", () => {
  it("creates a notification run with a provided execution host", async () => {
    const host = createDurableObjectStorageHost({
      storage: new InMemoryDurableObjectStorage(),
    });

    const dispatched = await dispatchCloudflareAgentNotification({
      host,
      idempotencyKey: "background:ready",
      input: { text: "Background signal", type: "user-input" },
      namespace: "agent-a",
      threadKey: "room:1:user:2",
    });

    await expect(host.store.turns.get(dispatched.runId)).resolves.toMatchObject(
      {
        kind: "notification",
        runId: dispatched.runId,
        threadKey: "room:1:user:2",
        status: "queued",
      }
    );
    const run = await host.store.turns.get(dispatched.runId);
    await expect(
      host.store.notifications.getByIdempotencyKey(run?.dedupeKey ?? "")
    ).resolves.toMatchObject({
      notificationId: dispatched.notificationId,
      runId: dispatched.runId,
    });
  });

  it("creates a notification run and schedules a Durable Object alarm prompt", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });

    const first = await dispatchCloudflareAgentNotification({
      idempotencyKey: "connector:oauth:done",
      input: { text: "Connector OAuth completed", type: "user-input" },
      namespace: "agent-a",
      prefix: "bori-agent",
      threadKey: "room:1:user:2",
      storage,
    });
    const second = await dispatchCloudflareAgentNotification({
      idempotencyKey: "connector:oauth:done",
      input: { text: "ignored duplicate", type: "user-input" },
      namespace: "agent-a",
      prefix: "bori-agent",
      threadKey: "room:1:user:2",
      storage,
    });

    expect(second).toEqual({ ...first, deduplicated: true });
    const [prompt] = await listScheduledDurableObjectThreadPrompts(storage, {
      prefix: "bori-agent",
    });
    expect(prompt).toMatchObject({
      notificationId: first.notificationId,
      runId: first.runId,
      threadKey: "room:1:user:2",
    });
    expect(prompt?.idempotencyKey).toEqual(expect.any(String));
    expect(prompt?.idempotencyKey).not.toBe("connector:oauth:done");
    expect(
      sourceCloudflareAgentNotificationIdempotencyKey({
        idempotencyKey: prompt?.idempotencyKey,
        namespace: "agent-a",
        threadKey: "room:1:user:2",
      })
    ).toBe("connector:oauth:done");
  });

  it("keeps raw and malformed notification idempotency keys unchanged", () => {
    expect(
      sourceCloudflareAgentNotificationIdempotencyKey({
        idempotencyKey: "reminder:run:1",
        namespace: "agent-a",
        threadKey: "room:1:user:2",
      })
    ).toBe("reminder:run:1");
    expect(
      sourceCloudflareAgentNotificationIdempotencyKey({
        idempotencyKey: "agent%3Aagent-a:%E0%A4%A:connector%3Abad",
        namespace: "agent-a",
        threadKey: "room:1:user:2",
      })
    ).toBe("agent%3Aagent-a:%E0%A4%A:connector%3Abad");
  });

  it("keeps scoped notification keys for a different thread unchanged", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });

    await dispatchCloudflareAgentNotification({
      idempotencyKey: "connector:oauth:done",
      input: { text: "Connector OAuth completed", type: "user-input" },
      namespace: "agent-a",
      prefix: "bori-agent",
      threadKey: "room:1:user:2",
      storage,
    });

    const [prompt] = await listScheduledDurableObjectThreadPrompts(storage, {
      prefix: "bori-agent",
    });

    expect(
      sourceCloudflareAgentNotificationIdempotencyKey({
        idempotencyKey: prompt?.idempotencyKey,
        namespace: "agent-a",
        threadKey: "room:2:user:2",
      })
    ).toBe(prompt?.idempotencyKey);
  });
});
