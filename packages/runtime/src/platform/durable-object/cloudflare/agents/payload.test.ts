import { describe, expect, it } from "vitest";
import {
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
} from "./index";

describe("Cloudflare Agents fiber payloads", () => {
  it("length-prefixes idempotency key parts to prevent delimiter collisions", () => {
    const runA = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsRunPayload({
        prefix: "tenant-a",
        runId: "x:run:y",
      })
    );
    const runB = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsRunPayload({
        prefix: "tenant-a:run:x",
        runId: "y",
      })
    );
    const threadA = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsThreadPayload({
        idempotencyKey: "x:thread:y",
        prefix: "tenant-a",
        runId: "background:bg_a",
        threadKey: "thread-a",
      })
    );
    const threadB = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsThreadPayload({
        idempotencyKey: "y",
        prefix: "tenant-a:thread:x",
        runId: "background:bg_b",
        threadKey: "thread-b",
      })
    );

    expect(runA).toBe("pss-runtime:run:8:tenant-a:7:x:run:y");
    expect(runB).toBe("pss-runtime:run:14:tenant-a:run:x:1:y");
    expect(runA).not.toBe(runB);
    expect(threadA).toBe("pss-runtime:thread:8:tenant-a:10:x:thread:y");
    expect(threadB).toBe("pss-runtime:thread:17:tenant-a:thread:x:1:y");
    expect(threadA).not.toBe(threadB);
  });

  it("includes threadKey in fallback thread idempotency keys", () => {
    const threadA = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsThreadPayload({
        prefix: "tenant-a",
        runId: "background:bg_thread",
        threadKey: "thread-a",
      })
    );
    const threadB = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsThreadPayload({
        prefix: "tenant-a",
        runId: "background:bg_thread",
        threadKey: "thread-b",
      })
    );

    expect(threadA).toBe(
      "pss-runtime:thread:8:tenant-a:20:background:bg_thread:8:thread-a"
    );
    expect(threadB).toBe(
      "pss-runtime:thread:8:tenant-a:20:background:bg_thread:8:thread-b"
    );
    expect(threadA).not.toBe(threadB);
  });

  it("uses retry attempts to create fresh fiber idempotency keys", () => {
    const firstAttempt = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsRunPayload({
        prefix: "tenant-a",
        runId: "background:bg_retry",
      })
    );
    const secondAttempt = cloudflareAgentsFiberIdempotencyKey(
      cloudflareAgentsRunPayload({
        attempt: 1,
        prefix: "tenant-a",
        runId: "background:bg_retry",
      })
    );

    expect(firstAttempt).toBe(
      "pss-runtime:run:8:tenant-a:19:background:bg_retry"
    );
    expect(secondAttempt).toBe(
      "pss-runtime:run:8:tenant-a:19:background:bg_retry:attempt:1"
    );
    expect(firstAttempt).not.toBe(secondAttempt);
  });
});
