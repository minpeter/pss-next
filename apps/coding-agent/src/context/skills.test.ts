import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, formatSkillsInstructions } from "./skills";

let root: string;
let cwd: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-skills-"));
  cwd = join(root, "project");
  home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function writeSkill(
  base: string,
  directory: string,
  content: string
): Promise<string> {
  const skillDirectory = join(base, ".pss", "skills", directory);
  await mkdir(skillDirectory, { recursive: true });
  const path = join(skillDirectory, "SKILL.md");
  await writeFile(path, content);
  return path;
}

describe("discoverSkills", () => {
  it("loads global skills with name/description metadata", async () => {
    const path = await writeSkill(
      home,
      "changelog",
      "---\ndescription: Write a changelog entry\n---\nSteps..."
    );
    const { notices, skills } = await discoverSkills({
      cwd,
      home,
      projectTrusted: false,
    });
    expect(notices).toEqual([]);
    expect(skills).toEqual([
      {
        description: "Write a changelog entry",
        name: "changelog",
        path,
        source: "global",
      },
    ]);
  });

  it("skips skills without a description", async () => {
    await writeSkill(home, "broken", "no frontmatter");
    const { notices, skills } = await discoverSkills({
      cwd,
      home,
      projectTrusted: false,
    });
    expect(skills).toEqual([]);
    expect(notices.join(" ")).toContain("missing description");
  });

  it("blocks untrusted project skills with a notice", async () => {
    await writeSkill(cwd, "deploy", "---\ndescription: Deploy\n---\nsteps");
    const { notices, skills } = await discoverSkills({
      cwd,
      home,
      projectTrusted: false,
    });
    expect(skills).toEqual([]);
    expect(notices.join(" ")).toContain(
      "blocked until this project is trusted"
    );
  });

  it("prefers project skills over global ones on name collisions", async () => {
    await writeSkill(home, "review", "---\ndescription: Global review\n---\n");
    const projectPath = await writeSkill(
      cwd,
      "review",
      "---\ndescription: Project review\n---\n"
    );
    const { skills } = await discoverSkills({
      cwd,
      home,
      projectTrusted: true,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      description: "Project review",
      path: projectPath,
      source: "project",
    });
  });

  it("includes extension-contributed skill directories", async () => {
    const extensionRoot = join(root, "ext-skills");
    await mkdir(join(extensionRoot, "triage"), { recursive: true });
    await writeFile(
      join(extensionRoot, "triage", "SKILL.md"),
      "---\ndescription: Triage issues\n---\n"
    );
    const { skills } = await discoverSkills({
      cwd,
      extensionDirs: [extensionRoot],
      home,
      projectTrusted: false,
    });
    expect(skills).toEqual([
      {
        description: "Triage issues",
        name: "triage",
        path: join(extensionRoot, "triage", "SKILL.md"),
        source: "extension",
      },
    ]);
  });
});

describe("formatSkillsInstructions", () => {
  it("returns undefined without skills", () => {
    expect(formatSkillsInstructions([])).toBeUndefined();
  });

  it("lists each skill with its on-demand path", () => {
    const fragment = formatSkillsInstructions([
      {
        description: "Write a changelog entry",
        name: "changelog",
        path: "/skills/changelog/SKILL.md",
        source: "global",
      },
    ]);
    expect(fragment).toContain("changelog: Write a changelog entry");
    expect(fragment).toContain("/skills/changelog/SKILL.md");
    expect(fragment).toContain("read_file");
  });
});
