import { createDurableObjectStorageHost as createCloudflareStorageHost } from "../../host/storage-host";
import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import type { CloudflareAgentTurnDrainOptions } from "../turn-drain";
import {
  assertNeverPayload,
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsRunFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
} from "./payload";
import type {
  CloudflareAgentsRunContext,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

export async function cloudflareAgentsDrainOptionsForPayload({
  drain,
  payload,
  storage,
}: {
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<CloudflareAgentTurnDrainOptions | undefined> {
  if (drain === undefined) {
    return;
  }
  const onEvent = drain.onEvent;
  if (onEvent === undefined) {
    return {
      deadlineMs: drain.deadlineMs,
      maxEvents: drain.maxEvents,
    };
  }
  const context = await contextForPayload(payload, storage);
  return {
    deadlineMs: drain.deadlineMs,
    maxEvents: drain.maxEvents,
    onEvent: async (event) => {
      await onEvent(context, event);
    },
  };
}

async function contextForPayload(
  payload: CloudflareAgentsFiberPayload,
  storage: CloudflareDurableObjectStorage | undefined
): Promise<CloudflareAgentsRunContext> {
  switch (payload.kind) {
    case "run":
      return await scheduledRunPayloadContext(payload, storage);
    case "thread":
      return threadPromptPayloadContext(payload);
    default:
      return assertNeverPayload(payload);
  }
}

async function scheduledRunPayloadContext(
  payload: CloudflareAgentsRunFiberPayload,
  storage: CloudflareDurableObjectStorage | undefined
): Promise<CloudflareAgentsRunContext> {
  const run =
    storage === undefined
      ? undefined
      : await createCloudflareStorageHost({
          prefix: payload.prefix,
          storage,
        }).store.turns.get(payload.runId);
  const context = {
    kind: "run",
    prefix: payload.prefix,
    runId: payload.runId,
    source: "scheduled-run",
  } satisfies CloudflareAgentsRunContext;
  return run?.threadKey === undefined
    ? context
    : { ...context, threadKey: run.threadKey };
}

function threadPromptPayloadContext(
  payload: CloudflareAgentsThreadFiberPayload
): CloudflareAgentsRunContext {
  return {
    idempotencyKey: payload.idempotencyKey,
    kind: "thread",
    notificationId: payload.notificationId,
    prefix: payload.prefix,
    runId: payload.runId,
    source: "thread-prompt",
    threadKey: payload.threadKey,
  };
}
