import { agentNamespace } from "../../../../agent/identity/namespace";
import {
  type DispatchedAgentNotification,
  dispatchAgentNotification,
} from "../../../../execution/dispatch/notification-dispatch";
import type { AgentHost } from "../../../../execution/host/types";
import type { AgentEvent, UserInput } from "../../../../thread/protocol/events";
import { createDurableObjectStorageHost as createCloudflareStorageHost } from "../../host/storage-host";
import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";

interface DispatchCloudflareAgentNotificationBase {
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly namespace: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly overlays?: readonly UserInput[];
  readonly threadKey: string;
}

export type DispatchCloudflareAgentNotificationInput =
  | (DispatchCloudflareAgentNotificationBase & {
      readonly host: AgentHost;
      readonly prefix?: never;
      readonly storage?: never;
    })
  | (DispatchCloudflareAgentNotificationBase & {
      readonly host?: never;
      readonly prefix?: string;
      readonly storage: CloudflareDurableObjectStorage;
    });

export function dispatchCloudflareAgentNotification({
  host,
  idempotencyKey,
  input,
  namespace,
  observerEvents,
  overlays,
  prefix,
  threadKey,
  storage,
}: DispatchCloudflareAgentNotificationInput): Promise<DispatchedAgentNotification> {
  return dispatchAgentNotification({
    host:
      host ??
      createCloudflareStorageHost({
        prefix,
        storage,
      }),
    idempotencyKey,
    input,
    namespace,
    observerEvents,
    overlays,
    threadKey,
  });
}

export interface SourceCloudflareAgentNotificationIdempotencyKeyInput {
  readonly idempotencyKey: string | undefined;
  readonly namespace?: string;
  readonly threadKey: string;
}

interface ScopedCloudflareAgentNotificationIdempotencyKey {
  readonly ownerNamespace: string;
  readonly sourceIdempotencyKey: string;
  readonly threadKey: string;
}

export function sourceCloudflareAgentNotificationIdempotencyKey(
  input: SourceCloudflareAgentNotificationIdempotencyKeyInput
): string | undefined {
  if (!input.idempotencyKey) {
    return;
  }

  const scoped = decodeScopedCloudflareAgentNotificationIdempotencyKey(
    input.idempotencyKey
  );
  if (!scoped) {
    return input.idempotencyKey;
  }

  if (scoped.threadKey !== input.threadKey) {
    return input.idempotencyKey;
  }

  if (input.namespace) {
    return scoped.ownerNamespace === agentNamespace(input.namespace)
      ? scoped.sourceIdempotencyKey
      : input.idempotencyKey;
  }

  return scoped.ownerNamespace.startsWith("agent:")
    ? scoped.sourceIdempotencyKey
    : input.idempotencyKey;
}

function decodeScopedCloudflareAgentNotificationIdempotencyKey(
  idempotencyKey: string
): ScopedCloudflareAgentNotificationIdempotencyKey | undefined {
  const parts = idempotencyKey.split(":");
  if (parts.length !== 3) {
    return;
  }

  try {
    const ownerNamespace = decodeURIComponent(parts[0] ?? "");
    const threadKey = decodeURIComponent(parts[1] ?? "");
    const sourceIdempotencyKey = decodeURIComponent(parts[2] ?? "");
    if (!ownerNamespace) {
      return;
    }
    if (!threadKey) {
      return;
    }
    if (!sourceIdempotencyKey) {
      return;
    }
    return { ownerNamespace, threadKey, sourceIdempotencyKey };
  } catch (error) {
    if (error instanceof URIError) {
      return;
    }
    throw error;
  }
}
