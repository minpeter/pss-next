import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../../../execution";
import {
  type CloudflareAgentsResumeRun,
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsRunPayload,
  createCloudflarePlatformContext,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents platform context", () => {
  it("resumes delayed callbacks with an allowed scheduled payload prefix", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const prefixes: string[] = [];
    const runIds: string[] = [];
    const resume: CloudflareAgentsResumeRun = (payload) => {
      prefixes.push(payload.prefix);
      runIds.push(payload.runId);
      return Promise.resolve(runWithText(payload.runId));
    };
    const context = createCloudflarePlatformContext({
      cloudflareAgent,
      createAgent: ({ host, prefix }) => ({
        host,
        prefix,
        resume: (runId: string) =>
          resume({
            kind: "run",
            prefix,
            runId,
            version: 1,
          }),
      }),
      allowedPrefixes: ["scheduled-prefix"],
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });
    const scheduledHost = context.host("scheduled-prefix");

    await scheduledHost.scheduler.enqueueRun("background:bg_scheduled", {
      runAfterMs: 1000,
    });
    await context.resumeScheduledFiber(cloudflareAgent.scheduled[0]?.payload);

    expect(prefixes).toEqual(["scheduled-prefix"]);
    expect(runIds).toEqual(["background:bg_scheduled"]);
    expect(cloudflareAgent.started).toEqual([
      {
        idempotencyKey: runFiberKey(
          "scheduled-prefix",
          "background:bg_scheduled"
        ),
        name: "pss-runtime:resume-run",
        snapshot: {
          kind: "run",
          prefix: "scheduled-prefix",
          runId: "background:bg_scheduled",
          version: 1,
        },
      },
    ]);
  });

  it("rejects delayed callbacks outside the allowed prefix set", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const context = createCloudflarePlatformContext({
      cloudflareAgent,
      createAgent: ({ prefix }) => ({
        prefix,
        resume: (runId: string) => {
          resumed.push(`${prefix}:${runId}`);
          return Promise.resolve(runWithText(runId));
        },
      }),
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });

    const result = await context.resumeScheduledFiber({
      kind: "run",
      prefix: "scheduled-prefix",
      runId: "background:bg_blocked",
      version: 1,
    });

    expect(result).toMatchObject({
      accepted: false,
      status: "aborted",
    });
    expect(resumed).toEqual([]);
    expect(cloudflareAgent.started).toEqual([]);
  });

  it("uses allowPrefix to authorize multi-prefix delayed callbacks", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const context = createCloudflarePlatformContext({
      allowPrefix: ({ prefix }) => prefix.startsWith("tenant-"),
      cloudflareAgent,
      createAgent: ({ prefix }) => ({
        prefix,
        resume: (runId: string) => {
          resumed.push(`${prefix}:${runId}`);
          return Promise.resolve(runWithText(runId));
        },
      }),
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });
    const tenantHost = context.host("tenant-a");

    await tenantHost.scheduler.enqueueRun("background:bg_allowed", {
      runAfterMs: 1000,
    });
    await expect(
      context.resumeScheduledFiber(cloudflareAgent.scheduled[0]?.payload)
    ).resolves.toMatchObject({
      accepted: true,
      status: "completed",
    });
    expect(resumed).toEqual(["tenant-a:background:bg_allowed"]);
  });

  it("reschedules allowed scheduled payloads using the payload prefix", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const context = createCloudflarePlatformContext({
      cloudflareAgent,
      createAgent: ({ prefix }) => ({
        prefix,
        resume: () => Promise.resolve(null),
      }),
      allowedPrefixes: ["scheduled-prefix"],
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });
    const scheduledHost = context.host("scheduled-prefix");

    await seedRetryableNotification(
      scheduledHost,
      "background:bg_retry_scheduled"
    );
    await scheduledHost.scheduler.enqueueRun("background:bg_retry_scheduled", {
      runAfterMs: 1000,
    });
    await context.resumeScheduledFiber(cloudflareAgent.scheduled[0]?.payload);

    expect(cloudflareAgent.scheduled).toEqual([
      {
        callback: "resumePssRuntimeFiber",
        idempotent: true,
        payload: {
          kind: "run",
          prefix: "scheduled-prefix",
          runId: "background:bg_retry_scheduled",
          scheduleDelaySeconds: 1,
          version: 1,
        },
        when: 1,
      },
      {
        callback: "resumePssRuntimeFiber",
        idempotent: true,
        payload: {
          attempt: 1,
          kind: "run",
          prefix: "scheduled-prefix",
          runId: "background:bg_retry_scheduled",
          scheduleDelaySeconds: 1,
          version: 1,
        },
        when: 1,
      },
    ]);
    const run = await scheduledHost.store.turns.get(
      "background:bg_retry_scheduled"
    );
    const notification =
      await scheduledHost.store.notifications.getByIdempotencyKey(
        dedupeKeyFor("background:bg_retry_scheduled")
      );
    expect(run).toMatchObject({
      runId: "background:bg_retry_scheduled",
      status: "queued",
    });
    expect(run?.lease).toBeUndefined();
    expect(notification).toMatchObject({
      runId: "background:bg_retry_scheduled",
      status: "pending",
    });
  });
});

function runFiberKey(prefix: string, runId: string): string {
  return cloudflareAgentsFiberIdempotencyKey(
    cloudflareAgentsRunPayload({ prefix, runId })
  );
}

async function seedRetryableNotification(
  host: AgentHost,
  runId: string
): Promise<void> {
  const dedupeKey = dedupeKeyFor(runId);
  await host.store.turns.create({
    checkpointVersion: 0,
    dedupeKey,
    kind: "notification",
    rootRunId: runId,
    runId,
    status: "queued",
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

function dedupeKeyFor(runId: string): string {
  return `dedupe:${runId}`;
}
