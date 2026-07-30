import { describe, expect, it } from "vitest";
import { normalizedLines, strippedLines } from "./utils";

const ESC = "\x1b";

describe("strippedLines", () => {
  it("removes SGR color sequences instead of escaping them", () => {
    const input = `${ESC}[32mPASS${ESC}[0m ${ESC}[31mFAIL${ESC}[0m`;

    expect(normalizedLines(input)).toEqual(["^[[32mPASS^[[0m ^[[31mFAIL^[[0m"]);
    expect(strippedLines(input)).toEqual(["PASS FAIL"]);
  });

  it("removes cursor movement and screen clears", () => {
    expect(strippedLines(`a${ESC}[2Jb${ESC}[10Ac`)).toEqual(["abc"]);
  });

  it("removes OSC hyperlink wrappers but keeps the label", () => {
    expect(
      strippedLines(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`)
    ).toEqual(["link"]);
  });

  it("keeps remaining control characters visible", () => {
    expect(strippedLines("a\x00b")).toEqual(["a^@b"]);
  });

  it("splits on newlines after normalizing CRLF", () => {
    expect(strippedLines("a\r\nb")).toEqual(["a", "b"]);
  });
});
