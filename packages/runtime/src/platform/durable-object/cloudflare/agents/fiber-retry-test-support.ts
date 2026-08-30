import { expect } from "vitest";
import {
  createResumeRetryAttempt,
  leaseIdForResumeClaim,
} from "../../../../agent/resume/retry-authority";
import type { AgentHost, TurnStatus } from "../../../../execution";
import {
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsResumeOptions,
  type CloudflareAgentsResumeRun,
  createCloudflareHost,
  listScheduledCloudflareAgentsRuns,
} from "./index";
import { cloudflareAgentsFiberRetryScope } from "./payload";
import type { FakeCloudflareAgent } from "./test-support";

export function createRetryHost(
  cloudflareAgent: FakeCloudflareAgent,
  resume: CloudflareAgentsResumeRun,
  drain?: { readonly maxEvents?: number },
  options: { readonly claimBeforeResume?: boolean } = {}
): AgentHost {
  let host: AgentHost;
  host = createCloudflareHost({
    cloudflareAgent,
    drain,
    durableObjectContext: cloudflareAgent.durableObjectContext,
    prefix: "tenant-a",
    resume: async (payload, resumeOptions) => {
      if (options.claimBeforeResume !== false) {
        await claimRetryAttempt(host, payload, resumeOptions);
      }
      return await resume(payload, resumeOptions);
    },
  });
  return host;
}

export async function prepareRetryAuthority(
  host: AgentHost,
  payload: CloudflareAgentsFiberPayload
): Promise<object> {
  const attempt = createResumeRetryAttempt({
    runId: payload.runId,
    scope: cloudflareAgentsFiberRetryScope(payload),
  });
  await claimRetryAttempt(host, payload, { claim: attempt.claim });
  return attempt.authority;
}

export interface SeedRetryableNotificationOptions {
  readonly leaseUntilMs?: number | null;
  readonly status?: TurnStatus;
}

export async function seedRetryableRun(
  host: AgentHost,
  runId: string
): Promise<void> {
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status: "running",
    threadKey: "thread-a",
  });
}

export async function seedRetryableNotification(
  host: AgentHost,
  runId: string,
  options: SeedRetryableNotificationOptions = {}
): Promise<void> {
  const dedupeKey = dedupeKeyFor(runId);
  const { leaseUntilMs = null, status = "running" } = options;
  await host.store.turns.create({
    checkpointVersion: 0,
    dedupeKey,
    kind: "notification",
    ...(leaseUntilMs === null
      ? {}
      : {
          lease: {
            attempt: 1,
            leaseId: `lease:${runId}`,
            leaseUntilMs,
          },
        }),
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

export async function claimRetryAttempt(
  host: AgentHost,
  payload: CloudflareAgentsFiberPayload,
  options: CloudflareAgentsResumeOptions | undefined
): Promise<void> {
  const claim = options?.claim;
  if (!claim) {
    return;
  }
  const leaseId = leaseIdForResumeClaim(claim, payload.runId);
  if (!leaseId) {
    return;
  }
  const run = await host.store.turns.get(payload.runId);
  if (!run) {
    return;
  }
  await host.store.turns.claim(payload.runId, {
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId,
    leaseMs: 300_000,
    nowMs: Date.now(),
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
