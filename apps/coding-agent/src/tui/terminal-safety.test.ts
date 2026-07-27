import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./terminal-safety";

describe("sanitizeTerminalText", () => {
  it("renders terminal controls visibly while preserving layout whitespace", () => {
    const input = "a\tb\r\nc\u001b]52;c;cHduZWQ=\u0007";

    expect(sanitizeTerminalText(input)).toBe("a\tb\nc^[]52;c;cHduZWQ=^G");
  });

  it("renders eight-bit C1 terminal controls visibly", () => {
    expect(sanitizeTerminalText("a\u009b31mb\u009d0;title\u009c")).toBe(
      "a\\u009b31mb\\u009d0;title\\u009c"
    );
  });
});
