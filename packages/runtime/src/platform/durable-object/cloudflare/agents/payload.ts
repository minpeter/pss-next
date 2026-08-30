import { scheduledWorkIdPart } from "../../../../execution/scheduled-work";
import { isRecord } from "../../../../internal/guards";
import {
  assertOptionalPayloadAttempt,
  assertOptionalPayloadString,
  assertPayloadString,
  hasRunPayloadStrings,
  hasThreadPayloadStrings,
  maxIdLength,
  maxPrefixLength,
} from "./payload-validation";

export const payloadVersion = 1;

export const defaultCloudflareAgentsDelayedResumeCallback =
  "resumePssRuntimeFiber";
export const pssRunFiberName = "pss-runtime:resume-run";
export const pssThreadFiberName = "pss-runtime:resume-thread";

export interface CloudflareAgentsRunFiberPayload {
  readonly attempt?: number;
  readonly kind: "run";
  readonly prefix: string;
  readonly runId: string;
  readonly version: 1;
}

export interface CloudflareAgentsThreadFiberPayload {
  readonly attempt?: number;
  readonly idempotencyKey?: string;
  readonly kind: "thread";
  readonly notificationId?: string;
  readonly prefix: string;
  readonly runId: string;
  readonly threadKey: string;
  readonly version: 1;
}

export type CloudflareAgentsFiberPayload =
  | CloudflareAgentsRunFiberPayload
  | CloudflareAgentsThreadFiberPayload;

export function snapshotCloudflareAgentsFiberPayload(
  payload: CloudflareAgentsFiberPayload
): CloudflareAgentsFiberPayload {
  switch (payload.kind) {
    case "run":
      return Object.freeze(
        cloudflareAgentsRunPayload({
          attempt: payload.attempt,
          prefix: payload.prefix,
          runId: payload.runId,
        })
      );
    case "thread":
      return Object.freeze(
        cloudflareAgentsThreadPayload({
          attempt: payload.attempt,
          idempotencyKey: payload.idempotencyKey,
          notificationId: payload.notificationId,
          prefix: payload.prefix,
          runId: payload.runId,
          threadKey: payload.threadKey,
        })
      );
    default:
      return assertNeverPayload(payload);
  }
}

export function cloudflareAgentsFiberRetryScope(
  payload: CloudflareAgentsFiberPayload
): string {
  return JSON.stringify(cloudflareAgentsFiberMetadata(payload));
}

export function cloudflareAgentsRunPayload({
  attempt,
  prefix,
  runId,
}: {
  readonly attempt?: number;
  readonly prefix: string;
  readonly runId: string;
}): CloudflareAgentsRunFiberPayload {
  assertOptionalPayloadAttempt("attempt", attempt);
  assertPayloadString("prefix", prefix, maxPrefixLength);
  assertPayloadString("runId", runId, maxIdLength);
  const payload: CloudflareAgentsRunFiberPayload = {
    kind: "run",
    prefix,
    runId,
    version: payloadVersion,
  };
  return attempt === undefined ? payload : { ...payload, attempt };
}

export function cloudflareAgentsThreadPayload({
  attempt,
  idempotencyKey,
  notificationId,
  prefix,
  runId,
  threadKey,
}: {
  readonly attempt?: number;
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly prefix: string;
  readonly runId: string;
  readonly threadKey: string;
}): CloudflareAgentsThreadFiberPayload {
  assertOptionalPayloadAttempt("attempt", attempt);
  assertOptionalPayloadString("idempotencyKey", idempotencyKey, maxIdLength);
  assertOptionalPayloadString("notificationId", notificationId, maxIdLength);
  assertPayloadString("prefix", prefix, maxPrefixLength);
  assertPayloadString("runId", runId, maxIdLength);
  assertPayloadString("threadKey", threadKey, maxIdLength);
  const payload: CloudflareAgentsThreadFiberPayload = {
    idempotencyKey,
    kind: "thread",
    notificationId,
    prefix,
    runId,
    threadKey,
    version: payloadVersion,
  };
  return attempt === undefined ? payload : { ...payload, attempt };
}

export function cloudflareAgentsFiberName(
  payload: CloudflareAgentsFiberPayload
): string {
  switch (payload.kind) {
    case "run":
      return pssRunFiberName;
    case "thread":
      return pssThreadFiberName;
    default:
      return assertNeverPayload(payload);
  }
}

export function cloudflareAgentsFiberIdempotencyKey(
  payload: CloudflareAgentsFiberPayload
): string {
  switch (payload.kind) {
    case "run":
      return keyWithAttempt(
        `pss-runtime:run:${scheduledWorkIdPart(
          payload.prefix
        )}:${scheduledWorkIdPart(payload.runId)}`,
        payload.attempt
      );
    case "thread":
      return keyWithAttempt(
        `pss-runtime:thread:${scheduledWorkIdPart(
          payload.prefix
        )}:${threadIdempotencyPart(payload)}`,
        payload.attempt
      );
    default:
      return assertNeverPayload(payload);
  }
}

export function cloudflareAgentsFiberMetadata(
  payload: CloudflareAgentsFiberPayload
): Record<string, unknown> {
  switch (payload.kind) {
    case "run":
      return withOptionalAttempt(
        {
          kind: payload.kind,
          prefix: payload.prefix,
          runId: payload.runId,
          version: payload.version,
        },
        payload.attempt
      );
    case "thread":
      return withOptionalAttempt(
        {
          idempotencyKey: payload.idempotencyKey,
          kind: payload.kind,
          notificationId: payload.notificationId,
          prefix: payload.prefix,
          runId: payload.runId,
          threadKey: payload.threadKey,
          version: payload.version,
        },
        payload.attempt
      );
    default:
      return assertNeverPayload(payload);
  }
}

function withOptionalAttempt(
  metadata: Record<string, unknown>,
  attempt: number | undefined
): Record<string, unknown> {
  return attempt === undefined
    ? metadata
    : {
        ...metadata,
        attempt,
      };
}

export function parseCloudflareAgentsFiberPayload(
  value: unknown
): CloudflareAgentsFiberPayload | null {
  if (!isRecord(value) || value.version !== payloadVersion) {
    return null;
  }
  if (value.kind === "run") {
    if (!hasRunPayloadStrings(value)) {
      return null;
    }
    return cloudflareAgentsRunPayload({
      attempt: value.attempt,
      prefix: value.prefix,
      runId: value.runId,
    });
  }
  if (value.kind === "thread") {
    if (!hasThreadPayloadStrings(value)) {
      return null;
    }
    return cloudflareAgentsThreadPayload({
      attempt: value.attempt,
      idempotencyKey: value.idempotencyKey,
      notificationId: value.notificationId,
      prefix: value.prefix,
      runId: value.runId,
      threadKey: value.threadKey,
    });
  }
  return null;
}

function threadIdempotencyPart(
  payload: CloudflareAgentsThreadFiberPayload
): string {
  if (payload.idempotencyKey !== undefined) {
    return scheduledWorkIdPart(payload.idempotencyKey);
  }
  return `${scheduledWorkIdPart(payload.runId)}:${scheduledWorkIdPart(
    payload.threadKey
  )}`;
}

function keyWithAttempt(key: string, attempt: number | undefined): string {
  return attempt === undefined ? key : `${key}:attempt:${attempt}`;
}

export function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}
