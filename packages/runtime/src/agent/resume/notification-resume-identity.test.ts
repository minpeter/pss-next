import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  NotificationInbox,
  NotificationRecord,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import { BufferedAgentTurn } from "../../thread/protocol/turn";
import { agentNamespace } from "../identity/namespace";
import { notificationRunRecord } from "./notification-resume.test-support";
import { resumeAgentTurn } from "./resume";

const OWNER_NAMESPACE = agentNamespace("notify-owner");

const corruptions = [
  [
    "run id",
    (record: NotificationRecord) => ({ ...record, runId: "other-run" }),
  ],
  [
    "thread key",
    (record: NotificationRecord) => ({ ...record, threadKey: "other-thread" }),
  ],
  [
    "idempotency key",
    (record: NotificationRecord) => ({
      ...record,
      idempotencyKey: "other-idempotency-key",
    }),
  ],
  [
    "notification id",
    (record: NotificationRecord) => ({ ...record, notificationId: "" }),
  ],
  [
    "owner namespace",
    (record: NotificationRecord) => ({
      ...record,
      ownerNamespace: agentNamespace("other-owner"),
    }),
  ],
] as const;

describe("notification resume identity", () => {
  it.each(corruptions)(
    "rejects a claimed notification with a mismatched %s and restores the run",
    async (_field, corrupt) => {
      // Given: a queued run whose notification is corrupted only when claimed.
      const baseHost = createInMemoryHost();
      const runId = `identity-mismatch:${_field}`;
      const idempotencyKey = `notification:${_field}`;
      const notification = notificationRecord({ idempotencyKey, runId });
      await baseHost.store.turns.create(
        notificationRunRecord({ idempotencyKey, runId })
      );
      await baseHost.store.notifications.enqueue(notification);
      const host = hostWithCorruptClaim(baseHost, corrupt);
      let resumed = false;

      // When: notification resume claims the mismatched tuple.
      const result = await resumeAgentTurn({
        host,
        ownerNamespace: OWNER_NAMESPACE,
        resumeNotification: () => {
          resumed = true;
          return Promise.resolve(closedTurn());
        },
        runId,
      });

      // Then: resume fails closed and both durable records are recoverable.
      expect(result).toBeNull();
      expect(resumed).toBe(false);
      await expect(baseHost.store.turns.get(runId)).resolves.toEqual(
        expect.objectContaining({ status: "queued" })
      );
      expect((await baseHost.store.turns.get(runId))?.lease).toBeUndefined();
      await expect(
        baseHost.store.notifications.getByIdempotencyKey(idempotencyKey)
      ).resolves.toEqual(notification);
    }
  );

  it("resumes when the complete claimed notification tuple matches the run", async () => {
    // Given: a queued run and notification with one matching identity tuple.
    const host = createInMemoryHost();
    const runId = "identity-match";
    const idempotencyKey = "notification:identity-match";
    const notification = notificationRecord({ idempotencyKey, runId });
    await host.store.turns.create(
      notificationRunRecord({ idempotencyKey, runId })
    );
    await host.store.notifications.enqueue(notification);
    const turn = closedTurn();

    // When: notification resume claims the matching tuple.
    const result = await resumeAgentTurn({
      host,
      ownerNamespace: OWNER_NAMESPACE,
      resumeNotification: (claimedNotification, claimedRun) => {
        expect(claimedNotification).toEqual(notification);
        expect(claimedRun).toEqual(
          expect.objectContaining({ runId, status: "leased" })
        );
        return Promise.resolve(turn);
      },
      runId,
    });

    // Then: normal notification resume remains accepted.
    expect(result).toBe(turn);
    await expect(
      host.store.notifications.getByIdempotencyKey(idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "acked" }));
  });
});

function notificationRecord({
  idempotencyKey,
  runId,
}: {
  readonly idempotencyKey: string;
  readonly runId: string;
}): NotificationRecord {
  return {
    idempotencyKey,
    input: userText("notification ready"),
    notificationId: `id:${runId}`,
    ownerNamespace: OWNER_NAMESPACE,
    runId,
    status: "pending",
    threadKey: "default",
  };
}

function closedTurn(): BufferedAgentTurn {
  const turn = new BufferedAgentTurn();
  turn.close();
  return turn;
}

function hostWithCorruptClaim(
  host: AgentHost,
  corrupt: (record: NotificationRecord) => NotificationRecord
): AgentHost {
  return {
    ...host,
    store: {
      ...host.store,
      transaction: (callback) =>
        host.store.transaction((transaction) => {
          const notifications = {
            claimByIdempotencyKey: async (idempotencyKey) => {
              const claim =
                await transaction.notifications.claimByIdempotencyKey(
                  idempotencyKey
                );
              return claim.ok
                ? { ...claim, record: corrupt(claim.record) }
                : claim;
            },
            enqueue: (record) => transaction.notifications.enqueue(record),
            getByIdempotencyKey: (idempotencyKey) =>
              transaction.notifications.getByIdempotencyKey(idempotencyKey),
            releaseByIdempotencyKey: (idempotencyKey) =>
              transaction.notifications.releaseByIdempotencyKey(idempotencyKey),
          } satisfies NotificationInbox;
          return callback({
            checkpoints: transaction.checkpoints,
            events: transaction.events,
            inputs: transaction.inputs,
            notifications,
            threads: transaction.threads,
            turns: transaction.turns,
          });
        }),
    },
  };
}
