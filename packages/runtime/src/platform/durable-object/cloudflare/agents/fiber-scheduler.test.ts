import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../index";
import {
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberScheduler,
  createCloudflareHost,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents fiber platform adapter", () => {
  it("starts immediate PSS runs in Cloudflare Agents fibers", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const events: AgentEvent[] = [];
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      onEvent: (_context, event) => {
        events.push(event);
      },
      prefix: "tenant-a",
      resume: (payload) => {
        resumed.push(`${payload.kind}:${payload.runId}`);
        return Promise.resolve(runWithText(payload.runId));
      },
    });

    await scheduler.enqueueRun("background:bg_immediate");

    expect(resumed).toEqual(["run:background:bg_immediate"]);
    expect(events).toEqual([
      { text: "background:bg_immediate", type: "assistant-output" },
    ]);
    expect(cloudflareAgent.started).toEqual([
      {
        idempotencyKey: runFiberKey("tenant-a", "background:bg_immediate"),
        name: "pss-runtime:resume-run",
        snapshot: {
          kind: "run",
          prefix: "tenant-a",
          runId: "background:bg_immediate",
          version: 1,
        },
      },
    ]);
    expect(cloudflareAgent.scheduled).toEqual([]);
  });

  it("routes delayed PSS runs through Cloudflare Agents schedules before fiber start", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: (payload) => {
        resumed.push(`${payload.kind}:${payload.runId}`);
        return Promise.resolve(null);
      },
    });

    await scheduler.enqueueRun("background:bg_delayed", { runAfterMs: 1200 });

    expect(resumed).toEqual([]);
    expect(cloudflareAgent.started).toEqual([]);
    expect(cloudflareAgent.scheduled).toEqual([
      {
        callback: "resumePssRuntimeFiber",
        idempotent: true,
        payload: {
          kind: "run",
          prefix: "tenant-a",
          runId: "background:bg_delayed",
          scheduleDelaySeconds: 2,
          version: 1,
        },
        when: 2,
      },
    ]);

    await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload) => {
        resumed.push(`${payload.kind}:${payload.runId}`);
        return Promise.resolve(runWithText(payload.runId));
      },
    });

    expect(resumed).toEqual(["run:background:bg_delayed"]);
    expect(cloudflareAgent.started).toEqual([
      {
        idempotencyKey: runFiberKey("tenant-a", "background:bg_delayed"),
        name: "pss-runtime:resume-run",
        snapshot: {
          kind: "run",
          prefix: "tenant-a",
          runId: "background:bg_delayed",
          version: 1,
        },
      },
    ]);
  });

  it("separates idempotent delayed schedules when their delay changes", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
    });

    await scheduler.enqueueRun("background:bg_delay_changed", {
      runAfterMs: 5000,
    });
    await scheduler.enqueueRun("background:bg_delay_changed", {
      runAfterMs: 1000,
    });

    expect(cloudflareAgent.scheduled).toMatchObject([
      {
        payload: {
          kind: "run",
          runId: "background:bg_delay_changed",
          scheduleDelaySeconds: 5,
        },
        when: 5,
      },
      {
        payload: {
          kind: "run",
          runId: "background:bg_delay_changed",
          scheduleDelaySeconds: 1,
        },
        when: 1,
      },
    ]);
  });

  it("rejects scheduled payloads with untrusted prefixes", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const result = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: {
        kind: "run",
        prefix: "tenant-b",
        runId: "background:bg_foreign",
        version: 1,
      },
      resume: (payload) => {
        resumed.push(payload.runId);
        return Promise.resolve(null);
      },
    });

    expect(result).toMatchObject({ accepted: false, status: "aborted" });
    expect(resumed).toEqual([]);
    expect(cloudflareAgent.started).toEqual([]);
  });

  it("rejects malformed scheduled payloads before fiber start", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const result = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: {
        kind: "run",
        prefix: "tenant-a",
        runId: "",
        version: 1,
      },
      resume: (payload) => {
        resumed.push(payload.runId);
        return Promise.resolve(null);
      },
    });

    expect(result).toMatchObject({ accepted: false, status: "aborted" });
    expect(resumed).toEqual([]);
    expect(cloudflareAgent.started).toEqual([]);
  });

  it("maps thread resume scheduling to an idempotent Cloudflare Agents fiber", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: (payload) => {
        if (payload.kind !== "thread") {
          throw new TypeError("Expected thread payload");
        }
        resumed.push(`${payload.kind}:${payload.runId}:${payload.threadKey}`);
        return Promise.resolve(runWithText(payload.runId));
      },
    });

    await scheduler.resumeThread("thread-a", {
      idempotencyKey: "notification:1",
      notificationId: "notif-1",
      runId: "background:bg_thread",
    });

    expect(resumed).toEqual(["thread:background:bg_thread:thread-a"]);
    expect(cloudflareAgent.started).toEqual([
      {
        idempotencyKey: threadFiberKey("tenant-a", "notification:1"),
        name: "pss-runtime:resume-thread",
        snapshot: {
          idempotencyKey: "notification:1",
          kind: "thread",
          notificationId: "notif-1",
          prefix: "tenant-a",
          runId: "background:bg_thread",
          threadKey: "thread-a",
          version: 1,
        },
      },
    ]);
  });

  it("builds an execution host over the Cloudflare Agents Durable Object storage", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const host = createCloudflareHost({
      cloudflareAgent,
      durableObjectContext: cloudflareAgent.durableObjectContext,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
    });

    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: "background:bg_host",
      runId: "background:bg_host",
      status: "queued",
      threadKey: "thread-a",
    });
    await host.scheduler.enqueueRun("background:bg_host");

    await expect(
      host.store.turns.get("background:bg_host")
    ).resolves.toMatchObject({
      runId: "background:bg_host",
      status: "queued",
    });
    expect(cloudflareAgent.started).toHaveLength(1);
  });
});

function runFiberKey(prefix: string, runId: string): string {
  return cloudflareAgentsFiberIdempotencyKey(
    cloudflareAgentsRunPayload({ prefix, runId })
  );
}

function threadFiberKey(prefix: string, idempotencyKey: string): string {
  return cloudflareAgentsFiberIdempotencyKey(
    cloudflareAgentsThreadPayload({
      idempotencyKey,
      prefix,
      runId: "background:bg_thread",
      threadKey: "thread-a",
    })
  );
}
