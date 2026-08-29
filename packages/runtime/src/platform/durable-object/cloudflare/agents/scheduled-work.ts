import {
  parseScheduledRunPayload,
  parseScheduledThreadPromptPayload,
} from "../../host/scheduled-work-codec";
import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import { insertScheduledWork } from "../../storage/sqlite/scheduled-work-table";
import {
  deleteScheduledWorkGroup,
  hasScheduledWorkGroup,
  type ScheduledWorkTarget,
} from "../../storage/sqlite/scheduled-work-table-groups";
import {
  assertNeverPayload,
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
} from "./payload";
import {
  alarmScheduledRunWorkId,
  alarmScheduledThreadPromptWorkId,
  scheduledRunPayloadWorkId,
  scheduledThreadPayloadWorkId,
} from "./scheduled-work-ids";
import {
  agentsRunKind,
  agentsThreadPromptKind,
  alarmRunKind,
  alarmThreadPromptKind,
} from "./scheduled-work-kinds";

type CloudflareAgentsRunFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "run" }
>;

export async function mirrorCloudflareAgentsScheduledPayload({
  payload,
  storage,
}: {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly runAfterMs: number;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<void> {
  if (storage === undefined) {
    return;
  }
  switch (payload.kind) {
    case "run":
      await insertScheduledWork(
        storage,
        payload.prefix,
        agentsRunKind,
        scheduledRunPayloadWorkId(payload),
        payload.runId,
        { runId: payload.runId }
      );
      return;
    case "thread":
      await insertScheduledWork(
        storage,
        payload.prefix,
        agentsThreadPromptKind,
        scheduledThreadPayloadWorkId(payload),
        threadPromptForPayload(payload),
        { runId: payload.runId, threadKey: payload.threadKey }
      );
      return;
    default:
      return assertNeverPayload(payload);
  }
}

export function claimCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  return deleteScheduledWorkGroup(
    storage,
    payload.prefix,
    scheduledPayloadTargets(payload)
  );
}

export async function removeCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<void> {
  await deleteScheduledWorkGroup(
    storage,
    payload.prefix,
    scheduledPayloadTargets(payload)
  );
}

export function hasCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  return Promise.resolve(
    hasScheduledWorkGroup(
      storage,
      payload.prefix,
      scheduledPayloadTargets(payload)
    )
  );
}

// Each payload maps to its agents-kind row plus the alarm scheduler's
// interop row; claiming or removing sweeps both in one transaction.
function scheduledPayloadTargets(
  payload: CloudflareAgentsFiberPayload
): ScheduledWorkTarget[] {
  switch (payload.kind) {
    case "run":
      return runPayloadTargets(payload);
    case "thread":
      return threadPayloadTargets(payload);
    default:
      return assertNeverPayload(payload);
  }
}

function runPayloadTargets(
  payload: CloudflareAgentsRunFiberPayload
): ScheduledWorkTarget[] {
  return [
    { kind: agentsRunKind, workId: scheduledRunPayloadWorkId(payload) },
    {
      kind: alarmRunKind,
      matchesPayload: (stored) =>
        parseScheduledRunPayload(stored) === payload.runId,
      workId: alarmScheduledRunWorkId(payload),
    },
  ];
}

function threadPayloadTargets(
  payload: CloudflareAgentsThreadFiberPayload
): ScheduledWorkTarget[] {
  return [
    {
      kind: agentsThreadPromptKind,
      workId: scheduledThreadPayloadWorkId(payload),
    },
    {
      kind: alarmThreadPromptKind,
      matchesPayload: (stored) =>
        matchesScheduledThreadPayload(stored, payload),
      workId: alarmScheduledThreadPromptWorkId(payload),
    },
  ];
}

function matchesScheduledThreadPayload(
  storedPayload: string,
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  const value = parseScheduledThreadPromptPayload(storedPayload);
  if (value === undefined) {
    return false;
  }
  return (
    value.threadKey === payload.threadKey &&
    value.idempotencyKey === payload.idempotencyKey &&
    value.runId === payload.runId
  );
}

function threadPromptForPayload(payload: CloudflareAgentsThreadFiberPayload): {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
} {
  return {
    idempotencyKey: payload.idempotencyKey,
    notificationId: payload.notificationId,
    runId: payload.runId,
    threadKey: payload.threadKey,
  };
}
