import type { CloudflareAgentsFiberPayload } from "./payload";
import { defaultCloudflareAgentsDelayedResumeCallback } from "./payload";
import type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsDefaultResumeAgent,
} from "./types";

export type CloudflareAgentsDelayedSchedulePayload =
  CloudflareAgentsFiberPayload & {
    readonly scheduleDelaySeconds: number;
  };

export interface CloudflareAgentsDelayedCallbackOption<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly delayedResumeCallback?: CloudflareAgentsCallbackName<TAgent>;
}

export function cloudflareAgentsDelayedSchedulePayload(
  payload: CloudflareAgentsFiberPayload,
  delaySeconds: number
): CloudflareAgentsDelayedSchedulePayload {
  return {
    ...payload,
    scheduleDelaySeconds: delaySeconds,
  };
}

export function delaySeconds(runAfterMs: number): number {
  return Math.max(1, Math.ceil(runAfterMs / 1000));
}

export function delayedCallbackName<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>(
  options: CloudflareAgentsDelayedCallbackOption<TAgent>
): CloudflareAgentsCallbackName<TAgent> {
  if (options.delayedResumeCallback !== undefined) {
    return options.delayedResumeCallback;
  }
  return defaultCloudflareAgentsDelayedResumeCallback;
}
