import { describe, expect, it } from "vitest";
import {
  createResumeRetryAttempt,
  leaseIdForResumeClaim,
  leaseIdForRetryAuthority,
} from "./retry-authority";

describe("resume retry authority", () => {
  it("consumes the public claim and private authority exactly once", () => {
    // Given: one paired attempt for an exact run and retry scope.
    const attempt = createResumeRetryAttempt({
      runId: "run-a",
      scope: "scope-a",
    });

    // When: each half is read once.
    const claimedLeaseId = leaseIdForResumeClaim(attempt.claim, "run-a");
    const retryLeaseId = leaseIdForRetryAuthority(
      attempt.authority,
      "run-a",
      "scope-a"
    );

    // Then: both halves prove the same lease once and retained tokens are inert.
    expect(claimedLeaseId).toBeTypeOf("string");
    expect(retryLeaseId).toBe(claimedLeaseId);
    expect(leaseIdForResumeClaim(attempt.claim, "run-a")).toBeUndefined();
    expect(
      leaseIdForRetryAuthority(attempt.authority, "run-a", "scope-a")
    ).toBeUndefined();
  });

  it("consumes a wrong-run claim without revealing its lease", () => {
    // Given: one attempt presented to the wrong run first.
    const attempt = createResumeRetryAttempt({
      runId: "run-a",
      scope: "scope-a",
    });

    // When/Then: mismatch fails closed and cannot be retried on the right run.
    expect(leaseIdForResumeClaim(attempt.claim, "run-b")).toBeUndefined();
    expect(leaseIdForResumeClaim(attempt.claim, "run-a")).toBeUndefined();
  });
});
