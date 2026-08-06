import { describe, expect, expectTypeOf, it } from "vitest";
import { createEventCursor, createThreadEventCursor } from "./event-cursors";
import type { EventCursor, ThreadEventCursor } from "./types";

describe("event cursors", () => {
  it("keeps run and thread cursors statically scoped", () => {
    const runCursor = createEventCursor(1);
    const threadCursor = createThreadEventCursor(1);

    expectTypeOf(runCursor).toMatchTypeOf<EventCursor>();
    expectTypeOf(runCursor).not.toMatchTypeOf<ThreadEventCursor>();
    expectTypeOf(threadCursor).toMatchTypeOf<ThreadEventCursor>();
    expectTypeOf(threadCursor).not.toMatchTypeOf<EventCursor>();
    expect(runCursor).toEqual({ offset: 1 });
    expect(threadCursor).toEqual({ offset: 1 });
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid offsets %s", (offset) => {
    expect(() => createEventCursor(offset)).toThrow(RangeError);
    expect(() => createThreadEventCursor(offset)).toThrow(RangeError);
  });
});
