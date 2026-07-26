import { noopRuntimeDiagnostics } from "../../../diagnostics";
import type { AgentHost, HostScheduler } from "../../../execution";
import type { ThreadStore } from "../../../index";
import { CloudflareAttachmentStore } from "../storage/attachment-store";
import {
  InMemoryCloudflareDurableObjectStorage as BaseInMemoryCloudflareDurableObjectStorage,
  type CloudflareDurableObjectStorage as DurableObjectStoragePort,
} from "../storage/durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "../storage/execution/store";
import type { CloudflareScheduledThreadPrompt } from "./scheduled-work-codec";
import {
  ackScheduledRun,
  ackScheduledThreadPrompt,
  appendScheduledRun,
  appendScheduledThreadPrompt,
  claimScheduledRun,
  claimScheduledThreadPrompt,
  listScheduledRuns,
  listScheduledThreadPrompts,
} from "./scheduled-work-queue";

const defaultPrefix = "pss-runtime";

export type { CloudflareScheduledThreadPrompt } from "./scheduled-work-codec";

export type CloudflareDurableObjectStorage = DurableObjectStoragePort;

export type CloudflareDurableObjectId = unknown;

export interface CloudflareDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareDurableObjectNamespace<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> {
  get(id: CloudflareDurableObjectId): Stub;
  idFromName(name: string): CloudflareDurableObjectId;
}

export interface CloudflareDurableObjectState {
  readonly storage: CloudflareDurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export class InMemoryCloudflareDurableObjectStorage extends BaseInMemoryCloudflareDurableObjectStorage {}

export interface CloudflareStorageHostOptions {
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly scheduler?: HostScheduler;
  readonly storage: CloudflareDurableObjectStorage;
  readonly threadStore?: ThreadStore;
}

/**
 * Low-level DO storage host (store + attachments + optional scheduler).
 *
 * Defaults to a queue-only scheduler (no DO alarm wake). Product agent
 * deployments should use {@link createCloudflareHost} (Agents SDK fibers).
 */
export function createCloudflareStorageHost({
  maxPayloadBytes,
  prefix = defaultPrefix,
  threadStore,
  storage,
  scheduler = createCloudflareScheduledWorkScheduler({ prefix, storage }),
}: CloudflareStorageHostOptions): AgentHost {
  const store = new DurableObjectExecutionStore({
    maxPayloadBytes,
    prefix,
    storage,
  });
  return {
    attachmentStore: new CloudflareAttachmentStore({ prefix, storage }),
    diagnostics: noopRuntimeDiagnostics,
    scheduler,
    store: threadStore ? executionStoreWithThreads(store, threadStore) : store,
  };
}

/**
 * Queue-only HostScheduler backed by DO storage scheduled-work rows.
 * Does not arm Durable Object alarms — wake/resume is Agents SDK owned.
 */
export function createCloudflareScheduledWorkScheduler({
  prefix = defaultPrefix,
  storage,
}: {
  readonly prefix?: string;
  readonly storage: CloudflareDurableObjectStorage;
}): HostScheduler {
  return {
    enqueueRun: async (runId) => {
      await appendScheduledRun(storage, prefix, runId);
    },
    resumeThread: async (threadKey, options) => {
      await appendScheduledThreadPrompt(storage, prefix, {
        idempotencyKey: options?.idempotencyKey,
        notificationId: options?.notificationId,
        runId: options?.runId,
        threadKey,
      });
    },
  };
}

export async function listScheduledCloudflareRuns(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly string[]> {
  return await listScheduledRuns(storage, options, defaultPrefix);
}

export async function ackScheduledCloudflareRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await ackScheduledRun(storage, runId, options, defaultPrefix);
}

export async function claimScheduledCloudflareRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<boolean> {
  return await claimScheduledRun(storage, runId, options, defaultPrefix);
}

export async function listScheduledCloudflareThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  return await listScheduledThreadPrompts(storage, options, defaultPrefix);
}

export async function ackScheduledCloudflareThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await ackScheduledThreadPrompt(storage, prompt, options, defaultPrefix);
}

export async function claimScheduledCloudflareThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<boolean> {
  return await claimScheduledThreadPrompt(
    storage,
    prompt,
    options,
    defaultPrefix
  );
}

function executionStoreWithThreads(
  store: AgentHost["store"],
  threads: ThreadStore
): AgentHost["store"] {
  return {
    events: store.events,
    inputs: store.inputs,
    notifications: store.notifications,
    checkpoints: store.checkpoints,
    threads,
    turns: store.turns,
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          events: tx.events,
          inputs: tx.inputs,
          notifications: tx.notifications,
          checkpoints: tx.checkpoints,
          threads,
          turns: tx.turns,
        })
      ),
  };
}
