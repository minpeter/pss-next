import { leaseIdForRetryAuthority } from "../../../../agent/resume/retry-authority";
import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import { prepareScheduledNotificationRetry } from "../host/scheduled-work-retry";
import { scheduleCloudflareAgentsDelayedPayload } from "./delayed-schedule";
import {
  assertNeverPayload,
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
} from "./payload";
import {
  type CloudflareAgentsDelayedCallbackOption,
  delayedCallbackName,
} from "./schedule-payload";
import type {
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsRetryFiber,
} from "./types";

const defaultRetryRunAfterMs = 1000;
const defaultRetryMaxAttempts = 5;
const defaultRetryMaxRunAfterMs = 60_000;

export type CloudflareAgentsFiberRetrySchedulerOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = {
  readonly cloudflareAgent: TAgent;
  readonly retryMaxAttempts?: number;
  readonly retryMaxRunAfterMs?: number;
  readonly retryRunAfterMs?: number;
  readonly storage: CloudflareDurableObjectStorage;
} & CloudflareAgentsDelayedCallbackOption<TAgent>;

export function createCloudflareAgentsFiberRetryScheduler<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>(
  options: CloudflareAgentsFiberRetrySchedulerOptions<TAgent>
): CloudflareAgentsRetryFiber {
  const callback = delayedCallbackName(options);
  const {
    cloudflareAgent,
    retryMaxAttempts = defaultRetryMaxAttempts,
    retryMaxRunAfterMs = defaultRetryMaxRunAfterMs,
    retryRunAfterMs = defaultRetryRunAfterMs,
    storage,
  } = options;
  return async (payload, reason, authority) => {
    const leaseId = leaseIdForRetryAuthority(
      authority,
      payload.prefix,
      payload.runId
    );
    if (leaseId === undefined) {
      return false;
    }
    const retryPayload = nextRetryPayload(payload);
    if ((retryPayload.attempt ?? 0) > Math.max(0, retryMaxAttempts)) {
      return false;
    }
    const runAfterMs = retryDelayMs({
      attempt: retryPayload.attempt,
      maxRunAfterMs: retryMaxRunAfterMs,
      runAfterMs: retryRunAfterMs,
    });
    return await prepareScheduledNotificationRetry({
      allowNonNotification: reason !== "not-claimable",
      leaseId,
      prefix: payload.prefix,
      runId: payload.runId,
      schedule: (transactionStorage) =>
        scheduleCloudflareAgentsDelayedPayload({
          callback,
          cloudflareAgent,
          payload: retryPayload,
          runAfterMs,
          storage: transactionStorage,
        }),
      storage,
    });
  };
}

function retryDelayMs({
  attempt,
  maxRunAfterMs,
  runAfterMs,
}: {
  readonly attempt: number | undefined;
  readonly maxRunAfterMs: number;
  readonly runAfterMs: number;
}): number {
  const exponent = Math.max(0, (attempt ?? 1) - 1);
  return Math.min(
    Math.max(1, maxRunAfterMs),
    Math.max(1, runAfterMs) * 2 ** exponent
  );
}

function nextRetryPayload(
  payload: CloudflareAgentsFiberPayload
): CloudflareAgentsFiberPayload {
  const attempt = (payload.attempt ?? 0) + 1;
  switch (payload.kind) {
    case "run":
      return cloudflareAgentsRunPayload({
        attempt,
        prefix: payload.prefix,
        runId: payload.runId,
      });
    case "thread":
      return nextThreadRetryPayload(payload, attempt);
    default:
      return assertNeverPayload(payload);
  }
}

function nextThreadRetryPayload(
  payload: CloudflareAgentsThreadFiberPayload,
  attempt: number
): CloudflareAgentsThreadFiberPayload {
  return cloudflareAgentsThreadPayload({
    attempt,
    idempotencyKey: payload.idempotencyKey,
    notificationId: payload.notificationId,
    prefix: payload.prefix,
    runId: payload.runId,
    threadKey: payload.threadKey,
  });
}
