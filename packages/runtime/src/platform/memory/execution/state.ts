import type {
  Checkpoint,
  NotificationRecord,
  StoredAgentEvent,
  StoredThreadEvent,
  ThreadInputRecord,
  TurnRecord,
} from "../../../execution/host/types";
import type { StoredThread } from "../../../thread/store/types";
import {
  cloneScheduledState,
  createEmptyScheduledState,
  type MemoryScheduledState,
} from "./scheduled-state";

export interface ExecutionState {
  readonly checkpoints: Map<string, Checkpoint[]>;
  readonly events: Map<string, StoredAgentEvent[]>;
  readonly inputsByThread: Map<string, ThreadInputRecord[]>;
  readonly notificationsByKey: Map<string, NotificationRecord>;
  readonly scheduledWork: MemoryScheduledState;
  readonly threadEvents: Map<string, StoredThreadEvent[]>;
  readonly threads: Map<string, StoredThread>;
  readonly threadVersions: Map<string, number>;
  readonly turns: Map<string, TurnRecord>;
}

export function createEmptyState(): ExecutionState {
  return {
    checkpoints: new Map(),
    events: new Map(),
    inputsByThread: new Map(),
    notificationsByKey: new Map(),
    scheduledWork: createEmptyScheduledState(),
    threadEvents: new Map(),
    turns: new Map(),
    threadVersions: new Map(),
    threads: new Map(),
  };
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    checkpoints: cloneCheckpointMap(state.checkpoints),
    events: cloneEventMap(state.events),
    inputsByThread: cloneInputMap(state.inputsByThread),
    notificationsByKey: cloneRecordMap(state.notificationsByKey),
    scheduledWork: cloneScheduledState(state.scheduledWork),
    threadEvents: cloneThreadEventMap(state.threadEvents),
    turns: cloneRecordMap(state.turns),
    threadVersions: cloneRecordMap(state.threadVersions),
    threads: cloneRecordMap(state.threads),
  };
}

function cloneInputMap(
  map: ReadonlyMap<string, readonly ThreadInputRecord[]>
): Map<string, ThreadInputRecord[]> {
  return new Map(
    [...map.entries()].map(([key, value]) => [
      key,
      value.map((record) => structuredClone(record)),
    ])
  );
}

function cloneCheckpointMap(
  map: ReadonlyMap<string, readonly Checkpoint[]>
): Map<string, Checkpoint[]> {
  return new Map(
    [...map.entries()].map(([key, value]) => [
      key,
      value.map((checkpoint) => structuredClone(checkpoint)),
    ])
  );
}

function cloneEventMap(
  map: ReadonlyMap<string, readonly StoredAgentEvent[]>
): Map<string, StoredAgentEvent[]> {
  return new Map(
    [...map.entries()].map(([key, value]) => [
      key,
      value.map((event) => structuredClone(event)),
    ])
  );
}

function cloneThreadEventMap(
  map: ReadonlyMap<string, readonly StoredThreadEvent[]>
): Map<string, StoredThreadEvent[]> {
  return new Map(
    [...map.entries()].map(([key, value]) => [
      key,
      value.map((event) => structuredClone(event)),
    ])
  );
}

function cloneRecordMap<T>(map: ReadonlyMap<string, T>): Map<string, T> {
  return new Map(
    [...map.entries()].map(([key, value]) => [key, structuredClone(value)])
  );
}
