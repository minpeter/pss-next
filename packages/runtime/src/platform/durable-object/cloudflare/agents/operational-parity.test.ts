import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../index";
import { sourceCloudflareAgentNotificationIdempotencyKey } from "../dispatch/notification-dispatch";
import type { CloudflareAgentsFiberPayload } from "./index";
import {
  createCloudflareAgentsFiberScheduler,
  dispatchCloudflareAgentsNotification,
  listScheduledCloudflareAgentsThreadPrompts,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

type CloudflareAgentsEventContext =
  | {
      readonly kind: "run";
      readonly prefix: string;
      readonly runId: string;
      readonly source: "scheduled-run";
      readonly threadKey?: string;
    }
  | {
      readonly idempotencyKey: string | undefined;
      readonly kind: "thread";
      readonly notificationId: string | undefined;
      readonly prefix: string;
      readonly runId: string;
      readonly source: "thread-prompt";
      readonly threadKey: string;
    };

describe("Cloudflare Agents operational parity", () => {
  it("passes payload-derived run and thread context to onEvent", async () => {
    // Given: a Cloudflare Agents fiber scheduler drains both run and thread payloads.
    const cloudflareAgent = createFakeCloudflareAgent();
    const observedEvents: string[] = [];
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      onEvent: (context: CloudflareAgentsEventContext, event: AgentEvent) => {
        if (event.type !== "assistant-output") {
          return;
        }
        switch (context.source) {
          case "scheduled-run":
            observedEvents.push(
              `${context.source}:${context.kind}:${context.prefix}:${context.runId}:${event.text}`
            );
            return;
          case "thread-prompt":
            observedEvents.push(
              `${context.source}:${context.kind}:${context.prefix}:${context.runId}:${context.threadKey}:${context.idempotencyKey}:${context.notificationId}:${event.text}`
            );
            return;
          default:
            assertNever(context);
        }
      },
      prefix: "tenant-a",
      resume: (payload: CloudflareAgentsFiberPayload) => {
        switch (payload.kind) {
          case "run":
            return Promise.resolve(runWithText("run-complete"));
          case "thread":
            return Promise.resolve(runWithText("thread-complete"));
          default:
            assertNever(payload);
        }
      },
    });

    // When: a scheduled run and a thread prompt are resumed through the scheduler.
    await scheduler.enqueueRun("background:bg_run");
    await scheduler.resumeThread("thread-a", {
      idempotencyKey: "source:thread:1",
      notificationId: "notification-1",
      runId: "background:bg_thread",
    });

    // Then: each drained event receives context derived from its original payload.
    expect(observedEvents).toEqual([
      "scheduled-run:run:tenant-a:background:bg_run:run-complete",
      "thread-prompt:thread:tenant-a:background:bg_thread:thread-a:source:thread:1:notification-1:thread-complete",
    ]);
  });

  it("does not fabricate a thread key for scheduled-run event context", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const observedContexts: CloudflareAgentsEventContext[] = [];
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      onEvent: (context: CloudflareAgentsEventContext, event: AgentEvent) => {
        if (event.type === "assistant-output") {
          observedContexts.push(context);
        }
      },
      prefix: "tenant-a",
      resume: () => Promise.resolve(runWithText("run-complete")),
      storage: cloudflareAgent.durableObjectContext.storage,
    });

    await scheduler.enqueueRun("background:bg_no_thread");

    expect(observedContexts).toEqual([
      {
        kind: "run",
        prefix: "tenant-a",
        runId: "background:bg_no_thread",
        source: "scheduled-run",
      },
    ]);
  });

  it("dispatches storage-style notifications through the Agents scheduler", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();

    const dispatched = await dispatchCloudflareAgentsNotification({
      cloudflareAgent,
      durableObjectContext: cloudflareAgent.durableObjectContext,
      idempotencyKey: "connector:oauth:done",
      input: { text: "Connector OAuth completed", type: "user-input" },
      namespace: "agent-a",
      prefix: "tenant-a",
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      threadKey: "room:1:user:2",
    });

    expect(cloudflareAgent.started).toEqual([
      expect.objectContaining({
        name: "pss-runtime:resume-thread",
        snapshot: expect.objectContaining({
          kind: "thread",
          notificationId: dispatched.notificationId,
          prefix: "tenant-a",
          runId: dispatched.runId,
          threadKey: "room:1:user:2",
        }),
      }),
    ]);
    await expect(
      listScheduledCloudflareAgentsThreadPrompts(
        cloudflareAgent.durableObjectContext.storage,
        { prefix: "tenant-a" }
      )
    ).resolves.toEqual([]);
    expect(
      sourceCloudflareAgentNotificationIdempotencyKey({
        idempotencyKey: snapshotIdempotencyKey(
          cloudflareAgent.started[0]?.snapshot
        ),
        namespace: "agent-a",
        threadKey: "room:1:user:2",
      })
    ).toBe("connector:oauth:done");
  });
});

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Cloudflare Agents parity variant: ${value}`);
}

function snapshotIdempotencyKey(snapshot: unknown): string | undefined {
  if (typeof snapshot !== "object" || snapshot === null) {
    return;
  }
  if (!("idempotencyKey" in snapshot)) {
    return;
  }
  return typeof snapshot.idempotencyKey === "string"
    ? snapshot.idempotencyKey
    : undefined;
}
