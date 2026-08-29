import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import type { CloudflareAgentsFiberPayload } from "./payload";
import {
  cloudflareAgentsDelayedSchedulePayload,
  delaySeconds,
} from "./schedule-payload";
import {
  mirrorCloudflareAgentsScheduledPayload,
  removeCloudflareAgentsScheduledPayload,
} from "./scheduled-work";
import type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsDefaultResumeAgent,
} from "./types";

export async function scheduleCloudflareAgentsDelayedPayload<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>({
  callback,
  cloudflareAgent,
  payload,
  runAfterMs,
  storage,
}: {
  readonly callback: CloudflareAgentsCallbackName<TAgent>;
  readonly cloudflareAgent: TAgent;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly runAfterMs: number;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<void> {
  const scheduleDelaySeconds = delaySeconds(runAfterMs);
  await mirrorCloudflareAgentsScheduledPayload({
    payload,
    runAfterMs,
    storage,
  });
  try {
    await cloudflareAgent.schedule(
      scheduleDelaySeconds,
      callback,
      cloudflareAgentsDelayedSchedulePayload(payload, scheduleDelaySeconds),
      { idempotent: true }
    );
  } catch (error) {
    if (storage !== undefined) {
      await removeCloudflareAgentsScheduledPayload(storage, payload);
    }
    throw error;
  }
}
