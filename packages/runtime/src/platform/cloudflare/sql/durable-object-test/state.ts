export interface ThreadMetaRow {
  readonly applied_migrations: string | null;
  readonly message_count: number;
  readonly next_seq: number;
  readonly state_blob: string | null;
  readonly thread_key: string;
  readonly version: number | string;
}

export interface ThreadMessageRow {
  active: number;
  readonly message: string;
  readonly seq: number;
  readonly thread_key: string;
}

export interface ThreadMessageChunkRow {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly seq: number;
  readonly thread_key: string;
}

export interface ThreadInputRow {
  readonly admitted_at_ms: number;
  readonly admitted_seq: number;
  readonly claim_id: string | null;
  readonly created_at: number;
  readonly kind: string;
  readonly message_id: string;
  readonly placement: string | null;
  readonly prefix: string;
  readonly record: string;
  readonly status: string;
  readonly thread_key: string;
  readonly updated_at: number;
}

export interface ThreadCompactionRow {
  readonly end_seq_exclusive: number;
  readonly ordinal: number;
  readonly start_seq: number;
  readonly summary: string;
  readonly thread_key: string;
}

export interface RunRow {
  readonly checkpoint_version: number;
  readonly created_at: number;
  readonly dedupe_key: string | null;
  readonly parent_run_id: string | null;
  readonly prefix: string;
  readonly record: string;
  readonly root_run_id: string;
  readonly run_id: string;
  readonly status: string;
  readonly thread_key: string;
  readonly updated_at: number;
}

export interface NotificationRow {
  readonly created_at: number;
  readonly idempotency_key: string;
  readonly notification_id: string;
  readonly owner_namespace: string | null;
  readonly prefix: string;
  readonly record: string;
  readonly run_id: string;
  readonly status: string;
  readonly thread_key: string;
  readonly updated_at: number;
}

export interface PayloadChunkRow {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly owner_key: string;
  readonly payload_key: string;
  readonly scope: string;
}

export interface EventMetaRow {
  readonly next_seq: number;
  readonly run_key: string;
}

export interface EventRow {
  readonly event: string;
  readonly run_key: string;
  readonly seq: number;
}

export interface ThreadEventMetaRow {
  readonly next_seq: number;
  readonly thread_key: string;
}

export interface ThreadEventRow {
  readonly event: string;
  readonly seq: number;
  readonly thread_key: string;
}

export interface CheckpointRow {
  readonly checkpoint: string;
  readonly run_key: string;
  readonly version: number;
}

export interface ScheduledWorkRow {
  readonly created_at: number;
  readonly kind: string;
  readonly payload: string;
  readonly prefix: string;
  readonly run_id: string | null;
  readonly thread_key: string | null;
  readonly work_id: string;
}

export interface InMemoryDurableObjectSqlState {
  checkpoints: CheckpointRow[];
  eventMeta: Map<string, EventMetaRow>;
  events: EventRow[];
  notifications: NotificationRow[];
  payloadChunks: PayloadChunkRow[];
  scheduledWork: ScheduledWorkRow[];
  threadCompactions: ThreadCompactionRow[];
  threadEventMeta: Map<string, ThreadEventMetaRow>;
  threadEvents: ThreadEventRow[];
  threadInputs: ThreadInputRow[];
  threadMessageChunks: ThreadMessageChunkRow[];
  threadMessages: ThreadMessageRow[];
  threadMeta: Map<string, ThreadMetaRow>;
  threadMetaColumns: Set<string>;
  turns: RunRow[];
}

export function createInMemoryDurableObjectSqlState(): InMemoryDurableObjectSqlState {
  return {
    checkpoints: [],
    eventMeta: new Map(),
    events: [],
    notifications: [],
    payloadChunks: [],
    turns: [],
    scheduledWork: [],
    threadCompactions: [],
    threadEventMeta: new Map(),
    threadEvents: [],
    threadInputs: [],
    threadMessageChunks: [],
    threadMessages: [],
    threadMeta: new Map(),
    threadMetaColumns: new Set([
      "thread_key",
      "version",
      "message_count",
      "next_seq",
      "state_blob",
    ]),
  };
}

export function cloneInMemoryDurableObjectSqlState(
  state: InMemoryDurableObjectSqlState
): InMemoryDurableObjectSqlState {
  return {
    checkpoints: structuredClone(state.checkpoints),
    eventMeta: new Map(
      [...state.eventMeta].map(([key, value]) => [key, structuredClone(value)])
    ),
    events: structuredClone(state.events),
    notifications: structuredClone(state.notifications),
    payloadChunks: structuredClone(state.payloadChunks),
    turns: structuredClone(state.turns),
    scheduledWork: structuredClone(state.scheduledWork),
    threadCompactions: structuredClone(state.threadCompactions),
    threadEventMeta: new Map(
      [...state.threadEventMeta].map(([key, value]) => [
        key,
        structuredClone(value),
      ])
    ),
    threadEvents: structuredClone(state.threadEvents),
    threadInputs: structuredClone(state.threadInputs),
    threadMessageChunks: structuredClone(state.threadMessageChunks),
    threadMessages: structuredClone(state.threadMessages),
    threadMeta: new Map(
      [...state.threadMeta].map(([key, value]) => [key, structuredClone(value)])
    ),
    threadMetaColumns: new Set(state.threadMetaColumns),
  };
}
