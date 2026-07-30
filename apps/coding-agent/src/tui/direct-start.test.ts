import { describe, expect, it } from "vitest";
import { parseDirectStartArguments } from "./direct-start";

describe("parseDirectStartArguments", () => {
  it("reads a session selector passed to the module directly", () => {
    expect(parseDirectStartArguments(["--session", "ac6bf001"])).toEqual({
      sessionKey: "ac6bf001",
    });
  });

  it("ignores a pnpm-style argument separator", () => {
    expect(parseDirectStartArguments(["--", "--session", "ac6bf001"])).toEqual({
      sessionKey: "ac6bf001",
    });
  });

  it("returns no selection without a session flag", () => {
    expect(parseDirectStartArguments([])).toEqual({});
  });
});
