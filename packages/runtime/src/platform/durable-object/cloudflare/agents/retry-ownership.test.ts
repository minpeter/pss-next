import { describe, expect, it } from "vitest";
import {
  createRetryHost,
  expectRetryScheduled,
  prepareRetryAuthority,
  seedRetryableNotification,
} from "./fiber-retry-test-support";
import {
  type CloudflareAgentsRetryReason,
  cloudflareAgentsRunPayload,
  createCloudflareAgentsFiberRetryScheduler,
  listScheduledCloudflareAgentsRuns,
} from "./index";
import { createFakeCloudflareAgent } from "./test-support";

const retryReasons: readonly CloudflareAgentsRetryReason[] = [
  "deadline",
  "error",
  "event-budget",
  "not-claimable",
];

const activeLeaseRetryReasons: readonly CloudflareAgentsRetryReason[] = [
  "deadline",
  "error",
  "event-budget",
];

describe("Cloudflare Agents retry ownership", () => {
  it.each(retryReasons)(
    "leaves fresh uncaptured retry state unchanged after %s",
    async (reason) => {
      const cloudflareAgent = createFakeCloudflareAgent();
      const host = createRetryHost(cloudflareAgent, () =>
        Promise.resolve(null)
      );
      const runId = `background:bg_unknown_${reason}`;
      await seedRetryableNotification(host, runId, {
        leaseUntilMs: null,
        status: "running",
      });
      const runBefore = await host.store.turns.get(runId);
      const notificationBefore =
        await host.store.notifications.getByIdempotencyKey(`dedupe:${runId}`);
      const retry = createCloudflareAgentsFiberRetryScheduler({
        cloudflareAgent,
        storage: cloudflareAgent.durableObjectContext.storage,
      });
      const payload = cloudflareAgentsRunPayload({ prefix: "tenant-a", runId });

      await expect(retry(payload, reason)).resolves.toBe(false);

      expect(cloudflareAgent.scheduled).toEqual([]);
      await expect(host.store.turns.get(runId)).resolves.toEqual(runBefore);
      await expect(
        host.store.notifications.getByIdempotencyKey(`dedupe:${runId}`)
      ).resolves.toEqual(notificationBefore);
      await expect(
        listScheduledCloudflareAgentsRuns(
          cloudflareAgent.durableObjectContext.storage,
          { prefix: "tenant-a" }
        )
      ).resolves.toEqual([]);
    }
  );

  it.each(activeLeaseRetryReasons)(
    "retains genuine opaque ownership after %s",
    async (reason) => {
      const cloudflareAgent = createFakeCloudflareAgent();
      const host = createRetryHost(cloudflareAgent, () =>
        Promise.resolve(null)
      );
      const runId = `background:bg_string_owner_${reason}`;
      await seedRetryableNotification(host, runId);
      const retry = createCloudflareAgentsFiberRetryScheduler({
        cloudflareAgent,
        storage: cloudflareAgent.durableObjectContext.storage,
      });
      const payload = cloudflareAgentsRunPayload({ prefix: "tenant-a", runId });
      const authority = await prepareRetryAuthority(host, payload);

      await expect(retry(payload, reason, authority)).resolves.toBe(true);
      await expectRetryScheduled({ cloudflareAgent, host, runId });
    }
  );
});
