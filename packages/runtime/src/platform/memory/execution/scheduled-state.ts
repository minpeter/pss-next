import type { ScheduledThreadPrompt } from "../../../execution/scheduled-work";

export interface StoredMemoryScheduledWork<T> {
  readonly createdAt: number;
  readonly dueAt: number;
  readonly payload: T;
  readonly workId: string;
}

export interface MemoryScheduledState {
  readonly runs: Map<string, StoredMemoryScheduledWork<string>>;
  readonly threadPrompts: Map<
    string,
    StoredMemoryScheduledWork<ScheduledThreadPrompt>
  >;
}

export function createEmptyScheduledState(): MemoryScheduledState {
  return {
    runs: new Map(),
    threadPrompts: new Map(),
  };
}

export function cloneScheduledState(
  state: MemoryScheduledState
): MemoryScheduledState {
  return {
    runs: cloneScheduledWork(state.runs),
    threadPrompts: cloneScheduledWork(state.threadPrompts),
  };
}

function cloneScheduledWork<T>(
  work: ReadonlyMap<string, StoredMemoryScheduledWork<T>>
): Map<string, StoredMemoryScheduledWork<T>> {
  return new Map(
    [...work.entries()].map(([key, value]) => [key, structuredClone(value)])
  );
}
