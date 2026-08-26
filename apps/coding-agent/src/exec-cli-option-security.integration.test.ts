import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const INVALID_EXEC_OPTION_OUTPUT = "Invalid pss exec option.\n";
const codingAgentRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(codingAgentRoot, "../..");

describe("exec CLI option error output", () => {
  it("does not reflect a terminal-active unknown option", () => {
    // Given
    const hostileOption = "--unknown\u001b[2JEXEC_ARG_SECRET\u202e";

    // When
    const result = spawnSync(
      process.execPath,
      [resolve(codingAgentRoot, "bin/pss.js"), "exec", hostileOption, "value"],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 }
    );

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(INVALID_EXEC_OPTION_OUTPUT);
  }, 30_000);
});
