import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import { BufferedAgentTurn } from "../../thread/protocol/turn";
import { agentNamespace } from "../identity/namespace";
import { notificationRunRecord } from "./notification-resume.test-support";
import { resumeAgentTurn } from "./resume";
import {
  createResumeRetryAttempt,
  leaseIdForRetryAuthority,
} from "./retry-authority";

describe("resume claim consumption", () => {
  it("consumes a claim when the addressed run is missing", async () => {
    // Given: one retry attempt and its intended notification run.
    const host = createInMemoryHost();
    const ownerNamespace = agentNamespace("retry-owner");
    const runId = "notification-run-retry-claim";
    const idempotencyKey = "background-complete:retry-claim";
    const attempt = createResumeRetryAttempt({
      prefix: "tenant-a",
      runId,
    });
    await host.store.turns.create(
      notificationRunRecord({ idempotencyKey, ownerNamespace, runId })
    );
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: userText("retry claim ready"),
      notificationId: "notification-retry-claim",
      ownerNamespace,
      runId,
      status: "pending",
      threadKey: "default",
    });

    // When: a wrong run consumes the claim before the intended run is resumed.
    await expect(
      resumeAgentTurn({
        claim: attempt.claim,
        host,
        ownerNamespace,
        resumeNotification: () => {
          throw new Error("Missing runs must not resume.");
        },
        runId: "missing-run",
      })
    ).resolves.toBeNull();
    let claimedLeaseId: string | undefined;
    await resumeAgentTurn({
      claim: attempt.claim,
      host,
      ownerNamespace,
      resumeNotification: (_notification, run) => {
        claimedLeaseId = run.lease.leaseId;
        const turn = new BufferedAgentTurn(run.runId);
        turn.close();
        return Promise.resolve(turn);
      },
      runId,
    });

    // Then: the stale public claim cannot recover the paired retry authority.
    const retryLeaseId = leaseIdForRetryAuthority(
      attempt.authority,
      "tenant-a",
      runId
    );
    expect(claimedLeaseId).toBeTypeOf("string");
    expect(claimedLeaseId).not.toBe(retryLeaseId);
  });
});
