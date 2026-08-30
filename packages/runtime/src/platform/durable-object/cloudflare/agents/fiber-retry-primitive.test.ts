import { describe, expect, it } from "vitest";
import { resumeAgentTurn } from "../../../../agent/resume/resume";
import type { AgentHost } from "../../../../execution";
import {
  createRetryHost,
  expectRetryScheduled,
} from "./fiber-retry-test-support";
import { createFakeCloudflareAgent } from "./test-support";

describe("Cloudflare Agents primitive retry ownership", () => {
  it("reschedules after notification resume rejects with a primitive", async () => {
    // Given: a real notification resume claim whose work rejects primitively.
    const cloudflareAgent = createFakeCloudflareAgent();
    let host: AgentHost;
    host = createRetryHost(cloudflareAgent, (payload, options) =>
      resumeAgentTurn({
        ...(options?.captureLeaseId
          ? { captureLeaseId: options.captureLeaseId }
          : {}),
        host,
        ownerNamespace: "tenant-a",
        resumeNotification: primitiveResumeFailure,
        runId: payload.runId,
      })
    );
    const runId = "background:bg_primitive_resume_failure";
    await seedOwnedNotification(host, runId);

    // When: the Cloudflare fiber handles the primitive rejection.
    await host.scheduler.enqueueRun(runId);

    // Then: claimed ownership authorizes the normal retry transaction.
    await expectRetryScheduled({ cloudflareAgent, host, runId });
  });

  it("reschedules when notification release replaces the resume error", async () => {
    // Given: resume claims a lease, then work and notification release fail.
    const cloudflareAgent = createFakeCloudflareAgent();
    let host: AgentHost;
    const base = createRetryHost(cloudflareAgent, (payload, options) =>
      resumeAgentTurn({
        ...(options?.captureLeaseId
          ? { captureLeaseId: options.captureLeaseId }
          : {}),
        host,
        ownerNamespace: "tenant-a",
        resumeNotification: () => Promise.reject(new Error("resume failed")),
        runId: payload.runId,
      })
    );
    host = hostWithReleaseFailure(base);
    const runId = "background:bg_release_failure";
    await seedOwnedNotification(host, runId);

    // When: release replaces the original marked error.
    await expect(host.scheduler.enqueueRun(runId)).resolves.toBeUndefined();

    // Then: ownership captured before work still authorizes retry.
    await expectRetryScheduled({ cloudflareAgent, host: base, runId });
  });
});

function primitiveResumeFailure(): Promise<never> {
  const failure: unknown = "primitive resume failure";
  return Promise.reject(failure);
}

async function seedOwnedNotification(
  host: AgentHost,
  runId: string
): Promise<void> {
  const idempotencyKey = `dedupe:${runId}`;
  await host.store.turns.create({
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    ownerNamespace: "tenant-a",
    rootRunId: runId,
    runId,
    status: "queued",
    threadKey: "thread-a",
  });
  await host.store.notifications.enqueue({
    idempotencyKey,
    input: { text: "retry", type: "user-input" },
    notificationId: `notification:${runId}`,
    ownerNamespace: "tenant-a",
    runId,
    status: "pending",
    threadKey: "thread-a",
  });
}

function hostWithReleaseFailure(base: AgentHost): AgentHost {
  const notifications = new Proxy(base.store.notifications, {
    get(target, property) {
      if (property === "releaseByIdempotencyKey") {
        return () => Promise.reject(new Error("release failed"));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new Proxy(base.store, {
    get(target, property) {
      if (property === "notifications") {
        return notifications;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...base, store };
}
