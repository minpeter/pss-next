import {
  scheduledWorkIdPart,
  threadPromptScheduledWorkId,
} from "../../../../execution/scheduled-work";
import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsThreadFiberPayload,
} from "./payload";

type CloudflareAgentsRunFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "run" }
>;

export function scheduledRunPayloadWorkId(
  payload: CloudflareAgentsRunFiberPayload
): string {
  return [
    payload.runId,
    payload.attempt === undefined ? "" : String(payload.attempt),
  ]
    .map(scheduledWorkIdPart)
    .join("|");
}

export function scheduledThreadPayloadWorkId(
  payload: CloudflareAgentsThreadFiberPayload
): string {
  return [
    payload.threadKey,
    payload.idempotencyKey ?? "",
    payload.runId,
    payload.notificationId ?? "",
    payload.attempt === undefined ? "" : String(payload.attempt),
  ]
    .map(scheduledWorkIdPart)
    .join("|");
}

// The alarm scheduler stores runs under the plain run id. Any Agents resume
// attempt for that run may consume the alarm row, so the id ignores attempt.
export function alarmScheduledRunWorkId(
  payload: CloudflareAgentsRunFiberPayload
): string {
  return payload.runId;
}

export function alarmScheduledThreadPromptWorkId(
  payload: CloudflareAgentsThreadFiberPayload
): string {
  return threadPromptScheduledWorkId({
    idempotencyKey: payload.idempotencyKey,
    runId: payload.runId,
    threadKey: payload.threadKey,
  });
}
