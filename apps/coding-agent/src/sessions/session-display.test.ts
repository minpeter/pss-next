import { describe, expect, it } from "vitest";
import { sessionDisplayLabel, sessionUpdatedLabel } from "./session-display";

describe("sessionDisplayLabel", () => {
  it("labels unnamed sessions as untitled", () => {
    expect(
      sessionDisplayLabel({
        createdAt: "2026-07-29T00:00:00.000Z",
        cwd: "/work",
        key: "cwd:/work#abc12345",
        updatedAt: "2026-07-29T00:00:00.000Z",
      })
    ).toBe("untitled · #abc12345");
  });

  it("formats update time without seconds or milliseconds", () => {
    expect(
      sessionUpdatedLabel({
        createdAt: "2026-07-29T00:00:00.000Z",
        cwd: "/work",
        key: "cwd:/work#abc12345",
        updatedAt: "2026-07-29T18:05:14.540Z",
      })
    ).toBe("updated 2026-07-29 18:05");
  });
});
