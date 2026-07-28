import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverPromptTemplates,
  expandPromptForExec,
  expandPromptTemplate,
} from "./prompt-templates";

let root: string;
let cwd: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-prompt-templates-"));
  cwd = join(root, "project");
  home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function writeTemplate(
  base: string,
  name: string,
  content: string
): Promise<void> {
  const directory = join(base, ".pss", "prompts");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), content);
}

describe("discoverPromptTemplates", () => {
  it("loads global templates with frontmatter descriptions", async () => {
    await writeTemplate(
      home,
      "review",
      "---\ndescription: Review the current diff\n---\nReview this: $ARGUMENTS"
    );
    const { notices, templates } = await discoverPromptTemplates({
      cwd,
      home,
      projectTrusted: false,
    });
    expect(notices).toEqual([]);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      description: "Review the current diff",
      name: "review",
      source: "global",
    });
  });

  it("blocks project templates for untrusted projects with a notice", async () => {
    await writeTemplate(cwd, "deploy", "Ship it");
    const { notices, templates } = await discoverPromptTemplates({
      cwd,
      home,
      projectTrusted: false,
    });
    expect(templates).toEqual([]);
    expect(notices.join(" ")).toContain(
      "blocked until this project is trusted"
    );
  });

  it("prefers project templates over global and extension ones", async () => {
    const extensionDir = join(root, "ext-prompts");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "review.md"), "extension body");
    await writeTemplate(home, "review", "global body");
    await writeTemplate(cwd, "review", "project body");
    const { templates } = await discoverPromptTemplates({
      cwd,
      extensionDirs: [extensionDir],
      home,
      projectTrusted: true,
    });
    expect(templates).toHaveLength(1);
    expect(templates[0]?.content).toBe("project body");
    expect(templates[0]?.source).toBe("project");
  });

  it("skips invalid names and empty bodies with notices", async () => {
    await writeTemplate(home, "bad name!", "body");
    await writeTemplate(home, "empty", "---\ndescription: x\n---\n  ");
    const { notices, templates } = await discoverPromptTemplates({
      cwd,
      home,
      projectTrusted: false,
    });
    expect(templates).toEqual([]);
    expect(notices).toHaveLength(2);
  });
});

describe("expandPromptTemplate", () => {
  it("replaces $ARGUMENTS and positional placeholders", () => {
    expect(expandPromptTemplate("Fix $1 in $2: $ARGUMENTS", ["a", "b"])).toBe(
      "Fix a in b: a b"
    );
  });

  it("never re-substitutes placeholder-like text inside arguments", () => {
    expect(
      expandPromptTemplate("Review: $ARGUMENTS", ["costs", "$1-billion"])
    ).toBe("Review: costs $1-billion");
    expect(expandPromptTemplate("Fix $1", ["$ARGUMENTS"])).toBe(
      "Fix $ARGUMENTS"
    );
  });

  it("appends arguments when the body has no placeholders", () => {
    expect(expandPromptTemplate("Review the diff.", ["src/index.ts"])).toBe(
      "Review the diff.\n\nsrc/index.ts"
    );
  });

  it("leaves the body untouched without arguments", () => {
    expect(expandPromptTemplate("Review the diff.", [])).toBe(
      "Review the diff."
    );
  });
});

describe("expandPromptForExec", () => {
  const templates = [
    {
      content: "Review: $ARGUMENTS",
      description: "d",
      name: "review",
      path: "/x/review.md",
      source: "global" as const,
    },
  ];

  it("expands a known template invocation", () => {
    expect(expandPromptForExec("/review src things", templates)).toBe(
      "Review: src things"
    );
  });

  it("leaves unknown slash prompts unchanged", () => {
    expect(expandPromptForExec("/unknown thing", templates)).toBe(
      "/unknown thing"
    );
  });

  it("leaves plain prompts unchanged", () => {
    expect(expandPromptForExec("do the thing", templates)).toBe("do the thing");
  });
});
