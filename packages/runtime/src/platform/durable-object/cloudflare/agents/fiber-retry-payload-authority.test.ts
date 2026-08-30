import { describe, expect, it } from "vitest";
import {
  claimRetryAttempt,
  createRetryHost,
  seedRetryableRun,
} from "./fiber-retry-test-support";
import {
  cloudflareAgentsRunPayload,
  createCloudflareAgentsFiberRetryScheduler,
  startCloudflareAgentsResumeFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents retry payload authority", () => {
  it("freezes the callback payload before retry ownership is captured", async () => {
    // Given: a final allowed attempt and a resumer that rewinds it.
    const fixture = await createCappedRetryFixture();
    let mutationAccepted = false;

    // When: callback mutation tries to bypass the attempt cap.
    const started = startCloudflareAgentsResumeFiber({
      cloudflareAgent: fixture.cloudflareAgent,
      drain: { maxEvents: 0 },
      payload: fixture.payload,
      resume: async (payload, options) => {
        await claimRetryAttempt(fixture.host, payload, options);
        mutationAccepted = Reflect.set(payload, "attempt", 0);
        return runWithText(payload.runId);
      },
      retry: fixture.retry,
      storage: fixture.storage,
    });

    // Then: the immutable final attempt cannot schedule another retry.
    await expect(started).rejects.toThrow(
      "PSS Runtime fiber interrupted: event-budget"
    );
    expect(mutationAccepted).toBe(false);
    expect(fixture.cloudflareAgent.scheduled).toEqual([]);
  });

  it("rejects same-run authority presented with a substituted attempt", async () => {
    // Given: a final allowed attempt and the official retry scheduler.
    const fixture = await createCappedRetryFixture();

    // When: a retry wrapper substitutes attempt zero under the same run ID.
    const started = startCloudflareAgentsResumeFiber({
      cloudflareAgent: fixture.cloudflareAgent,
      drain: { maxEvents: 0 },
      payload: fixture.payload,
      resume: async (payload, options) => {
        await claimRetryAttempt(fixture.host, payload, options);
        return runWithText(payload.runId);
      },
      retry: (_payload, reason, authority) =>
        fixture.retry(
          cloudflareAgentsRunPayload({
            attempt: 0,
            prefix: "tenant-a",
            runId: fixture.runId,
          }),
          reason,
          authority
        ),
      storage: fixture.storage,
    });

    // Then: complete payload identity mismatch consumes and rejects authority.
    await expect(started).rejects.toThrow(
      "PSS Runtime fiber interrupted: event-budget"
    );
    expect(fixture.cloudflareAgent.scheduled).toEqual([]);
  });
});

async function createCappedRetryFixture() {
  const cloudflareAgent = createFakeCloudflareAgent();
  const storage = cloudflareAgent.durableObjectContext.storage;
  const host = createRetryHost(cloudflareAgent, () => Promise.resolve(null));
  const runId = "background:bg_payload_authority";
  await seedRetryableRun(host, runId);
  return {
    cloudflareAgent,
    host,
    payload: cloudflareAgentsRunPayload({
      attempt: 5,
      prefix: "tenant-a",
      runId,
    }),
    retry: createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryMaxAttempts: 5,
      storage,
    }),
    runId,
    storage,
  };
}
