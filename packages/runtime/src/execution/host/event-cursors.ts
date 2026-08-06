import type {
  EventCursor,
  ThreadEventCursor,
  ThreadEventReadOptions,
} from "./types";

export interface NormalizedThreadEventReadOptions {
  readonly limit?: number;
  readonly start: number;
}

/** Reconstructs and validates a run event cursor from its wire-format offset. */
export function createEventCursor(offset: number): EventCursor {
  assertNonNegativeSafeInteger(offset, "run event cursor offset");
  return { offset } as EventCursor;
}

/** Reconstructs and validates a thread event cursor from its wire-format offset. */
export function createThreadEventCursor(offset: number): ThreadEventCursor {
  assertNonNegativeSafeInteger(offset, "thread event cursor offset");
  return { offset } as ThreadEventCursor;
}

export function normalizeEventCursor(cursor?: EventCursor): number {
  if (!cursor) {
    return 0;
  }
  assertNonNegativeSafeInteger(cursor.offset, "run event cursor offset");
  return cursor.offset;
}

export function normalizeThreadEventReadOptions(
  options: ThreadEventReadOptions = {}
): NormalizedThreadEventReadOptions {
  const limit = options.limit;
  if (limit !== undefined) {
    assertNonNegativeSafeInteger(limit, "thread event limit");
  }
  const start = options.after?.offset ?? 0;
  assertNonNegativeSafeInteger(start, "thread event cursor offset");
  return { limit, start };
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
