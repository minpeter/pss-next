import { noopRuntimeDiagnostics } from "../../../diagnostics";
import type { AgentHost, HostScheduler } from "../../../execution";
import type { ThreadStore } from "../../../thread/store/types";
import type {
  SqlStorageCursorLike as SqlStorageCursorLikeType,
  SqlStorage as SqlStorageType,
} from "../sql/ports/storage-port";
import { DurableObjectAttachmentStore as AttachmentStoreImplementation } from "../storage/attachment-store";
import {
  type DurableObjectStorage as DurableObjectStorageType,
  type DurableObjectTransactionStorage as DurableObjectTransactionStorageType,
  InMemoryDurableObjectStorage as InMemoryDurableObjectStorageImplementation,
} from "../storage/durable-object/durable-object-storage";
import { DurableObjectExecutionStore as ExecutionStoreImplementation } from "../storage/execution/store";
import {
  type StorageCompactionMode as CompactionMode,
  DEFAULT_STORAGE_COMPACTION_MODE as defaultStorageCompactionMode,
  DEFAULT_STORAGE_EXTERNALIZATION_MODE as defaultStorageExternalizationMode,
  DEFAULT_STORAGE_PAYLOAD_MAX_BYTES as defaultStoragePayloadMaxBytes,
  DEFAULT_STORAGE_PAYLOAD_OVERFLOW_STRATEGY as defaultStoragePayloadOverflowStrategy,
  type StorageExternalizationMode as ExternalizationMode,
  type StoragePayloadBudgetOptions as PayloadBudgetOptions,
  type StoragePayloadKind as PayloadKind,
  type StoragePayloadOverflowStrategy as PayloadOverflowStrategy,
  type StoragePayloadPolicyOptions as PayloadPolicyOptions,
  StoragePayloadSerializationError as PayloadSerializationError,
  StoragePayloadTooLargeError as PayloadTooLargeError,
  type ResolvedStoragePayloadPolicy as ResolvedPayloadPolicy,
  resolveStoragePayloadPolicy as resolvePayloadPolicy,
} from "../storage/payload-guard";
import { DurableObjectSqliteCheckpointStore as CheckpointStoreImplementation } from "../storage/sqlite/checkpoint-store";
import { DurableObjectSqliteEventStore as EventStoreImplementation } from "../storage/sqlite/event-store";
import { DurableObjectSqliteThreadStore as ThreadStoreImplementation } from "../storage/sqlite/thread-store";
import type { DurableObjectScheduledThreadPrompt as ScheduledThreadPrompt } from "./scheduled-work-codec";
import {
  ackScheduledRun,
  ackScheduledThreadPrompt,
  appendScheduledRun,
  appendScheduledThreadPrompt,
  listScheduledRuns,
  listScheduledThreadPrompts,
} from "./scheduled-work-queue";

const defaultPrefix = "pss-runtime";

export type DurableObjectScheduledThreadPrompt = ScheduledThreadPrompt;

export const DurableObjectAttachmentStore = AttachmentStoreImplementation;
export type DurableObjectAttachmentStore = InstanceType<
  typeof AttachmentStoreImplementation
>;
export const DurableObjectExecutionStore = ExecutionStoreImplementation;
export type DurableObjectExecutionStore = InstanceType<
  typeof ExecutionStoreImplementation
>;
export const DurableObjectSqliteCheckpointStore = CheckpointStoreImplementation;
export const DurableObjectSqliteEventStore = EventStoreImplementation;
export const DurableObjectSqliteThreadStore = ThreadStoreImplementation;
export type DurableObjectStorage = DurableObjectStorageType;
export type DurableObjectTransactionStorage =
  DurableObjectTransactionStorageType;
export const InMemoryDurableObjectStorage =
  InMemoryDurableObjectStorageImplementation;
export type InMemoryDurableObjectStorage = InstanceType<
  typeof InMemoryDurableObjectStorageImplementation
