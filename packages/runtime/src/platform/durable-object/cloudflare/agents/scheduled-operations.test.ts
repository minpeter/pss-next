import { describe, expect, it } from "vitest";
import type { CloudflareAgentsFiberPayload } from "./index";
import {
  ackScheduledCloudflareAgentsRun,
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberRetryScheduler,
  createCloudflareAgentsFiberScheduler,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents scheduled operations parity", () => {
  it("mirrors delayed Agents runs into the Durable Object queue", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
      storage,
    });

    await scheduler.enqueueRun("background:bg_delayed", { runAfterMs: 1200 });

    expect(cloudflareAgent.scheduled).toHaveLength(1);
    expect(storageAlarmTime(storage)).toBeUndefined();
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["background:bg_delayed"]);

    await ackScheduledCloudflareAgentsRun(storage, "background:bg_delayed", {
      prefix: "tenant-a",
    });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
    const ackedResult = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      storage,
    });
    expect(ackedResult).toMatchObject({ accepted: false, status: "aborted" });
    expect(cloudflareAgent.started).toEqual([]);

    await scheduler.enqueueRun("background:bg_rescheduled", {
      runAfterMs: 1000,
    });
    const consumedResult = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[1]?.payload,
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      storage,
    });
    expect(consumedResult).toMatchObject({
      accepted: true,
      name: "pss-runtime:resume-run",
      status: "completed",
    });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("rolls back mirrored delayed rows when SDK scheduling fails", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    cloudflareAgent.schedule = () =>
      Promise.reject(new Error("schedule failed"));
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
      storage,
    });

    await expect(
      scheduler.enqueueRun("background:bg_schedule_failed", {
        runAfterMs: 1000,
      })
    ).rejects.toThrow("schedule failed");

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("keeps mirrored delayed rows until scheduled fibers are accepted", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const originalStartFiber = cloudflareAgent.startFiber;
    const storage = cloudflareAgent.durableObjectContext.storage;
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
      storage,
    });

    await scheduler.enqueueRun("background:bg_start_failed", {
      runAfterMs: 1000,
    });
    cloudflareAgent.startFiber = () =>
      Promise.reject(new Error("start failed"));
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgent.scheduled[0]?.payload,
        resume: (payload: CloudflareAgentsFiberPayload) =>
          Promise.resolve(runWithText(payload.runId)),
        storage,
      })
    ).rejects.toThrow("start failed");
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["background:bg_start_failed"]);

    cloudflareAgent.startFiber = originalStartFiber;
    const accepted = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      storage,
    });

    expect(accepted).toMatchObject({ accepted: true, status: "completed" });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("mirrors delayed thread retries without arming the fallback alarm", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 5000,
      storage,
    });

    await expect(
      retry(
        cloudflareAgentsThreadPayload({
          idempotencyKey: "source:thread:1",
          notificationId: "notification:1",
          prefix: "tenant-a",
          runId: "background:bg_thread_retry",
          threadKey: "thread-a",
        }),
        "event-budget"
      )
    ).resolves.toBe(true);

    expect(cloudflareAgent.scheduled).toMatchObject([
      {
        callback: "resumePssRuntimeFiber",
        idempotent: true,
        payload: {
          attempt: 1,
          kind: "thread",
          prefix: "tenant-a",
          runId: "background:bg_thread_retry",
          scheduleDelaySeconds: 5,
          threadKey: "thread-a",
        },
        when: 5,
      },
    ]);
    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).resolves.toEqual([
      {
        idempotencyKey: "source:thread:1",
        notificationId: "notification:1",
        runId: "background:bg_thread_retry",
        threadKey: "thread-a",
      },
    ]);
    expect(storageAlarmTime(storage)).toBeUndefined();
  });

  it("claims mirrored delayed runs once across overlapping callbacks", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
      storage,
    });
    let resumed = 0;

    await scheduler.enqueueRun("background:bg_once", { runAfterMs: 1200 });
    const payload = cloudflareAgent.scheduled[0]?.payload;
    const results = await Promise.all([
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload,
        resume: (fiberPayload: CloudflareAgentsFiberPayload) => {
          resumed += 1;
          return Promise.resolve(runWithText(fiberPayload.runId));
        },
        storage,
      }),
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload,
        resume: (fiberPayload: CloudflareAgentsFiberPayload) => {
          resumed += 1;
          return Promise.resolve(runWithText(fiberPayload.runId));
        },
        storage,
      }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toHaveLength(1);
    expect(resumed).toBe(1);
    expect(cloudflareAgent.started).toHaveLength(1);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });
});

function storageAlarmTime(storage: unknown): number | undefined {
  if (typeof storage !== "object" || storage === null) {
    return;
  }
  if (!("alarmTime" in storage) || typeof storage.alarmTime !== "function") {
    return;
  }
  return storage.alarmTime();
}
