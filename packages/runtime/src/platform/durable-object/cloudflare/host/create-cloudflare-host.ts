import type { AgentHost } from "../../../../execution";
import type { ThreadStore } from "../../../../thread/store/types";
import { createDurableObjectStorageHost as createCloudflareStorageHost } from "../../host/storage-host";
import { createCloudflareAgentsFiberRetryScheduler } from "../agents/retry-scheduler";
import {
  type CloudflareAgentsFiberSchedulerOptions,
  createCloudflareAgentsFiberScheduler,
} from "../agents/scheduler";
import type {
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsResumeRun,
  CloudflareAgentsTurnDrainOptions,
} from "../agents/types";

const defaultPrefix = "pss-runtime";

interface CloudflareHostBaseOptions<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retryMaxAttempts?: number;
  readonly retryMaxRunAfterMs?: number;
  readonly retryRunAfterMs?: number;
  readonly threadStore?: ThreadStore;
}

/**
 * Cloudflare Agents SDK host options.
 *
 * This is the supported product path: DO storage + fiber/schedule scheduler.
 * For store/alarm-only assembly without the Agents SDK, use
 * {@link createCloudflareStorageHost}.
 */
export type CloudflareHostOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareHostBaseOptions<TAgent> &
  Pick<CloudflareAgentsFiberSchedulerOptions<TAgent>, "delayedResumeCallback">;

/**
 * Create the supported Cloudflare `AgentHost` (Agents SDK fibers + schedule).
 *
 * Requires an Agents SDK agent instance, DO context, and resume callback.
 * Storage/attachment ports are DO-backed; scheduling uses fibers with optional
 * delayed `schedule()` and retry.
 */
export function createCloudflareHost<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>({
  cloudflareAgent,
  delayedResumeCallback,
  drain,
  durableObjectContext,
  maxPayloadBytes,
  prefix = defaultPrefix,
  retryMaxAttempts,
  retryMaxRunAfterMs,
  retryRunAfterMs,
  resume,
  threadStore,
}: CloudflareHostOptions<TAgent>): AgentHost {
  const retry = createCloudflareAgentsFiberRetryScheduler({
    cloudflareAgent,
    delayedResumeCallback,
    retryMaxAttempts,
    retryMaxRunAfterMs,
    retryRunAfterMs,
    storage: durableObjectContext.storage,
  });
  return createCloudflareStorageHost({
    maxPayloadBytes,
    prefix,
    scheduler: createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      prefix,
      retry,
      resume,
      storage: durableObjectContext.storage,
    }),
    storage: durableObjectContext.storage,
    threadStore,
  });
}
