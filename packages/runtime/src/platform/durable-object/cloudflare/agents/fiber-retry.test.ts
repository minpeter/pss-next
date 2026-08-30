import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../../../execution";
import {
  createRetryHost,
  expectActiveLeasedNotification,
  expectCompletedNotification,
  expectRetryScheduled,
  seedRetryableNotification,
} from "./fiber-retry-test-support";
import {
  listScheduledCloudflareAgentsRuns,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents fiber retries", () => {
  it("does not reschedule active leased notifications when resume cannot claim a run", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_active_lease_not_claimable";
    const leaseUntilMs = Date.now() + 60_000;

    await seedRetryableNotification(host, runId, {
      leaseUntilMs,
      status: "leased",
    });

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "PSS Runtime fiber interrupted: not-claimable"
    );
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(
        cloudflareAgent.durableObjectContext.storage,
        { prefix: "tenant-a" }
      )
    ).resolves.toEqual([]);
    await expectActiveLeasedNotification(host, runId, leaseUntilMs);
  });

  it("does not reschedule completed notifications when resume cannot claim a run", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_completed_not_claimable";

    await seedRetryableNotification(host, runId, { status: "completed" });

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "PSS Runtime fiber interrupted: not-claimable"
    );
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expectCompletedNotification(host, runId);
  });

  it("reschedules retryable notifications when draining hits the event budget", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );

    await seedRetryableNotification(host, "background:bg_event_budget", {
      leaseUntilMs: null,
      status: "running",
    });
    await host.scheduler.enqueueRun("background:bg_event_budget");

    await expectRetryScheduled({
      cloudflareAgent,
      host,
      runId: "background:bg_event_budget",
    });
  });

  it("reschedules non-notification runs when draining hits the event budget", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const runId = "background:bg_user_event_budget";
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "running",
      threadKey: "thread-a",
    });

    await host.scheduler.enqueueRun(runId);

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
  });

  it("does not resurrect notifications completed before an event-budget retry", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    let host: AgentHost;
    host = createRetryHost(
      cloudflareAgent,
      async (payload) => {
        const run = await host.store.turns.get(payload.runId);
        if (!run) {
          throw new Error(`missing run: ${payload.runId}`);
        }
        const { lease: _lease, ...runWithoutLease } = run;
        await host.store.turns.update({
          ...runWithoutLease,
          status: "completed",
        });
        return runWithText(payload.runId);
      },
      { maxEvents: 0 }
    );

    const runId = "background:bg_completed_event_budget";
    await seedRetryableNotification(host, runId);

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "PSS Runtime fiber interrupted: event-budget"
    );

    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(
        cloudflareAgent.durableObjectContext.storage,
        { prefix: "tenant-a" }
      )
    ).resolves.toEqual([]);
    await expectCompletedNotification(host, runId);
  });

  it("uses a fresh fiber idempotency key when a scheduled retry starts", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );

    await seedRetryableNotification(host, "background:bg_retry_key", {
      leaseUntilMs: null,
      status: "running",
    });
    await host.scheduler.enqueueRun("background:bg_retry_key");

    const firstFiberKey = cloudflareAgent.started[0]?.idempotencyKey;
    await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
    });

    expect(firstFiberKey).toBe(
      "pss-runtime:run:8:tenant-a:23:background:bg_retry_key"
    );
    expect(cloudflareAgent.started[1]?.idempotencyKey).toBe(
      "pss-runtime:run:8:tenant-a:23:background:bg_retry_key:attempt:1"
    );
  });

  it("does not requeue notifications before retry scheduling succeeds", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    cloudflareAgent.schedule = () =>
      Promise.reject(new Error("schedule failed"));
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );
    const runId = "background:bg_schedule_failure";

    await seedRetryableNotification(host, runId, {
      leaseUntilMs: null,
      status: "running",
    });

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "schedule failed"
    );
    await expect(
      listScheduledCloudflareAgentsRuns(
        cloudflareAgent.durableObjectContext.storage,
        { prefix: "tenant-a" }
      )
    ).resolves.toEqual([]);
    await expect(host.store.turns.get(runId)).resolves.toEqual(
      expect.objectContaining({ runId, status: "leased" })
    );
    await expect(
      host.store.notifications.getByIdempotencyKey(`dedupe:${runId}`)
    ).resolves.toMatchObject({ runId, status: "acked" });
  });

  it("restores a newly claimed expired lease when scheduling fails", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    cloudflareAgent.schedule = () =>
      Promise.reject(new Error("schedule failed"));
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_not_claimable_schedule_failure";
    const leaseUntilMs = Date.now() - 1000;

    await seedRetryableNotification(host, runId, { leaseUntilMs });

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "schedule failed"
    );
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(
        cloudflareAgent.durableObjectContext.storage,
        { prefix: "tenant-a" }
      )
    ).resolves.toEqual([]);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      runId,
      status: "leased",
    });
  });

  it("reschedules retryable notifications when resume work throws", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(cloudflareAgent, async () => {
      await Promise.resolve();
      throw new Error("resume failed");
    });

    await seedRetryableNotification(host, "background:bg_throw", {
      leaseUntilMs: null,
      status: "running",
    });
    await host.scheduler.enqueueRun("background:bg_throw");

    await expectRetryScheduled({
      cloudflareAgent,
      host,
      runId: "background:bg_throw",
    });
  });
});
