import { describe, expect, it } from "vitest";
import {
  type CloudflareAgentsFiberPayload,
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsFiberMetadata,
  recoverCloudflareAgentsFiber,
} from "./index";

describe("Cloudflare Agents fiber recovery", () => {
  it("recovers PSS fibers from Cloudflare Agents fiber metadata", async () => {
    const payload = runPayload("tenant-a", "background:bg_recovered");
    const resumed: string[] = [];

    const result = await recoverCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      ctx: {
        createdAt: Date.now(),
        id: "fiber-1",
        idempotencyKey: cloudflareAgentsFiberIdempotencyKey(payload),
        metadata: cloudflareAgentsFiberMetadata(payload),
        name: "pss-runtime:resume-run",
        recoveryReason: "interrupted",
        snapshot: null,
      },
      resume: (payload) => {
        resumed.push(`${payload.kind}:${payload.runId}`);
        return Promise.resolve(null);
      },
    });

    expect(resumed).toEqual(["run:background:bg_recovered"]);
    expect(result).toEqual({
      snapshot: {
        kind: "run",
        prefix: "tenant-a",
        resumed: false,
        rescheduled: false,
        runId: "background:bg_recovered",
        retryReason: "not-claimable",
        version: 1,
      },
      reason: "not-claimable",
      status: "interrupted",
    });
  });

  it("marks rescheduled recovery work as completed", async () => {
    const payload = runPayload("tenant-a", "background:bg_rescheduled");
    const retried: string[] = [];

    const result = await recoverCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      ctx: {
        createdAt: Date.now(),
        id: "fiber-1",
        idempotencyKey: cloudflareAgentsFiberIdempotencyKey(payload),
        metadata: cloudflareAgentsFiberMetadata(payload),
        name: "pss-runtime:resume-run",
        recoveryReason: "interrupted",
        snapshot: null,
      },
      resume: () => Promise.resolve(null),
      retry: (payload, reason) => {
        retried.push(`${payload.kind}:${payload.runId}:${reason}`);
        return Promise.resolve(true);
      },
    });

    expect(retried).toEqual(["run:background:bg_rescheduled:not-claimable"]);
    expect(result).toEqual({
      snapshot: {
        kind: "run",
        prefix: "tenant-a",
        resumed: false,
        rescheduled: true,
        runId: "background:bg_rescheduled",
        retryReason: "not-claimable",
        version: 1,
      },
      status: "completed",
    });
  });

  it("ignores non-PSS Cloudflare Agents fiber recovery hooks", async () => {
    await expect(
      recoverCloudflareAgentsFiber({
        ctx: {
          createdAt: Date.now(),
          id: "fiber-1",
          name: "other-fiber",
          recoveryReason: "interrupted",
          snapshot: { kind: "other" },
        },
        resume: () => Promise.resolve(null),
      })
    ).resolves.toBe(false);
  });

  it("ignores valid PSS recovery payloads on the wrong fiber identity", async () => {
    const payload = runPayload("tenant-a", "background:bg_wrong_fiber");
    const resumed: string[] = [];

    await expect(
      recoverCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        ctx: {
          createdAt: Date.now(),
          id: "fiber-1",
          idempotencyKey: cloudflareAgentsFiberIdempotencyKey(payload),
          name: "other-fiber",
          recoveryReason: "interrupted",
          snapshot: payload,
        },
        resume: (payload) => {
          resumed.push(payload.runId);
          return Promise.resolve(null);
        },
      })
    ).resolves.toBe(false);
    expect(resumed).toEqual([]);
  });

  it("ignores recovery payloads with mismatched idempotency keys", async () => {
    const payload = runPayload("tenant-a", "background:bg_mismatch");
    const resumed: string[] = [];

    await expect(
      recoverCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        ctx: {
          createdAt: Date.now(),
          id: "fiber-1",
          idempotencyKey: "pss-runtime:run:8:tenant-a:5:other",
          name: "pss-runtime:resume-run",
          recoveryReason: "interrupted",
          snapshot: payload,
        },
        resume: (payload) => {
          resumed.push(payload.runId);
          return Promise.resolve(null);
        },
      })
    ).resolves.toBe(false);
    expect(resumed).toEqual([]);
  });

  it("ignores recovery payloads without idempotency keys", async () => {
    const payload = runPayload("tenant-a", "background:bg_missing_key");
    const resumed: string[] = [];

    await expect(
      recoverCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        ctx: {
          createdAt: Date.now(),
          id: "fiber-1",
          name: "pss-runtime:resume-run",
          recoveryReason: "interrupted",
          snapshot: payload,
        },
        resume: (payload) => {
          resumed.push(payload.runId);
          return Promise.resolve(null);
        },
      })
    ).resolves.toBe(false);
    expect(resumed).toEqual([]);
  });

  it("ignores recovery payloads with untrusted prefixes", async () => {
    const payload = runPayload("tenant-b", "background:bg_foreign");
    const resumed: string[] = [];

    await expect(
      recoverCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        ctx: {
          createdAt: Date.now(),
          id: "fiber-1",
          idempotencyKey: cloudflareAgentsFiberIdempotencyKey(payload),
          name: "pss-runtime:resume-run",
          recoveryReason: "interrupted",
          snapshot: payload,
        },
        resume: (payload) => {
          resumed.push(payload.runId);
          return Promise.resolve(null);
        },
      })
    ).resolves.toBe(false);
    expect(resumed).toEqual([]);
  });

  it("ignores malformed recovery payload strings", async () => {
    const resumed: string[] = [];

    await expect(
      recoverCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        ctx: {
          createdAt: Date.now(),
          id: "fiber-1",
          name: "pss-runtime:resume-run",
          recoveryReason: "interrupted",
          snapshot: {
            kind: "run",
            prefix: "",
            runId: "background:bg_malformed",
            version: 1,
          },
        },
        resume: (payload) => {
          resumed.push(payload.runId);
          return Promise.resolve(null);
        },
      })
    ).resolves.toBe(false);
    expect(resumed).toEqual([]);
  });
});

function runPayload(
  prefix: string,
  runId: string
): CloudflareAgentsFiberPayload {
  return {
    kind: "run",
    prefix,
    runId,
    version: 1,
  };
}
