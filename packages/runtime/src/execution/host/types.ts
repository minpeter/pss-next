import type { RuntimeDiagnosticsSink } from "../../diagnostics";
import type { HostAttachmentStore } from "../../thread/input/attachments";
import type { AgentEvent, UserInput } from "../../thread/protocol/events";
import type { ThreadStore } from "../../thread/store/types";
import type { ResumeThreadOptions } from "./scheduler-options";
import type { ThreadInputInbox } from "./thread-input-types";

export type {
  AdmitReceipt,
  AdmitThreadInput,
  ClaimedThreadInput,
  ClaimThreadInputOptions,
  RecoverThreadInputClaimsOptions,
  RecoverThreadInputClaimsResult,
  ThreadInputBoundary,
  ThreadInputInbox,
  ThreadInputKind,
  ThreadInputPlacement,
  ThreadInputRecord,
  ThreadInputStatus,
} from "./thread-input-types";

/** Single host contract: persistence, scheduling, and optional attachments. */
export interface AgentHost {
  readonly attachmentStore?: HostAttachmentStore;
  readonly diagnostics: RuntimeDiagnosticsSink;
  readonly scheduler: HostScheduler;
  readonly store: HostStore;
}

export interface HostScheduler {
  enqueueRun(
    runId: string,
    options?: { readonly runAfterMs?: number }
  ): Promise<void>;
  resumeThread(threadKey: string, options: ResumeThreadOptions): Promise<void>;
}

export type TurnKind = "notification" | "tool-recovery" | "user-turn";

export type TurnStatus =
  | "cancelled"
  | "completed"
  | "error"
  | "leased"
  | "needs-recovery"
  | "queued"
  | "running"
  | "suspended";

export interface TurnLease {
  readonly attempt: number;
  readonly leaseId: string;
  readonly leaseUntilMs: number;
}

export interface TurnRecord {
  readonly checkpointVersion: number;
  readonly dedupeKey?: string;
  readonly kind: TurnKind;
  readonly lease?: TurnLease;
  readonly output?: unknown;
  readonly ownerNamespace?: string;
  readonly parentRunId?: string;
  readonly publicTaskId?: string;
  readonly rootRunId: string;
  readonly runId: string;
  readonly status: TurnStatus;
  readonly threadKey: string;
}

export type ClaimTurnResult =
  | {
      readonly lease: TurnLease;
      readonly ok: true;
      readonly record: TurnRecord;
    }
  | {
      readonly ok: false;
      readonly reason: "leased" | "not-claimable" | "not-found";
    };

export type CreateTurnResult =
  | { readonly ok: true; readonly record: TurnRecord }
  | {
      readonly ok: false;
      readonly reason: "duplicate";
      readonly record: TurnRecord;
    };

export interface ClaimTurnOptions {
  readonly attempt: number;
  readonly leaseId: string;
  readonly leaseMs: number;
  readonly nowMs: number;
}

export type CheckpointPhase =
  | "after-model"
  | "after-notification"
  | "after-tool"
  | "before-child-run"
  | "before-model"
  | "before-notification"
  | "before-tool"
  | "child-linked"
  | "suspended";

export interface Checkpoint {
  readonly checkpointId: string;
  readonly childRunId?: string;
  readonly pendingToolCall?: unknown;
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly runtimeState: unknown;
  readonly threadSnapshot: unknown;
  readonly version: number;
}

export type CheckpointWriteResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly currentVersion: number;
      readonly ok: false;
      readonly reason: "stale-version";
    };

/**
 * Cursor scoped to a single run event log.
 *
 * Raw `{ offset }` wire values remain structurally assignable for transport
 * compatibility. Use `createEventCursor` at deserialization boundaries; the
 * resulting typed cursor cannot be passed to a thread event API.
 */
export interface EventCursor {
  /** @internal Compile-time scope marker; omitted from the wire format. */
  readonly __pssEventCursorScope?: "run-event";
  readonly offset: number;
}

export interface StoredAgentEvent {
  readonly cursor: EventCursor;
  readonly event: AgentEvent;
  readonly runId: string;
}

/**
 * Cursor scoped to a thread event log.
 *
 * Raw `{ offset }` wire values remain structurally assignable for transport
 * compatibility. Use `createThreadEventCursor` at deserialization boundaries;
 * the resulting typed cursor cannot be passed to a run event API.
 */
export interface ThreadEventCursor {
  /** @internal Compile-time scope marker; omitted from the wire format. */
  readonly __pssEventCursorScope?: "thread-event";
  readonly offset: number;
}

export interface StoredThreadEvent {
  readonly cursor: ThreadEventCursor;
  readonly event: AgentEvent;
  readonly threadKey: string;
}

export type NotificationStatus = "acked" | "cancelled" | "pending";

export interface NotificationRecord {
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly notificationId: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly overlays?: readonly UserInput[];
  readonly ownerNamespace?: string;
  readonly runId: string;
  readonly status: NotificationStatus;
  readonly threadKey: string;
}

export type NotificationWriteResult =
  | { readonly ok: true }
  | {
      readonly existingNotificationId: string;
      readonly ok: false;
      readonly reason: "duplicate";
    };

export type NotificationClaimResult =
  | { readonly ok: true; readonly record: NotificationRecord }
  | {
      readonly ok: false;
      readonly reason: "already-claimed" | "not-found";
      readonly record?: NotificationRecord;
    };

export interface TurnStore {
  claim(runId: string, options: ClaimTurnOptions): Promise<ClaimTurnResult>;
  create(record: TurnRecord): Promise<CreateTurnResult>;
  get(runId: string): Promise<TurnRecord | null>;
  getByDedupeKey(dedupeKey: string): Promise<TurnRecord | null>;
  listByParentRunId(parentRunId: string): Promise<readonly TurnRecord[]>;
  update(record: TurnRecord): Promise<TurnRecord>;
}

export interface CheckpointStore {
  append(
    checkpoint: Checkpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult>;
  latest(runId: string): Promise<Checkpoint | null>;
}

export interface EventStore {
  append(runId: string, event: AgentEvent): Promise<EventCursor>;
  read(runId: string, cursor?: EventCursor): AsyncIterable<StoredAgentEvent>;
}

export interface ThreadEventReadOptions {
  readonly after?: ThreadEventCursor;
  readonly limit?: number;
}

export interface ThreadEventLog {
  append(threadKey: string, event: AgentEvent): Promise<ThreadEventCursor>;
  read(
    threadKey: string,
    options?: ThreadEventReadOptions
  ): AsyncIterable<StoredThreadEvent>;
}

export interface NotificationInbox {
  claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult>;
  enqueue(record: NotificationRecord): Promise<NotificationWriteResult>;
  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null>;
  releaseByIdempotencyKey(idempotencyKey: string): Promise<void>;
}

export interface HostStorePorts {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly notifications: NotificationInbox;
  readonly threadEvents?: ThreadEventLog;
  readonly threads: ThreadStore;
  readonly turns: TurnStore;
}

export interface HostStoreTransaction extends HostStorePorts {
  deleteThread?(threadKey: string): Promise<void>;
}

export interface HostStore extends HostStorePorts {
  /** Atomically removes all runtime-owned data for a thread, when supported. */
  deleteThread?(threadKey: string): Promise<void>;
  transaction<T>(fn: (tx: HostStoreTransaction) => Promise<T>): Promise<T>;
}
