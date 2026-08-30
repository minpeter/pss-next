import { describe, expect, it } from "vitest";
import type { TurnStatus } from "../../../../execution";
import type { DurableObjectTransactionStorage } from "../../storage/durable-object/durable-object-storage";
import {
  createRetryHost,
  expectActiveLeasedNotification,
  expectRetryScheduled,
  seedRetryableNotification,
} from "./fiber-retry-test-support";
import {
  type CloudflareAgentsRetryReason,
  cloudflareAgentsRunPayload,
  createCloudflareAgentsFiberRetryScheduler,
} from "./index";
import { captureCloudflareAgentsRetryLeaseId } from "./retry-ownership";
import { createFakeCloudflareAgent } from "./test-support";

const retryReasons = [
  "error",
  "deadline",
  "event-budget",
  "not-claimable",
] as const satisfies readonly CloudflareAgentsRetryReason[];

const ownedRetryReasons = [
  "error",
  "deadline",
  "event-budget",
] as const satisfies readonly CloudflareAgentsRetryReason[];

const refusalStates = [
  { expectedLeaseId: "lease:replacement", status: "leased" },
  { expectedLeaseId: undefined, status: "cancelled" },
  { expectedLeaseId: undefined, status: "completed" },
  { expectedLeaseId: undefined, status: "error" },
  { expectedLeaseId: undefined, status: "needs-recovery" },
] as const satisfies readonly {
  readonly expectedLeaseId: string | undefined;
  readonly status: TurnStatus;
}[];

describe("Cloudflare Agents scheduled notification retry races", () => {
  it.each(retryReasons)(
    "retries an eligible running unleased notification after %s",
    async (reason) => {
      // Given: the retrying attempt still owns eligible unleased work.
      const cloudflareAgent = createFakeCloudflareAgent();
      const host = createRetryHost(cloudflareAgent, () =>
        Promise.resolve(null)
      );
      const runId = `background:bg_eligible_${reason}`;
      await seedRetryableNotification(host, runId);
      const run = await host.store.turns.get(runId);
      if (!run) {
        throw new TypeError("Test run disappeared before retry.");
      }
      const { lease: _lease, ...runWithoutLease } = run;
      await host.store.turns.update({ ...runWithoutLease, status: "running" });
      const retry = createCloudflareAgentsFiberRetryScheduler({
        cloudflareAgent,
        storage: cloudflareAgent.durableObjectContext.storage,
      });

      const payload = cloudflareAgentsRunPayload({
        prefix: "tenant-a",
        runId,
      });
      captureCloudflareAgentsRetryLeaseId(payload, null);

      // When: any supported interruption reason requests retry.
      const retried = await retry(payload, reason);

      // Then: exact work is queued and the notification is released for replay.
      expect(retried).toBe(true);
      await expectRetryScheduled({ cloudflareAgent, host, runId });
    }
  );

  it.each(ownedRetryReasons)(
    "does not adopt a pre-existing replacement lease for %s",
    async (reason) => {
      // Given: replacement owner B acquired the run before this stale retry's
      // first ownership lookup, so the retry has no captured capability.
      const cloudflareAgent = createFakeCloudflareAgent();
      const host = createRetryHost(cloudflareAgent, () =>
        Promise.resolve(null)
      );
      const runId = `background:bg_preowned_${reason}`;
      const leaseUntilMs = Number.MAX_SAFE_INTEGER;
      await seedRetryableNotification(host, runId, { leaseUntilMs });
      const retry = createCloudflareAgentsFiberRetryScheduler({
        cloudflareAgent,
        storage: cloudflareAgent.durableObjectContext.storage,
      });

      // When: stale work retries without ownership captured from a resumed turn.
      const retried = await retry(
        cloudflareAgentsRunPayload({ prefix: "tenant-a", runId }),
        reason
      );

      // Then: unknown ownership cannot borrow owner B's lease.
      expect(retried).toBe(false);
      expect(cloudflareAgent.scheduled).toEqual([]);
      await expectActiveLeasedNotification(host, runId, leaseUntilMs);
    }
  );

  it.each(
    retryReasons.flatMap((reason) =>
      refusalStates.map((state) => ({ reason, ...state }))
    )
  )(
    "refuses $reason retry when $status wins at transaction entry",
    async ({ expectedLeaseId, reason, status }) => {
      // Given: an eligible attempt whose ownership or status changes exactly
      // when retry preparation enters its storage transaction.
      const cloudflareAgent = createFakeCloudflareAgent();
      const host = createRetryHost(cloudflareAgent, () =>
        Promise.resolve(null)
      );
      const storage = cloudflareAgent.durableObjectContext.storage;
      const transaction = storage.transaction?.bind(storage);
      if (!transaction) {
        throw new TypeError("Test storage requires transaction support.");
      }
      const runId = `background:bg_raced_${reason}_${status}`;
      await seedRetryableNotification(host, runId);
      const initialRun = await host.store.turns.get(runId);
      if (!initialRun) {
        throw new TypeError("Test run disappeared before ownership capture.");
      }
      const { lease: _initialLease, ...initialRunWithoutLease } = initialRun;
      await host.store.turns.update({
        ...initialRunWithoutLease,
        status: "running",
      });
      const racedStorage = new Proxy(storage, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== "transaction") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async <T>(
            fn: (tx: DurableObjectTransactionStorage) => Promise<T>
          ): Promise<T> => {
            const run = await host.store.turns.get(runId);
            if (!run) {
              throw new TypeError("Test run disappeared before the race.");
            }
            const { lease: _lease, ...runWithoutLease } = run;
            await host.store.turns.update(
              status === "leased"
                ? {
                    ...run,
                    lease: {
                      attempt: 2,
                      leaseId: "lease:replacement",
                      leaseUntilMs: Number.MAX_SAFE_INTEGER,
                    },
                    status: "leased",
                  }
                : { ...runWithoutLease, status }
            );
            return await transaction(fn);
          };
        },
      });
      const retry = createCloudflareAgentsFiberRetryScheduler({
        cloudflareAgent,
        storage: racedStorage,
      });

      const payload = cloudflareAgentsRunPayload({
        prefix: "tenant-a",
        runId,
      });
      captureCloudflareAgentsRetryLeaseId(
        payload,
        status === "leased" ? "lease:original" : null
      );

      // When: the stale attempt requests a retry for any retry reason.
      const retried = await retry(payload, reason);

      // Then: refusal is side-effect free for schedule, run, and notification.
      const racedRun = await host.store.turns.get(runId);
      const notification = await host.store.notifications.getByIdempotencyKey(
        `dedupe:${runId}`
      );
      expect({
        leaseId: racedRun?.lease?.leaseId,
        notificationStatus: notification?.status,
        retried,
        runStatus: racedRun?.status,
        scheduled: cloudflareAgent.scheduled,
      }).toEqual({
        leaseId: expectedLeaseId,
        notificationStatus: "acked",
        retried: false,
        runStatus: status,
        scheduled: [],
      });
    }
  );
});
