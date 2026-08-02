import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENTS_MD_CONTENT,
  agentsMdFiles,
  resolveExperimentName,
} from "../src/agents-md.mjs";

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

test("Given the variant, when sandbox files are built, then AGENTS.md is written", () => {
  const files = agentsMdFiles(true);

  assert.deepEqual(Object.keys(files), ["AGENTS.md"]);
  // The upstream experiments point the agent at the installed canary docs.
  assert.match(files["AGENTS.md"], /node_modules\/next\/dist\/docs\//u);
  assert.match(AGENTS_MD_CONTENT, /^<!-- BEGIN:nextjs-agent-rules -->/u);
});

test("Given the baseline, when sandbox files are built, then no AGENTS.md is written", () => {
  assert.deepEqual(agentsMdFiles(false), {});
});

test("Given the variant, when the experiment name resolves, then it is kept apart from the baseline", () => {
  const baseline = resolveExperimentName({
    agentsMd: false,
    model: "m",
    profile: "official",
  });
  const variant = resolveExperimentName({
    agentsMd: true,
    model: "m",
    profile: "official",
  });

  assert.equal(baseline, "pss-official/m");
  assert.equal(variant, "pss-official--agents-md/m");
  assert.notEqual(baseline, variant);
});
