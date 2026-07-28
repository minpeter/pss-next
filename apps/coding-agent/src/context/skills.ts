import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter";

export type SkillSource = "extension" | "global" | "project";

export interface SkillDefinition {
  readonly description: string;
  readonly name: string;
  /** Absolute path to the SKILL.md the agent reads on demand. */
  readonly path: string;
  readonly source: SkillSource;
}

export interface DiscoveredSkills {
  readonly notices: readonly string[];
  readonly skills: readonly SkillDefinition[];
}

const SKILL_FILENAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const SOURCE_PRECEDENCE: Readonly<Record<SkillSource, number>> = {
  extension: 0,
  global: 1,
  project: 2,
};

/**
 * Discover `SKILL.md`-style skill directories: `~/.pss/skills/<name>/`
 * (global), `<cwd>/.pss/skills/<name>/` (project, trust-gated like the
 * extension loader), and extension-contributed skill directories.
 *
 * Only the name/description metadata is loaded eagerly; the skill body is
 * read on demand by the model via `read_file` when a task matches.
 */
export async function discoverSkills({
  cwd,
  extensionDirs = [],
  home,
  projectTrusted,
}: {
  readonly cwd: string;
  readonly extensionDirs?: readonly string[];
  readonly home: string;
  readonly projectTrusted: boolean;
}): Promise<DiscoveredSkills> {
  const notices: string[] = [];
  const discovered: SkillDefinition[] = [];
  const roots: readonly {
    readonly directory: string;
    readonly source: SkillSource;
  }[] = [
    ...extensionDirs.map((directory) => ({
      directory,
      source: "extension" as const,
    })),
    { directory: join(home, ".pss", "skills"), source: "global" as const },
    { directory: join(cwd, ".pss", "skills"), source: "project" as const },
  ];
  for (const root of roots) {
    if (root.source === "project" && !projectTrusted) {
      if (await hasSkillCandidates(root.directory)) {
        notices.push(
          "Project skills are blocked until this project is trusted."
        );
      }
      continue;
    }
    discovered.push(
      ...(await readSkillRoot(root.directory, root.source, notices))
    );
  }
  const skills = new Map<string, SkillDefinition>();
  for (const skill of discovered) {
    const key = skill.name.toLowerCase();
    const existing = skills.get(key);
    if (existing === undefined) {
      skills.set(key, skill);
      continue;
    }
    const winner =
      SOURCE_PRECEDENCE[skill.source] > SOURCE_PRECEDENCE[existing.source]
        ? skill
        : existing;
    const loser = winner === skill ? existing : skill;
    skills.set(key, winner);
    notices.push(
      `Skipped ${loser.source} skill "${loser.name}" (${loser.path}): superseded by the ${winner.source} skill.`
    );
  }
  return {
    notices,
    skills: [...skills.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

export function formatSkillsInstructions(
  skills: readonly SkillDefinition[]
): string | undefined {
  if (skills.length === 0) {
    return;
  }
  const lines = skills.map(
    (skill) => `- ${skill.name}: ${skill.description} (${skill.path})`
  );
  return [
    "Skills are specialized playbooks loaded on demand. When a task matches a skill description, read its SKILL.md with read_file and follow it before proceeding:",
    ...lines,
  ].join("\n");
}

async function readSkillRoot(
  directory: string,
  source: SkillSource,
  notices: string[]
): Promise<readonly SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  for (const candidate of await listSkillDirectories(directory)) {
    const path = join(directory, candidate, SKILL_FILENAME);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const { metadata } = parseMarkdownFrontmatter(raw);
    const name = (metadata.name ?? candidate).trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      notices.push(`Skipped skill "${path}": invalid name "${name}".`);
      continue;
    }
    const description = metadata.description?.trim();
    if (!description) {
      notices.push(`Skipped skill "${path}": missing description frontmatter.`);
      continue;
    }
    skills.push({ description, name, path, source });
  }
  return skills;
}

async function listSkillDirectories(
  directory: string
): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function hasSkillCandidates(directory: string): Promise<boolean> {
  return (await listSkillDirectories(directory)).length > 0;
}
