import type { StartCloudflareAgentsResumeFiberOptions } from "./fiber";
import { startCloudflareAgentsResumeFiber } from "./fiber";
import { parseCloudflareAgentsFiberPayload } from "./payload";
import {
  claimCloudflareAgentsScheduledPayload,
  mirrorCloudflareAgentsScheduledPayload,
} from "./scheduled-work";
import {
  type CloudflareAgentsPayloadTrustOptions,
  cloudflareAgentsTrustFailureReason,
  isCloudflareAgentsPayloadTrusted,
  rejectedCloudflareAgentsFiberResult,
} from "./trust";
import type { CloudflareAgentsStartFiberResult } from "./types";

export interface ResumeScheduledCloudflareAgentsFiberOptions
  extends Omit<StartCloudflareAgentsResumeFiberOptions, "payload">,
    CloudflareAgentsPayloadTrustOptions {
  readonly payload: unknown;
}

export async function resumeScheduledCloudflareAgentsFiber(
  options: ResumeScheduledCloudflareAgentsFiberOptions
): Promise<CloudflareAgentsStartFiberResult> {
  const payload = parseCloudflareAgentsFiberPayload(options.payload);
  const storage = options.storage;
  if (!payload) {
    return rejectedCloudflareAgentsFiberResult(
      cloudflareAgentsTrustFailureReason()
    );
  }
  if (!(await isCloudflareAgentsPayloadTrusted(payload, options))) {
    return rejectedCloudflareAgentsFiberResult(
      cloudflareAgentsTrustFailureReason()
    );
  }
  if (storage === undefined) {
    return await startCloudflareAgentsResumeFiber({
      ...options,
      payload,
    });
  }
  if (!(await claimCloudflareAgentsScheduledPayload(storage, payload))) {
    return rejectedCloudflareAgentsFiberResult(
      "Cloudflare Agents scheduled payload was not pending in the PSS Runtime queue"
    );
  }
  try {
    return await startCloudflareAgentsResumeFiber({
      ...options,
      payload,
    });
  } catch (error) {
    await mirrorCloudflareAgentsScheduledPayload({
      payload,
      runAfterMs: 0,
      storage,
    });
    throw error;
  }
}
