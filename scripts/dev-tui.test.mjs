import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8")
);
const marker = "__DEV_TUI_PROBE__";
let directory;
let repository;
let caller;
let env;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const output = result.stdout
    .split("\n")
    .find((line) => line.startsWith(marker));
  expect(output, result.stdout).toBeDefined();
  return JSON.parse(output.slice(marker.length));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pss-dev-tui-"));
  repository = join(directory, "repo");
  caller = join(directory, "caller workspace");
  const home = join(directory, "home");
  for (const path of [repository, caller, home]) {
    mkdirSync(path, { recursive: true });
  }
  cpSync(
    join(root, "apps/coding-agent/src"),
    join(repository, "apps/coding-agent/src"),
    { recursive: true }
  );
  cpSync(join(root, "scripts"), join(repository, "scripts"), {
    recursive: true,
  });
  symlinkSync(
    join(root, "apps/coding-agent/node_modules"),
    join(repository, "apps/coding-agent/node_modules"),
    "dir"
  );
  symlinkSync(
    join(root, "node_modules"),
    join(repository, "node_modules"),
    "dir"
  );
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({
      type: "module",
      packageManager: packageJson.packageManager,
      scripts: { "dev:tui": packageJson.scripts["dev:tui"] },
    })
  );
  writeFileSync(
    join(repository, ".env"),
    "AI_API_KEY=fixture-repo-key\nAI_BASE_URL=https://repo.invalid/v1\nAI_MODEL=fixture-repo-model\n"
  );
  writeFileSync(
    join(caller, ".env"),
    "AI_API_KEY=fixture-caller-key\nAI_BASE_URL=https://caller.invalid/v1\nAI_MODEL=fixture-caller-model\n"
  );
  writeFileSync(
    join(repository, "workspace-marker.txt"),
    "REPO_WORKSPACE_SENTINEL"
  );
  writeFileSync(
    join(caller, "workspace-marker.txt"),
    "CALLER_WORKSPACE_SENTINEL"
  );
  writeFileSync(join(caller, "AGENTS.md"), "CALLER_CONTEXT_SENTINEL");
  const probe = join(root, "scripts/fixtures/dev-tui-probe.mjs");
  env = {
    ...process.env,
    AI_API_KEY: "fixture-shell-key",
    AI_BASE_URL: "https://shell.invalid/v1",
    AI_MODEL: "fixture-shell-model",
    HOME: home,
    INIT_CWD: undefined,
    NODE_OPTIONS: `--import=${pathToFileURL(probe).href}`,
    PSS_AUTO_UPDATE: "0",
    PSS_DISABLE_UPDATE_CHECK: "1",
    PSS_THREAD_DIR: join(directory, "threads"),
    PSS_THREAD_KEY: undefined,
  };
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

// The resume case launches two subprocesses, each bounded at 30 seconds.
// Allow their combined budget plus assertion overhead, including on busy CI.
describe("dev:tui launcher", { timeout: 65_000 }, () => {
  it("uses pnpm's invocation cwd for sessions and autocomplete, retaining repository model settings", () => {
    const result = run("pnpm", ["-C", repository, "dev:tui"], caller);
    expect(result.initCwd).toBe(caller);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].cwd).toBe(caller);
    expect(result.autocompleteCwd).toBe(caller);
    expect(result.contextPaths).toEqual([join(caller, "AGENTS.md")]);
    expect(result.callerFileRead).toBe(true);
    expect(result.model).toBe("fixture-repo-model");
    expect(result.baseURL).toBe("https://repo.invalid/v1");
    expect(result.apiKey).toBe("fixture-repo-key");
  });

  it("keeps repository invocation and --session forwarding working", () => {
    const initial = run("pnpm", ["-C", repository, "dev:tui"], repository);
    const key = initial.sessions[0].key;
    const result = run(
      "pnpm",
      ["-C", repository, "dev:tui", "--", "--session", key],
      repository
    );
    expect(result.sessions).toEqual([{ cwd: repository, key }]);
    expect(result.autocompleteCwd).toBe(repository);
  });

  it("falls back to process cwd without pnpm's INIT_CWD", () => {
    const result = run(
      join(root, "node_modules/.bin/tsx"),
      [
        "--conditions=@minpeter/pss-source",
        join(repository, "scripts/dev-tui.mjs"),
      ],
      repository
    );
    expect(result.initCwd).toBeUndefined();
    expect(result.sessions[0].cwd).toBe(repository);
  });

  it("does not reinterpret INIT_CWD for the existing direct TUI entry", () => {
    env.INIT_CWD = caller;
    const result = run(
      join(root, "node_modules/.bin/tsx"),
      [
        "--conditions=@minpeter/pss-source",
        join(repository, "apps/coding-agent/src/tui/app.ts"),
      ],
      repository
    );
    expect(result.sessions[0].cwd).toBe(repository);
    expect(result.autocompleteCwd).toBe(repository);
    expect(result.callerFileRead).toBe(false);
  });
});
