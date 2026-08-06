import { agentNamespace } from "../../agent/identity/namespace";
import {
  cleanupStagedRuntimeAttachments,
  type RuntimeAttachmentReference,
  stageAgentEventsAttachments,
  stageUserInputAttachments,
} from "../../thread/input/attachments";
import type { AgentEvent, UserInput } from "../../thread/protocol/events";
import type { AgentHost, NotificationRecord, TurnRecord } from "../host/types";

export interface DispatchAgentNotificationInput {
  readonly host: AgentHost;
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly namespace: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly overlays?: readonly UserInput[];
  readonly threadKey: string;
}

export interface DispatchedAgentNotification {
  readonly deduplicated: boolean;
  readonly idempotencyKey: string;
  readonly notificationId: string;
  readonly runId: string;
}

interface SchedulableAgentNotification extends DispatchedAgentNotification {
  readonly shouldSchedule: boolean;
  readonly storageIdempotencyKey: string;
  readonly threadKey: string;
}

class DuplicateNotificationError extends Error {
  constructor() {
    super("duplicate_notification");
    this.name = "DuplicateNotificationError";
  }
}

export async function dispatchAgentNotification(
  input: DispatchAgentNotificationInput
): Promise<DispatchedAgentNotification> {
  const ownerNamespace = agentNamespace(input.namespace);
  const storageIdempotencyKey = scopedNotificationIdempotencyKey({
    idempotencyKey: input.idempotencyKey,
    ownerNamespace,
    threadKey: input.threadKey,
  });
  const existing = await queuedNotificationRun({
    host: input.host,
    idempotencyKey: input.idempotencyKey,
    ownerNamespace,
    threadKey: input.threadKey,
    storageIdempotencyKey,
  });
  if (existing) {
    await scheduleAgentNotification(input.host, existing);
    return dispatchedAgentNotification(existing);
  }

  const runId = crypto.randomUUID();
  const notificationId = crypto.randomUUID();
  const stagedRefs: RuntimeAttachmentReference[] = [];
  let keepStagedAttachments = false;
  try {
    const stagedInput = await stageUserInputAttachments(
      input.input,
      input.host.attachmentStore,
      { stagedRefs }
    );
    const stagedOverlays = await stageUserInputs(
      input.overlays,
      input.host.attachmentStore,
      { stagedRefs }
    );
    const stagedObserverEvents = await stageAgentEventsAttachments(
      input.observerEvents ?? [],
      input.host.attachmentStore,
      { stagedRefs }
    );
    const runRecord = {
      checkpointVersion: 0,
      dedupeKey: storageIdempotencyKey,
      kind: "notification",
      ownerNamespace,
      rootRunId: runId,
      runId,
      threadKey: input.threadKey,
      status: "queued",
    } satisfies TurnRecord;
    const notificationRecord = {
      idempotencyKey: storageIdempotencyKey,
      input: stagedInput,
      notificationId,
      observerEvents: stagedObserverEvents,
      overlays: stagedOverlays,
      ownerNamespace,
      runId,
      threadKey: input.threadKey,
      status: "pending",
    } satisfies NotificationRecord;

    try {
      await input.host.store.transaction(async (tx) => {
        const runCreate = await tx.turns.create(runRecord);
        if (!runCreate.ok) {
          throw new DuplicateNotificationError();
        }
        const writeResult = await tx.notifications.enqueue(notificationRecord);
        if (!writeResult.ok) {
          throw new DuplicateNotificationError();
        }
      });
    } catch (error) {
      if (error instanceof DuplicateNotificationError) {
        const deduplicated = await queuedNotificationRun({
          host: input.host,
          idempotencyKey: input.idempotencyKey,
          ownerNamespace,
          threadKey: input.threadKey,
          storageIdempotencyKey,
        });
        if (deduplicated) {
          await scheduleAgentNotification(input.host, deduplicated);
          return dispatchedAgentNotification(deduplicated);
        }
      }
      throw error;
    }

    keepStagedAttachments = true;
    const created = {
      deduplicated: false,
      idempotencyKey: input.idempotencyKey,
      notificationId,
      runId,
      shouldSchedule: true,
      threadKey: input.threadKey,
      storageIdempotencyKey,
    } satisfies SchedulableAgentNotification;
    await scheduleAgentNotification(input.host, created);
    return dispatchedAgentNotification(created);
  } finally {
    if (!keepStagedAttachments) {
      await cleanupStagedRuntimeAttachments(
        input.host.attachmentStore,
        stagedRefs
      );
    }
  }
}

