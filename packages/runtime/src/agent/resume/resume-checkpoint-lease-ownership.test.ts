import { describe, expect, it } from "vitest";
import { transitionTurn } from "../../execution/host/turn-status";
import type { AgentHost, TurnStore } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import { BufferedAgentTurn } from "../../thread/protocol/turn";
import { startThreadExecutionRun } from "../../thread/runtime/execution";
import { ThreadState } from "../../thread/state/thread-state";
import { agentNamespace } from "../identity/namespace";
import { notificationRunRecord } from "./notification-resume.test-support";
import { resumeAgentTurn } from "./resume";

describe("resume checkpoint lease ownership", () => {
  it("does not checkpoint with a lease acquired after resume began", async () => {
    // Given: a queued notification owned by the resuming agent.
    const base = createInMemoryHost();
    const runId = "resume-checkpoint-handoff";
    const idempotencyKey = "resume-checkpoint-handoff-key";
    const ownerNamespace = agentNamespace("checkpoint-owner");
    await base.store.turns.create(
      notificationRunRecord({ idempotencyKey, ownerNamespace, runId })
    );
    await base.store.notifications.enqueue({
      idempotencyKey,
      input: userText("resume checkpoint work"),
      notificationId: "resume-checkpoint-notification",
      ownerNamespace,
      runId,
      status: "pending",
      threadKey: "default",
    });
    const host = hostWithLeaseHandoff(base);

    // When: ownership changes after the resume transition but before its
    // checkpoint context captures ownership.
    const resumed = resumeAgentTurn({
      host,
      ownerNamespace,
      resumeNotification: async (_notification, claimed) => {
        const execution = await startThreadExecutionRun({
          executionHost: host,
          executionRun: {
            kind: "notification",
            leaseId: claimed.lease?.leaseId,
            runId,
          },
          state: new ThreadState({ key: "default", store: host.store.threads }),
          threadKey: "default",
          turnId: "unused",
        });
        if (execution?.toolExecution.beforeTool === undefined) {
          throw new Error("Expected a resumable checkpoint context.");
        }
        await execution.toolExecution.beforeTool({
          attempt: 1,
          idempotencyKey: "resume-checkpoint-tool",
          input: {},
          policy: "idempotent",
          toolCallId: "resume-checkpoint-tool",
          toolName: "checkpoint-tool",
        });
        const turn = new BufferedAgentTurn(runId);
        turn.close();
        return turn;
      },
      runId,
    });

    // Then: the stale resume is fenced instead of adopting the later lease.
    await expect(resumed).rejects.toBeInstanceOf(Error);
    await expect(base.store.checkpoints.latest(runId)).resolves.toBeNull();
  });
});

function hostWithLeaseHandoff(base: AgentHost): AgentHost {
  return {
    ...base,
    store: {
      ...base.store,
      turns: turnsWithLeaseHandoff(base.store.turns),
    },
  };
}

function turnsWithLeaseHandoff(turns: TurnStore): TurnStore {
  return new Proxy(turns, {
    get(target, property) {
      if (property !== "transition") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (
        ...parameters: Parameters<NonNullable<TurnStore["transition"]>>
      ) => {
        const [runId, expected, update] = parameters;
        const result = await transitionTurn(target, {
          expected,
          runId,
          update,
        });
        if (result.ok && update.status === "running") {
          await target.claim(runId, {
            attempt: 2,
            leaseId: "owner-after-resume",
            leaseMs: 300_000,
            nowMs: Date.now() + 600_000,
          });
        }
        return result;
      };
    },
  });
}
