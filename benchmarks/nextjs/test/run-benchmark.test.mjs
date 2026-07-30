import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const benchmarkDirectory = fileURLToPath(new URL("..", import.meta.url));

test("Given the AGENTS.md option, when dry-running the benchmark, then the manifest records it", () => {
  const result = spawnSync(
    process.execPath,
    ["src/run-benchmark.mjs", "--smoke", "--agents-md", "--dry-run"],
    { cwd: benchmarkDirectory, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agentsMd, true);
});
