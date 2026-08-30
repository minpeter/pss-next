import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { solidTestPng } from "../../testing/valid-image-fixture";
import {
  type HostAttachmentStore,
  isRuntimeAttachmentData,
  type RuntimeAttachmentReference,
} from "../../thread/input/attachments";
import { transitionTurn } from "../host/turn-status";
import type { AgentHost, TurnRecord, TurnStore } from "../host/types";
import { dispatchAgentNotification } from "./notification-dispatch";

describe("dispatchAgentNotification attachments and races", () => {
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
    transition: (runId, expected, update) =>
      transitionTurn(host.store.turns, { expected, runId, update }),
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
    transition: (runId, expected, update) =>
      transitionTurn(host.store.turns, { expected, runId, update }),
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
