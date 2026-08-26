import { describe, expect, it } from "vitest";
import { parseRuntimeBlockRepetitions } from "./runtime-block-time-options";

describe("runtime block-time CLI options", () => {
  it.each(["0", "-1", "1.5", "9007199254740992", "101"])(
    "rejects invalid repetition count %s",
    (value) => {
      expect(() => parseRuntimeBlockRepetitions(value)).toThrow(TypeError);
    }
  );

  it.each(["1", "100"])("accepts bounded repetition count %s", (value) => {
    expect(parseRuntimeBlockRepetitions(value)).toBe(Number(value));
  });
});