async function stageUserInputs(
  inputs: readonly UserInput[] | undefined,
  attachmentStore: Parameters<typeof stageUserInputAttachments>[1],
  options: Parameters<typeof stageUserInputAttachments>[2]
): Promise<readonly UserInput[] | undefined> {
  if (!inputs) {
    return;
  }

  const staged: UserInput[] = [];
  for (const input of inputs) {
    staged.push(
      await stageUserInputAttachments(input, attachmentStore, options)
    );
  }
  return staged;
}

async function queuedNotificationRun({
  host,
  idempotencyKey,
  ownerNamespace,
  threadKey,
  storageIdempotencyKey,
}: {
  readonly host: AgentHost;
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
  readonly threadKey: string;
  readonly storageIdempotencyKey: string;
}): Promise<SchedulableAgentNotification | null> {
  const existingRun = await host.store.turns.getByDedupeKey(
    storageIdempotencyKey
  );
  if (
    existingRun?.kind !== "notification" ||
    existingRun.ownerNamespace !== ownerNamespace ||
    existingRun.threadKey !== threadKey
  ) {
    return null;
  }

  const existingNotification =
    await host.store.notifications.getByIdempotencyKey(storageIdempotencyKey);
  if (!existingNotification) {
    throw new Error(
      `Notification dispatch integrity error: run ${existingRun.runId} has no notification record.`
    );
  }
  if (
    existingNotification.idempotencyKey !== storageIdempotencyKey ||
    existingNotification.runId !== existingRun.runId ||
    existingNotification.ownerNamespace !== ownerNamespace ||
    existingNotification.threadKey !== threadKey ||
    !existingNotification.notificationId
  ) {
    throw new Error(
      `Notification dispatch integrity error: notification record for run ${existingRun.runId} does not match the deduplicated run.`
    );
  }

  return {
    deduplicated: true,
    idempotencyKey,
    notificationId: existingNotification.notificationId,
    runId: existingRun.runId,
    shouldSchedule: !isTerminalTurnStatus(existingRun.status),
    threadKey: existingRun.threadKey,
    storageIdempotencyKey,
  };
}

function scheduleAgentNotification(
  host: AgentHost,
  notification: SchedulableAgentNotification
): Promise<void> {
  if (!notification.shouldSchedule) {
    return Promise.resolve();
  }

  return host.scheduler.resumeThread(notification.threadKey, {
    idempotencyKey: notification.storageIdempotencyKey,
    notificationId: notification.notificationId,
    runId: notification.runId,
  });
}

function isTerminalTurnStatus(status: TurnRecord["status"]): boolean {
  return status === "cancelled" || status === "completed" || status === "error";
}

function dispatchedAgentNotification(
  notification: SchedulableAgentNotification
): DispatchedAgentNotification {
  return {
    deduplicated: notification.deduplicated,
    idempotencyKey: notification.idempotencyKey,
    notificationId: notification.notificationId,
    runId: notification.runId,
  };
}

function scopedNotificationIdempotencyKey({
  idempotencyKey,
  ownerNamespace,
  threadKey,
}: {
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
  readonly threadKey: string;
}): string {
  return [ownerNamespace, threadKey, idempotencyKey]
    .map((part) => encodeURIComponent(part))
    .join(":");
}
