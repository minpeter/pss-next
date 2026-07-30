import { describe, expect, it } from "vitest";
import {
  sanitizeTerminalText,
  sanitizeTerminalTextPreservingColor,
} from "./terminal-safety";

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

const ESC = "\x1b";

describe("sanitizeTerminalTextPreservingColor", () => {
  it("keeps SGR color sequences intact", () => {
    const input = `${ESC}[32mpassed${ESC}[0m`;

    expect(sanitizeTerminalTextPreservingColor(input)).toBe(input);
  });

  it("keeps truecolor and multi-parameter SGR", () => {
    const input = `${ESC}[38;2;255;126;23mrolldown${ESC}[39m`;

    expect(sanitizeTerminalTextPreservingColor(input)).toBe(input);
  });

  it("neutralizes cursor movement and screen clears", () => {
    expect(sanitizeTerminalTextPreservingColor(`a${ESC}[2Jb${ESC}[10Ac`)).toBe(
      "a^[[2Jb^[[10Ac"
    );
  });

  it("neutralizes OSC hyperlink and title sequences", () => {
    expect(
      sanitizeTerminalTextPreservingColor(`${ESC}]8;;http://x${ESC}\\link`)
    ).toBe("^[]8;;http://x^[\\link");
  });

  it("still neutralizes other control characters", () => {
    expect(sanitizeTerminalTextPreservingColor("a\x07b\x00c")).toBe("a^Gb^@c");
  });

  it("normalizes CRLF like the strict sanitizer", () => {
    expect(sanitizeTerminalTextPreservingColor("a\r\nb")).toBe("a\nb");
  });
});
