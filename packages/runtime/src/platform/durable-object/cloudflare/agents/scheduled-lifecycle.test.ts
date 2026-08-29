import { describe, expect, it } from "vitest";
import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsStartFiberOptions,
  CloudflareAgentsStartFiberResult,
} from "./index";
import {
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberRetryScheduler,
  createCloudflareAgentsFiberScheduler,
  listScheduledCloudflareAgentsRuns,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import {
  claimCloudflareAgentsScheduledPayload,
  hasCloudflareAgentsScheduledPayload,
  mirrorCloudflareAgentsScheduledPayload,
} from "./scheduled-work";
import { ackListedCloudflareAgentsScheduledRun } from "./scheduled-work-list";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents scheduled lifecycle", () => {
  it("keeps retry payload rows scheduled from delayed callbacks", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      storage,
    });
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
      retry,
      storage,
    });

    await scheduler.enqueueRun("background:bg_retry_from_callback", {
      runAfterMs: 1000,
    });
    await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      drain: { maxEvents: 0 },
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      retry,
      storage,
    });

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["background:bg_retry_from_callback"]);
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgent.scheduled[1]?.payload,
        resume: (payload: CloudflareAgentsFiberPayload) =>
          Promise.resolve(runWithText(payload.runId)),
        retry,
        storage,
      })
    ).resolves.toMatchObject({ accepted: true, status: "completed" });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("consumes delayed rows before checking existing fiber receipts", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    cloudflareAgent.startFiber = (name, _fn, options) =>
      Promise.resolve(existingFiberResult(name, options));
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
      storage,
    });

    await scheduler.enqueueRun("background:bg_existing_receipt", {
      runAfterMs: 1000,
    });
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgent.scheduled[0]?.payload,
        resume: (payload: CloudflareAgentsFiberPayload) =>
          Promise.resolve(runWithText(payload.runId)),
        storage,
      })
    ).resolves.toMatchObject({ accepted: false, status: "running" });

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("backs off retries and stops at the configured max attempt", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryMaxAttempts: 2,
      retryMaxRunAfterMs: 10_000,
      retryRunAfterMs: 1000,
      storage,
    });

    await expect(
      retry(
        cloudflareAgentsRunPayload({
          attempt: 1,
          prefix: "tenant-a",
          runId: "background:bg_retry_cap",
        }),
        "error"
      )
    ).resolves.toBe(true);
    await expect(
      retry(
        cloudflareAgentsRunPayload({
          attempt: 2,
          prefix: "tenant-a",
          runId: "background:bg_retry_cap",
        }),
        "error"
      )
    ).resolves.toBe(false);

    expect(cloudflareAgent.scheduled).toMatchObject([
      {
        payload: {
          attempt: 2,
          kind: "run",
          runId: "background:bg_retry_cap",
          scheduleDelaySeconds: 2,
        },
        when: 2,
      },
    ]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["background:bg_retry_cap"]);
  });

  it("keeps run retry rows distinct from delimiter-like original run ids", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const originalPayload = cloudflareAgentsRunPayload({
      prefix: "tenant-a",
      runId: "run|attempt:1",
    });
    const retryPayload = cloudflareAgentsRunPayload({
      attempt: 1,
      prefix: "tenant-a",
      runId: "run",
    });

    await mirrorCloudflareAgentsScheduledPayload({
      payload: originalPayload,
      runAfterMs: 1000,
      storage,
    });
    await mirrorCloudflareAgentsScheduledPayload({
      payload: retryPayload,
      runAfterMs: 1000,
      storage,
    });

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["run|attempt:1", "run"]);
    await expect(
      claimCloudflareAgentsScheduledPayload(storage, retryPayload)
    ).resolves.toBe(true);
    await expect(
      hasCloudflareAgentsScheduledPayload(storage, originalPayload)
    ).resolves.toBe(true);
    await ackListedCloudflareAgentsScheduledRun(storage, "run|attempt:1", {
      prefix: "tenant-a",
    });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("keeps thread retry rows distinct from original delayed callbacks", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const originalPayload = cloudflareAgentsThreadPayload({
      idempotencyKey: "idem-a",
      notificationId: "notification-a",
      prefix: "tenant-a",
      runId: "run-thread-retry",
      threadKey: "thread-a",
    });
    const retryPayload = cloudflareAgentsThreadPayload({
      attempt: 1,
      idempotencyKey: "idem-a",
      notificationId: "notification-a",
      prefix: "tenant-a",
      runId: "run-thread-retry",
      threadKey: "thread-a",
    });

    await mirrorCloudflareAgentsScheduledPayload({
      payload: originalPayload,
      runAfterMs: 1000,
      storage,
    });
    await mirrorCloudflareAgentsScheduledPayload({
      payload: retryPayload,
      runAfterMs: 1000,
      storage,
    });

    await expect(
      claimCloudflareAgentsScheduledPayload(storage, originalPayload)
    ).resolves.toBe(true);
    await expect(
      hasCloudflareAgentsScheduledPayload(storage, retryPayload)
    ).resolves.toBe(true);
    await expect(
      claimCloudflareAgentsScheduledPayload(storage, retryPayload)
    ).resolves.toBe(true);
    await expect(
      hasCloudflareAgentsScheduledPayload(storage, retryPayload)
    ).resolves.toBe(false);
  });
});

function existingFiberResult(
  name: string,
  options: CloudflareAgentsStartFiberOptions | undefined
): CloudflareAgentsStartFiberResult {
  return {
    accepted: false,
    createdAt: Date.now(),
    fiberId: "fiber-existing",
    idempotencyKey: options?.idempotencyKey,
    metadata: options?.metadata,
    name,
    status: "running",
  };
}
