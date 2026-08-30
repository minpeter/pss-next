import { describe, expect, it } from "vitest";
import {
  createResumeRetryAttempt,
  leaseIdForResumeClaim,
  leaseIdForRetryAuthority,
} from "./retry-authority";

describe("resume retry authority", () => {
  it("consumes the public claim and private authority exactly once", () => {
    // Given: one paired attempt for an exact run and prefix.
    const attempt = createResumeRetryAttempt({
      prefix: "tenant-a",
      runId: "run-a",
    });

    // When: each half is read once.
    const claimedLeaseId = leaseIdForResumeClaim(attempt.claim, "run-a");
    const retryLeaseId = leaseIdForRetryAuthority(
      attempt.authority,
      "tenant-a",
      "run-a"
    );

    // Then: both halves prove the same lease once and retained tokens are inert.
    expect(claimedLeaseId).toBeTypeOf("string");
    expect(retryLeaseId).toBe(claimedLeaseId);
    expect(leaseIdForResumeClaim(attempt.claim, "run-a")).toBeUndefined();
    expect(
      leaseIdForRetryAuthority(attempt.authority, "tenant-a", "run-a")
    ).toBeUndefined();
  });

  it("consumes a wrong-run claim without revealing its lease", () => {
    // Given: one attempt presented to the wrong run first.
    const attempt = createResumeRetryAttempt({
      prefix: "tenant-a",
      runId: "run-a",
    });

    // When/Then: mismatch fails closed and cannot be retried on the right run.
    expect(leaseIdForResumeClaim(attempt.claim, "run-b")).toBeUndefined();
    expect(leaseIdForResumeClaim(attempt.claim, "run-a")).toBeUndefined();
  });
});
