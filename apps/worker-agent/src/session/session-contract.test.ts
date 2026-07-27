import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseThreadEventCursor,
  type SerializedThreadEventCursor,
  serializeThreadEventCursor,
  type ThreadEventCursor,
} from "./session-contract";

describe("session event cursor contract", () => {
  it("round-trips the transport cursor through its serialized form", () => {
    const cursor = { offset: 42 } satisfies ThreadEventCursor;
    const serialized = serializeThreadEventCursor(cursor);

    expect(serialized).toBe("42");
    expect(parseThreadEventCursor(serialized)).toEqual(cursor);
    expectTypeOf(serialized).toEqualTypeOf<SerializedThreadEventCursor>();
  });

  it.each(["", "-1", "1.5", "01", "offset:1", "not-a-cursor"])(
    "rejects malformed serialized cursor %j",
    (serialized) => {
      expect(() => parseThreadEventCursor(serialized)).toThrow(
        "invalid thread event cursor"
      );
    }
  );
});
