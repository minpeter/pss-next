import { describe, expect, it } from "vitest";
import { createCloudflareHost } from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents legacy resume retries", () => {
  it("preserves retries for a one-argument resume callback", async () => {
    // Given: a source-compatible callback that cannot forward claim options.
    const cloudflareAgent = createFakeCloudflareAgent();
    const runId = "background:compat-one-arg";
    const host = createCloudflareHost({
      cloudflareAgent,
      drain: { maxEvents: 0 },
      durableObjectContext: cloudflareAgent.durableObjectContext,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
    });
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "running",
      threadKey: "thread-a",
    });

    // When: event-budget exhaustion asks the host to retry.
    await host.scheduler.enqueueRun(runId);

    // Then: the host captures ownership and schedules exactly one retry.
    expect(cloudflareAgent.scheduled).toMatchObject([
      {
        payload: { attempt: 1, runId },
      },
    ]);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      runId,
      status: "queued",
    });
  });
});
