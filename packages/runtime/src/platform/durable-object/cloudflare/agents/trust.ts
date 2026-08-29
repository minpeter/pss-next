import {
  type CloudflareAgentsFiberPayload,
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsFiberName,
} from "./payload";
import type {
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsStartFiberResult,
} from "./types";

type MaybePromise<T> = Promise<T> | T;

export interface CloudflareAgentsPrefixGuardOptions {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly prefix: string;
}

export type CloudflareAgentsPrefixGuard = (
  options: CloudflareAgentsPrefixGuardOptions
) => MaybePromise<boolean>;

export interface CloudflareAgentsPayloadTrustOptions {
  readonly allowedPrefixes?: readonly string[];
  readonly allowPrefix?: CloudflareAgentsPrefixGuard;
}

export async function isCloudflareAgentsPayloadTrusted(
  payload: CloudflareAgentsFiberPayload,
  { allowPrefix, allowedPrefixes }: CloudflareAgentsPayloadTrustOptions
): Promise<boolean> {
  if (allowedPrefixes === undefined && allowPrefix === undefined) {
    return false;
  }
  if (
    allowedPrefixes !== undefined &&
    !allowedPrefixes.includes(payload.prefix)
  ) {
    return false;
  }
  return (
    allowPrefix === undefined ||
    (await allowPrefix({ payload, prefix: payload.prefix })) === true
  );
}

export function isCloudflareAgentsRecoveryContextTrusted(
  ctx: CloudflareAgentsFiberRecoveryContext,
  payload: CloudflareAgentsFiberPayload
): boolean {
  if (ctx.name !== cloudflareAgentsFiberName(payload)) {
    return false;
  }
  if (ctx.idempotencyKey !== cloudflareAgentsFiberIdempotencyKey(payload)) {
    return false;
  }
  return true;
}

export function areCloudflareAgentsPayloadsEquivalent(
  left: CloudflareAgentsFiberPayload,
  right: CloudflareAgentsFiberPayload
): boolean {
  switch (left.kind) {
    case "run":
      return (
        right.kind === "run" &&
        left.prefix === right.prefix &&
        left.runId === right.runId
      );
    case "thread":
      return (
        right.kind === "thread" &&
        left.idempotencyKey === right.idempotencyKey &&
        left.notificationId === right.notificationId &&
        left.prefix === right.prefix &&
        left.runId === right.runId &&
        left.threadKey === right.threadKey
      );
    default:
      return false;
  }
}

export function rejectedCloudflareAgentsFiberResult(
  reason: string
): CloudflareAgentsStartFiberResult {
  return {
    accepted: false,
    createdAt: Date.now(),
    error: reason,
    fiberId: "pss-runtime:rejected",
    name: "pss-runtime:rejected",
    status: "aborted",
  };
}

export function cloudflareAgentsTrustFailureReason(): string {
  return "Cloudflare Agents rejected an untrusted PSS Runtime payload";
}