>;
export type SqlStorage = SqlStorageType;
export type SqlStorageCursorLike<T> = SqlStorageCursorLikeType<T>;
export type ResolvedStoragePayloadPolicy = ResolvedPayloadPolicy;
export type StorageCompactionMode = CompactionMode;
export type StorageExternalizationMode = ExternalizationMode;
export type StoragePayloadBudgetOptions = PayloadBudgetOptions;
export type StoragePayloadKind = PayloadKind;
export type StoragePayloadOverflowStrategy = PayloadOverflowStrategy;
export type StoragePayloadPolicyOptions = PayloadPolicyOptions;
export const DEFAULT_STORAGE_COMPACTION_MODE = defaultStorageCompactionMode;
export const DEFAULT_STORAGE_EXTERNALIZATION_MODE =
  defaultStorageExternalizationMode;
export const DEFAULT_STORAGE_PAYLOAD_MAX_BYTES = defaultStoragePayloadMaxBytes;
export const DEFAULT_STORAGE_PAYLOAD_OVERFLOW_STRATEGY =
  defaultStoragePayloadOverflowStrategy;
export const resolveStoragePayloadPolicy = resolvePayloadPolicy;
export const StoragePayloadSerializationError = PayloadSerializationError;
export const StoragePayloadTooLargeError = PayloadTooLargeError;

export interface DurableObjectStorageHostOptions {
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly scheduler?: HostScheduler;
  readonly storage: DurableObjectStorage;
  readonly threadStore?: ThreadStore;
}

/**
 * Low-level DO storage host (store + attachments + optional scheduler).
 *
 * Defaults to a queue-only scheduler (no DO alarm wake). Product agent
 * deployments should provide the scheduler that owns wake and resume behavior.
 */
export function createDurableObjectStorageHost({
  maxPayloadBytes,
  prefix = defaultPrefix,
  threadStore,
  storage,
  scheduler = createDurableObjectScheduledWorkScheduler({ prefix, storage }),
}: DurableObjectStorageHostOptions): AgentHost {
  const store = new ExecutionStoreImplementation({
    maxPayloadBytes,
    prefix,
    storage,
  });
  return {
    attachmentStore: new AttachmentStoreImplementation({
      prefix,
      storage,
    }),
    diagnostics: noopRuntimeDiagnostics,
    scheduler,
    store: threadStore ? executionStoreWithThreads(store, threadStore) : store,
  };
}

/**
 * Queue-only HostScheduler backed by DO storage scheduled-work rows.
 * Does not arm Durable Object alarms — wake/resume is Agents SDK owned.
 */
export function createDurableObjectScheduledWorkScheduler({
  prefix = defaultPrefix,
  storage,
}: {
  readonly prefix?: string;
  readonly storage: DurableObjectStorage;
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

export async function listScheduledDurableObjectRuns(
  storage: DurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly string[]> {
  return await listScheduledRuns(storage, options, defaultPrefix);
}

export async function ackScheduledDurableObjectRun(
  storage: DurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await ackScheduledRun(storage, runId, options, defaultPrefix);
}

export async function listScheduledDurableObjectThreadPrompts(
  storage: DurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly DurableObjectScheduledThreadPrompt[]> {
  return await listScheduledThreadPrompts(storage, options, defaultPrefix);
}

export async function ackScheduledDurableObjectThreadPrompt(
  storage: DurableObjectStorage,
  prompt: DurableObjectScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await ackScheduledThreadPrompt(storage, prompt, options, defaultPrefix);
}

function executionStoreWithThreads(
  store: AgentHost["store"],
  threads: ThreadStore
): AgentHost["store"] {
  return {
    events: store.events,
    inputs: store.inputs,
    leaseFencedCheckpoints: store.leaseFencedCheckpoints,
    notifications: store.notifications,
    checkpoints: store.checkpoints,
    threads,
    turns: store.turns,
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          events: tx.events,
          inputs: tx.inputs,
          leaseFencedCheckpoints: tx.leaseFencedCheckpoints,
          notifications: tx.notifications,
          checkpoints: tx.checkpoints,
          threads,
          turns: tx.turns,
        })
      ),
  };
}
