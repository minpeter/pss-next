import { describe, expect, it } from "vitest";
import { createRetryHost } from "./fiber-retry-test-support";
import {
  ackScheduledCloudflareAgentsRun,
  ackScheduledCloudflareAgentsThreadPrompt,
  type CloudflareAgentsScheduledThreadPrompt,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberRetryScheduler,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
} from "./index";
import { createFakeCloudflareAgent } from "./test-support";

const prefix = "tenant-a";

describe("Cloudflare Agents scheduled ack parity", () => {
  it("acks listed run retry rows stored with attempt-aware work ids", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const runId = "background:bg_retry_ack";
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 1000,
      storage,
    });

    await expect(
      retry(cloudflareAgentsRunPayload({ prefix, runId }), "event-budget")
    ).resolves.toBe(true);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([runId]);

    await ackScheduledCloudflareAgentsRun(storage, runId, { prefix });

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([]);
  });

  it("acks listed thread retry rows stored with notification and attempt-aware work ids", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const prompt: CloudflareAgentsScheduledThreadPrompt = {
      idempotencyKey: "source:thread:1",
      notificationId: "notification:1",
      runId: "background:bg_thread_retry_ack",
      threadKey: "thread-a",
    };
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 1000,
      storage,
    });

    await expect(
      retry(
        cloudflareAgentsThreadPayload({
          ...prompt,
          prefix,
          runId: "background:bg_thread_retry_ack",
        }),
        "event-budget"
      )
    ).resolves.toBe(true);
    const listed = await listScheduledCloudflareAgentsThreadPrompts(storage, {
      prefix,
    });
    expect(listed).toEqual([prompt]);
    const [listedPrompt] = listed;
    if (listedPrompt === undefined) {
      throw new Error("Expected a listed Cloudflare Agents thread prompt.");
    }

    await ackScheduledCloudflareAgentsThreadPrompt(storage, listedPrompt, {
      prefix,
    });

    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, { prefix })
    ).resolves.toEqual([]);
  });

  it("does not leave retry side effects when notification retry preparation is not claimable", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
    const runId = "background:bg_missing_dedupe_not_claimable";

    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread-a",
    });

    await expect(host.scheduler.enqueueRun(runId)).rejects.toThrow(
      "PSS Runtime fiber interrupted: not-claimable"
    );

    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix })
    ).resolves.toEqual([]);
  });
});
