import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverAgentsContextFiles,
  formatAgentsContextInstructions,
} from "./agents-context";

const EXCEEDS = /exceeds/;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-agents-context-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function makeRepo(): Promise<{ cwd: string; home: string }> {
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return { cwd, home };
}

describe("discoverAgentsContextFiles", () => {
  it("collects global, repo-root, and nested files closest-last", async () => {
    const { cwd, home } = await makeRepo();
    await mkdir(join(home, ".pss"), { recursive: true });
    await writeFile(join(home, ".pss", "AGENTS.md"), "global rules");
    await writeFile(join(root, "repo", "AGENTS.md"), "repo rules");
    await writeFile(join(cwd, "AGENTS.md"), "app rules");

    const files = await discoverAgentsContextFiles({ cwd, home });
    expect(files.map((file) => file.content)).toEqual([
      "global rules",
      "repo rules",
      "app rules",
    ]);
  });

  it("is bounded at the repository root", async () => {
    const { cwd, home } = await makeRepo();
    // Above the repo root: must never be picked up.
    await writeFile(join(root, "AGENTS.md"), "outside rules");
    await writeFile(join(root, "repo", "AGENTS.md"), "repo rules");

    const files = await discoverAgentsContextFiles({ cwd, home });
    expect(files.map((file) => file.content)).toEqual(["repo rules"]);
  });

  it("only reads the working directory when no repo root exists", async () => {
    const home = join(root, "home");
    const cwd = join(root, "loose", "dir");
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "loose", "AGENTS.md"), "parent rules");
    await writeFile(join(cwd, "AGENTS.md"), "cwd rules");

    const files = await discoverAgentsContextFiles({ cwd, home });
    expect(files.map((file) => file.content)).toEqual(["cwd rules"]);
  });

  it("skips empty files", async () => {
    const { cwd, home } = await makeRepo();
    await writeFile(join(cwd, "AGENTS.md"), "   \n");
    const files = await discoverAgentsContextFiles({ cwd, home });
    expect(files).toEqual([]);
  });

  it("rejects oversized context files", async () => {
    const { cwd, home } = await makeRepo();
    await writeFile(join(cwd, "AGENTS.md"), "x".repeat(200 * 1024));
    await expect(discoverAgentsContextFiles({ cwd, home })).rejects.toThrow(
      EXCEEDS
    );
  });
});

describe("formatAgentsContextInstructions", () => {
  it("returns undefined without files", () => {
    expect(formatAgentsContextInstructions([])).toBeUndefined();
  });

  it("wraps each file with its path", () => {
    const fragment = formatAgentsContextInstructions([
      { content: "repo rules", path: "/repo/AGENTS.md" },
    ]);
    expect(fragment).toContain('"/repo/AGENTS.md"');
    expect(fragment).toContain("repo rules");
  });
});
