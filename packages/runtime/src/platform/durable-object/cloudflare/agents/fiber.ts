import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import { drainAgentTurnWithBudget } from "../turn-drain";
import { cloudflareAgentsDrainOptionsForPayload } from "./drain-options";
import {
  type CloudflareAgentsFiberPayload,
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsFiberMetadata,
  cloudflareAgentsFiberName,
  parseCloudflareAgentsFiberPayload,
} from "./payload";
import {
  areCloudflareAgentsPayloadsEquivalent,
  type CloudflareAgentsPayloadTrustOptions,
  isCloudflareAgentsPayloadTrusted,
  isCloudflareAgentsRecoveryContextTrusted,
} from "./trust";
import type {
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsRetryFiber,
  CloudflareAgentsRetryReason,
  CloudflareAgentsStartFiberResult,
  CloudflareAgentsTurnDrainOptions,
} from "./types";
export interface StartCloudflareAgentsResumeFiberOptions {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retry?: CloudflareAgentsRetryFiber;
  readonly storage?: CloudflareDurableObjectStorage;
}
export interface RecoverCloudflareAgentsFiberOptions
  extends CloudflareAgentsPayloadTrustOptions {
  readonly ctx: CloudflareAgentsFiberRecoveryContext;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retry?: CloudflareAgentsRetryFiber;
  readonly storage?: CloudflareDurableObjectStorage;
}
export async function startCloudflareAgentsResumeFiber({
  cloudflareAgent,
  drain,
  payload,
  retry,
  resume,
  storage,
}: StartCloudflareAgentsResumeFiberOptions): Promise<CloudflareAgentsStartFiberResult> {
  const idempotencyKey = cloudflareAgentsFiberIdempotencyKey(payload);
  return await cloudflareAgent.startFiber(
    cloudflareAgentsFiberName(payload),
    async (ctx) => {
      ctx.stash(payload);
      const result = await resumeAndDrain({
        drain,
        payload,
        retry,
        resume,
        storage,
      });
      if (!(result.completed || result.rescheduled)) {
        throw new Error(`PSS Runtime fiber interrupted: ${result.reason}`);
      }
    },
    {
      idempotencyKey,
      metadata: cloudflareAgentsFiberMetadata(payload),
    }
  );
}
export async function recoverCloudflareAgentsFiber({
  ctx,
  drain,
  retry,
  resume,
  storage,
  ...trust
}: RecoverCloudflareAgentsFiberOptions): Promise<
  CloudflareAgentsFiberRecoveryResult | false
> {
  const snapshotPayload = parseCloudflareAgentsFiberPayload(ctx.snapshot);
  const metadataPayload = parseCloudflareAgentsFiberPayload(ctx.metadata);
  const payload = snapshotPayload ?? metadataPayload;
  if (!payload) {
    return false;
  }
  if (
    snapshotPayload &&
    metadataPayload &&
    !areCloudflareAgentsPayloadsEquivalent(snapshotPayload, metadataPayload)
  ) {
    return false;
  }
  if (!isCloudflareAgentsRecoveryContextTrusted(ctx, payload)) {
    return false;
  }
  if (!(await isCloudflareAgentsPayloadTrusted(payload, trust))) {
    return false;
  }
  const result = await resumeAndDrain({
    drain,
    payload,
    retry,
    resume,
    storage,
  });
  const snapshot = {
    ...cloudflareAgentsFiberMetadata(payload),
    resumed: result.resumed,
    rescheduled: result.rescheduled,
    retryReason: result.reason,
  };
  if (!(result.completed || result.rescheduled)) {
    return {
      reason: result.reason,
      snapshot,
      status: "interrupted",
    };
  }
  return {
    snapshot,
    status: "completed",
  };
}
type ResumeAndDrainResult =
  | {
      readonly completed: true;
      readonly reason?: never;
      readonly rescheduled: false;
      readonly resumed: true;
    }
  | {
      readonly completed: false;
      readonly reason: CloudflareAgentsRetryReason;
      readonly rescheduled: boolean;
      readonly resumed: boolean;
    };
async function resumeAndDrain({
  drain,
  payload,
  retry,
  resume,
  storage,
}: {
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly retry?: CloudflareAgentsRetryFiber;
  readonly resume: CloudflareAgentsResumeRun;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<ResumeAndDrainResult> {
  let resumed = false;
  try {
    const turn = await resume(payload);
    if (!turn) {
      return await retryInterrupted({
        payload,
        reason: "not-claimable",
        retry,
        resumed,
      });
    }
    resumed = true;
    const drainResult = await drainAgentTurnWithBudget(
      turn,
      await cloudflareAgentsDrainOptionsForPayload({ drain, payload, storage })
    );
    if (drainResult.stoppedReason) {
      return await retryInterrupted({
        payload,
        reason: drainResult.stoppedReason,
        retry,
        resumed,
      });
    }
    return {
      completed: true,
      rescheduled: false,
      resumed,
    };
  } catch (error) {
    const result = await retryInterrupted({
      payload,
      reason: "error",
      retry,
      resumed,
    });
    if (result.rescheduled) {
      return result;
    }
    throw error;
  }
}
async function retryInterrupted({
  payload,
  reason,
  retry,
  resumed,
}: {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly reason: CloudflareAgentsRetryReason;
  readonly retry?: CloudflareAgentsRetryFiber;
  readonly resumed: boolean;
}): Promise<ResumeAndDrainResult> {
  return {
    completed: false,
    reason,
    rescheduled: retry ? await retry(payload, reason) : false,
    resumed,
  };
}
