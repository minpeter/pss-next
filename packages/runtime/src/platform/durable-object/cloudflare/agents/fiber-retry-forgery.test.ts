import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../../../execution";
import {
  createRetryHost,
  seedRetryableNotification,
} from "./fiber-retry-test-support";
import {
  cloudflareAgentsRunPayload,
  createCloudflareAgentsFiberRetryScheduler,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents retry authority", () => {
  it.each([null, Object.freeze({})])(
    "rejects a directly forged retry authority",
    async (forgedAuthority) => {
      // Given: eligible work and a public retry function.
      const cloudflareAgent = createFakeCloudflareAgent();
      const host = createRetryHost(cloudflareAgent, () =>
        Promise.resolve(null)
      );
      const runId = "background:bg_direct_authority_forgery";
      await seedRetryableNotification(host, runId, {
        leaseUntilMs: null,
        status: "running",
      });
      const retry = createCloudflareAgentsFiberRetryScheduler({
        cloudflareAgent,
        storage: cloudflareAgent.durableObjectContext.storage,
      });
      const payload = cloudflareAgentsRunPayload({
        prefix: "tenant-a",
        runId,
      });
      const before = await host.store.turns.get(runId);

      // When: hostile JavaScript supplies null or an arbitrary object.
      const retried = await Reflect.apply(retry, undefined, [
        payload,
        "error",
        forgedAuthority,
      ]);

      // Then: runtime nominal identity rejects the forged value.
      expect(retried).toBe(false);
      expect(cloudflareAgent.scheduled).toEqual([]);
      await expect(host.store.turns.get(runId)).resolves.toEqual(before);
    }
  );

  it("does not let a custom resumer resurrect a completed non-notification run", async () => {
    // Given: a terminal user turn and a custom resumer that forges authority.
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(
      cloudflareAgent,
      (payload) => Promise.resolve(runWithText(payload.runId)),
      { maxEvents: 0 }
    );
    const runId = "background:bg_completed_forgery";
    await createUserTurn(host, runId, "completed");

    // When: event-budget retry follows the forged resume result.
    const resumed = host.scheduler.enqueueRun(runId);

    // Then: terminal work is not scheduled or mutated.
    await expect(resumed).rejects.toThrow(
      "PSS Runtime fiber interrupted: event-budget"
    );
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("does not let forged null ownership adopt an unknown expired lease", async () => {
    // Given: an expired notification lease owned by another worker.
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createRetryHost(
      cloudflareAgent,
      () => Promise.resolve(null),
      undefined,
      { claimBeforeResume: false }
    );
    const runId = "background:bg_unknown_expired_owner";
    const leaseUntilMs = Date.now() - 1000;
    await seedRetryableNotification(host, runId, { leaseUntilMs });
    const before = await host.store.turns.get(runId);

    // When: a custom resumer supplies null as purported retry authority.
    const resumed = host.scheduler.enqueueRun(runId);

    // Then: no retry adopts or clears the unknown lease.
    await expect(resumed).rejects.toThrow(
      "PSS Runtime fiber interrupted: not-claimable"
    );
    expect(cloudflareAgent.scheduled).toEqual([]);
    await expect(host.store.turns.get(runId)).resolves.toEqual(before);
  });
});

async function createUserTurn(
  host: AgentHost,
  runId: string,
  status: "completed"
): Promise<void> {
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status,
    threadKey: "thread-a",
  });
}
