import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuiCommand } from "../tui/command";
import { loadContextResources, mergePromptTemplateCommands } from "./index";
import type { PromptTemplate } from "./prompt-templates";

let root: string;
let cwd: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-context-resources-"));
  cwd = join(root, "project");
  home = join(root, "home");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("loadContextResources", () => {
  it("aggregates AGENTS.md, prompts, and skills into fragments", async () => {
    await writeFile(join(cwd, "AGENTS.md"), "Use tabs.");
    await mkdir(join(home, ".pss", "prompts"), { recursive: true });
    await writeFile(join(home, ".pss", "prompts", "review.md"), "Review it");
    await mkdir(join(home, ".pss", "skills", "changelog"), { recursive: true });
    await writeFile(
      join(home, ".pss", "skills", "changelog", "SKILL.md"),
      "---\ndescription: Write changelogs\n---\n"
    );

    const resources = await loadContextResources({ cwd, home });
    expect(resources.agentsFiles).toHaveLength(1);
    expect(resources.promptTemplates.map((t) => t.name)).toEqual(["review"]);
    expect(resources.skills.map((s) => s.name)).toEqual(["changelog"]);
    expect(resources.instructionFragments).toHaveLength(2);
    expect(resources.instructionFragments.join("\n")).toContain("Use tabs.");
    expect(resources.instructionFragments.join("\n")).toContain(
      "Write changelogs"
    );
  });

  it("treats untrusted projects as blocked for project resources", async () => {
    await mkdir(join(cwd, ".pss", "prompts"), { recursive: true });
    await writeFile(join(cwd, ".pss", "prompts", "ship.md"), "Ship it");

    const resources = await loadContextResources({ cwd, home });
    expect(resources.promptTemplates).toEqual([]);
    expect(resources.notices.join(" ")).toContain("blocked");
  });

  it("fails safe when trust settings are malformed", async () => {
    await mkdir(join(home, ".pss"), { recursive: true });
    await writeFile(join(home, ".pss", "trusted-projects.json"), "{broken");
    await mkdir(join(cwd, ".pss", "prompts"), { recursive: true });
    await writeFile(join(cwd, ".pss", "prompts", "ship.md"), "Ship it");

    const resources = await loadContextResources({ cwd, home });
    expect(resources.promptTemplates).toEqual([]);
  });

  it("consults extension resource roots", async () => {
    const promptRoot = join(root, "ext-prompts");
    await mkdir(promptRoot, { recursive: true });
    await writeFile(join(promptRoot, "triage.md"), "Triage: $ARGUMENTS");

    const resources = await loadContextResources({
      cwd,
      home,
      resourceRoots: { prompts: [promptRoot], skills: [] },
    });
    expect(resources.promptTemplates.map((t) => t.name)).toEqual(["triage"]);
    expect(resources.promptTemplates[0]?.source).toBe("extension");
  });
});

describe("mergePromptTemplateCommands", () => {
  const template = (name: string): PromptTemplate => ({
    content: `Run ${name}: $ARGUMENTS`,
    description: `run ${name}`,
    name,
    path: `/prompts/${name}.md`,
    source: "global",
  });

  it("appends template commands that submit expanded prompts", async () => {
    const { commands, notices } = mergePromptTemplateCommands(
      [],
      [template("review")]
    );
    expect(notices).toEqual([]);
    expect(commands.map((command) => command.name)).toEqual(["review"]);
    const result = await commands[0]?.execute({ args: ["src"] });
    expect(result).toEqual({
      action: { prompt: "Run review: src", type: "submit-prompt" },
      success: true,
    });
  });

  it("never shadows existing commands or aliases", () => {
    const existing: TuiCommand[] = [
      {
        aliases: ["review"],
        description: "built-in",
        execute: () => ({ success: true }),
        name: "clear",
      },
    ];
    const { commands, notices } = mergePromptTemplateCommands(existing, [
      template("review"),
      template("clear"),
      template("triage"),
    ]);
    expect(commands.map((command) => command.name)).toEqual([
      "clear",
      "triage",
    ]);
    expect(notices).toHaveLength(2);
  });
});
