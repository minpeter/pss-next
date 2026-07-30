import { describe, expect, it } from "vitest";
import { formatGrepMatches } from "./grep-format";

describe("formatGrepMatches", () => {
  it("groups matches under each file and drops anchor hashes", () => {
    const formatted = formatGrepMatches([
      "src/cli.ts:204#ZW|  return await startTui({",
      "src/tui/app.ts:170#MN|export async function startTui(",
      "src/tui/app.ts:860#MS|  const exitCode = await startTui(",
    ]);

    expect(formatted).toBe(
      [
        "src/cli.ts",
        "  204  return await startTui({",
        "",
        "src/tui/app.ts",
        "  170  export async function startTui(",
        "  860  const exitCode = await startTui(",
      ].join("\n")
    );
  });

  it("right-aligns line numbers within a file", () => {
    const formatted = formatGrepMatches([
      "a.ts:7#AB|seven",
      "a.ts:1204#CD|twelve-oh-four",
    ]);

    expect(formatted).toBe(
      ["a.ts", "     7  seven", "  1204  twelve-oh-four"].join("\n")
    );
  });

  it("keeps lines that do not match the anchor format", () => {
    expect(formatGrepMatches(["binary file matched"])).toBe(
      "binary file matched"
    );
  });

  it("returns an empty string without matches", () => {
    expect(formatGrepMatches([])).toBe("");
  });
});
