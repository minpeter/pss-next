import { describe, expect, it } from "vitest";
import { formatGrepMatches } from "./grep-format";

const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const BOLD_YELLOW = "\x1b[1m\x1b[33m";
const RESET = "\x1b[0m";

describe("formatGrepMatches", () => {
  it("colors the file path, line numbers, and the matched pattern", () => {
    const formatted = formatGrepMatches(
      [
        "src/cli.ts:204#ZW|  return await startTui({",
        "src/tui/app.ts:170#MN|export async function startTui(",
      ],
      "startTui("
    );

    expect(formatted).toBe(
      [
        `${CYAN}src/cli.ts${RESET}`,
        `  ${GRAY}204${RESET}  return await ${BOLD_YELLOW}startTui(${RESET}{`,
        "",
        `${CYAN}src/tui/app.ts${RESET}`,
        `  ${GRAY}170${RESET}  export async function ${BOLD_YELLOW}startTui(${RESET}`,
      ].join("\n")
    );
  });

  it("highlights every occurrence case-insensitively", () => {
    const formatted = formatGrepMatches(["a.ts:1#AB|Todo and todo"], "todo");

    expect(formatted).toBe(
      [
        `${CYAN}a.ts${RESET}`,
        `  ${GRAY}1${RESET}  ${BOLD_YELLOW}Todo${RESET} and ${BOLD_YELLOW}todo${RESET}`,
      ].join("\n")
    );
  });

  it("right-aligns line numbers within a file", () => {
    const formatted = formatGrepMatches(
      ["a.ts:7#AB|seven", "a.ts:1204#CD|twelve"],
      "zzz"
    );

    expect(formatted).toBe(
      [
        `${CYAN}a.ts${RESET}`,
        `  ${GRAY}   7${RESET}  seven`,
        `  ${GRAY}1204${RESET}  twelve`,
      ].join("\n")
    );
  });

  it("keeps lines that do not match the anchor format", () => {
    expect(formatGrepMatches(["binary file matched"], "x")).toBe(
      "binary file matched"
    );
  });

  it("returns an empty string without matches", () => {
    expect(formatGrepMatches([], "x")).toBe("");
  });
});
