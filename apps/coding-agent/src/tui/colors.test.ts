import { describe, expect, it } from "vitest";
import { colors } from "./colors";

describe("colors", () => {
  it("keeps regular and bright ANSI colors distinct", () => {
    expect(colors.blue).toBe("\x1b[34m");
    expect(colors.brightBlue).toBe("\x1b[94m");
    expect(colors.green).toBe("\x1b[32m");
    expect(colors.brightGreen).toBe("\x1b[92m");
  });
});
