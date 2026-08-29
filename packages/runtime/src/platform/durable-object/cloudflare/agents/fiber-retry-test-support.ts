import { expect } from "vitest";
import type { AgentHost, TurnStatus } from "../../../../execution";
import {
  type CloudflareAgentsResumeRun,
  createCloudflareHost,
  listScheduledCloudflareAgentsRuns,
} from "./index";
import type { FakeCloudflareAgent } from "./test-support";

export function createRetryHost(
  cloudflareAgent: FakeCloudflareAgent,
  resume: CloudflareAgentsResumeRun,
  drain?: { readonly maxEvents?: number }
): AgentHost {
  return createCloudflareHost({
    cloudflareAgent,
    drain,
    durableObjectContext: cloudflareAgent.durableObjectContext,
    prefix: "tenant-a",
    resume,
  });
}

export interface SeedRetryableNotificationOptions {
  readonly leaseUntilMs?: number;
  readonly status?: TurnStatus;
}

export async function seedRetryableNotification(
  host: AgentHost,
  runId: string,
  options: SeedRetryableNotificationOptions = {}
): Promise<void> {
  const dedupeKey = dedupeKeyFor(runId);
  const { leaseUntilMs = Date.now() + 60_000, status = "leased" } = options;
  await host.store.turns.create({
    checkpointVersion: 0,
    dedupeKey,
    kind: "notification",
    lease: {
      attempt: 1,
      leaseId: `lease:${runId}`,
      leaseUntilMs,
    },
    rootRunId: runId,
    runId,
    status,
    threadKey: "thread-a",
  });
  await host.store.notifications.enqueue({
    idempotencyKey: dedupeKey,
    input: { text: "retry", type: "user-input" },
    notificationId: `notification:${runId}`,
    runId,
    status: "acked",
    threadKey: "thread-a",
  });
}

export async function expectActiveLeasedNotification(
  host: AgentHost,
  runId: string,
  leaseUntilMs: number
): Promise<void> {
  const run = await host.store.turns.get(runId);
  const notification = await host.store.notifications.getByIdempotencyKey(
    dedupeKeyFor(runId)
  );
  expect(run).toMatchObject({
    lease: {
      attempt: 1,
      leaseId: `lease:${runId}`,
      leaseUntilMs,
    },
    runId,
    status: "leased",
  });
  expect(notification).toMatchObject({ runId, status: "acked" });
}

export async function expectRetryScheduled({
  cloudflareAgent,
  host,
  runId,
}: {
  readonly cloudflareAgent: FakeCloudflareAgent;
  readonly host: AgentHost;
  readonly runId: string;
}): Promise<void> {
  expect(cloudflareAgent.scheduled).toEqual([
    {
      callback: "resumePssRuntimeFiber",
      idempotent: true,
      payload: {
        attempt: 1,
        kind: "run",
        prefix: "tenant-a",
        runId,
        scheduleDelaySeconds: 1,
        version: 1,
      },
      when: 1,
    },
  ]);
  const run = await host.store.turns.get(runId);
  const notification = await host.store.notifications.getByIdempotencyKey(
    dedupeKeyFor(runId)
  );
  await expect(
    listScheduledCloudflareAgentsRuns(
      cloudflareAgent.durableObjectContext.storage,
      { prefix: "tenant-a" }
    )
  ).resolves.toEqual([runId]);
  expect(storageAlarmTime(cloudflareAgent.durableObjectContext.storage)).toBe(
    undefined
  );
  expect(run).toMatchObject({ runId, status: "queued" });
  expect(run?.lease).toBeUndefined();
  expect(notification).toMatchObject({ runId, status: "pending" });
}

export async function expectCompletedNotification(
  host: AgentHost,
  runId: string
): Promise<void> {
  const run = await host.store.turns.get(runId);
  const notification = await host.store.notifications.getByIdempotencyKey(
    dedupeKeyFor(runId)
  );
  expect(run).toMatchObject({ runId, status: "completed" });
  expect(notification).toMatchObject({ runId, status: "acked" });
}

function dedupeKeyFor(runId: string): string {
  return `dedupe:${runId}`;
}

function storageAlarmTime(storage: unknown): number | undefined {
  if (typeof storage !== "object" || storage === null) {
    return;
  }
  if (!("alarmTime" in storage) || typeof storage.alarmTime !== "function") {
    return;
  }
  return storage.alarmTime();
}
