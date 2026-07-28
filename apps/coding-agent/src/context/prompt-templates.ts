import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter";

export type PromptTemplateSource = "extension" | "global" | "project";

export interface PromptTemplate {
  readonly content: string;
  readonly description: string;
  readonly name: string;
  readonly path: string;
  readonly source: PromptTemplateSource;
}

export interface DiscoveredPromptTemplates {
  readonly notices: readonly string[];
  readonly templates: readonly PromptTemplate[];
}

const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
// One combined pass: substituted argument text is never re-scanned, so an
// argument containing "$1" or "$ARGUMENTS" cannot trigger a second
// substitution.
const PLACEHOLDER_PATTERN = /\$ARGUMENTS|\$([1-9])/g;
const WHITESPACE = /\s+/;

/** Precedence when two sources define the same template name. */
const SOURCE_PRECEDENCE: Readonly<Record<PromptTemplateSource, number>> = {
  extension: 0,
  global: 1,
  project: 2,
};

/**
 * Discover file-based prompt templates (`*.md`): `~/.pss/prompts` (global),
 * `<cwd>/.pss/prompts` (project, only when the project is trusted — the
 * same gate the extension loader applies), and any extension-contributed
 * prompt directories.
 *
 * On name collisions project templates win over global ones, which win
 * over extension-contributed ones; losers are skipped with a notice.
 */
export async function discoverPromptTemplates({
  cwd,
  extensionDirs = [],
  home,
  projectTrusted,
}: {
  readonly cwd: string;
  readonly extensionDirs?: readonly string[];
  readonly home: string;
  readonly projectTrusted: boolean;
}): Promise<DiscoveredPromptTemplates> {
  const notices: string[] = [];
  const discovered: PromptTemplate[] = [];
  const roots: readonly {
    readonly directory: string;
    readonly source: PromptTemplateSource;
  }[] = [
    ...extensionDirs.map((directory) => ({
      directory,
      source: "extension" as const,
    })),
    { directory: join(home, ".pss", "prompts"), source: "global" as const },
    { directory: join(cwd, ".pss", "prompts"), source: "project" as const },
  ];
  for (const root of roots) {
    if (root.source === "project" && !projectTrusted) {
      if (await hasMarkdownFiles(root.directory)) {
        notices.push(
          "Project prompt templates are blocked until this project is trusted."
        );
      }
      continue;
    }
    discovered.push(
      ...(await readTemplateDirectory(root.directory, root.source, notices))
    );
  }
  const templates = new Map<string, PromptTemplate>();
  for (const template of discovered) {
    const key = template.name.toLowerCase();
    const existing = templates.get(key);
    if (existing === undefined) {
      templates.set(key, template);
      continue;
    }
    const winner =
      SOURCE_PRECEDENCE[template.source] > SOURCE_PRECEDENCE[existing.source]
        ? template
        : existing;
    const loser = winner === template ? existing : template;
    templates.set(key, winner);
    notices.push(
      `Skipped ${loser.source} prompt template "${loser.name}" (${loser.path}): superseded by the ${winner.source} template.`
    );
  }
  return {
    notices,
    templates: [...templates.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

/**
 * Expand a template body with slash-command arguments: `$ARGUMENTS` becomes
 * the full argument string, `$1`..`$9` become positional arguments. When the
 * body has no placeholders, provided arguments are appended so `/name extra
 * detail` still reaches the model.
 */
export function expandPromptTemplate(
  content: string,
  args: readonly string[]
): string {
  const argumentText = args.join(" ");
  let usedPlaceholder = false;
  const expanded = content.replace(PLACEHOLDER_PATTERN, (match, digit) => {
    usedPlaceholder = true;
    if (match === "$ARGUMENTS") {
      return argumentText;
    }
    return args[Number(digit) - 1] ?? "";
  });
  if (!usedPlaceholder && argumentText.length > 0) {
    return `${expanded.trimEnd()}\n\n${argumentText}`;
  }
  return expanded;
}

/**
 * Expand a headless-exec prompt of the form `/name args...` against the
 * discovered templates. Prompts that do not name a known template are
 * returned unchanged so plain prompts starting with `/` keep working.
 */
export function expandPromptForExec(
  prompt: string,
  templates: readonly PromptTemplate[]
): string {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return prompt;
  }
  const [head = "", ...rest] = trimmed.slice(1).split(WHITESPACE);
  const template = templates.find(
    (candidate) => candidate.name.toLowerCase() === head.toLowerCase()
  );
  if (template === undefined) {
    return prompt;
  }
  return expandPromptTemplate(template.content, rest);
}

async function readTemplateDirectory(
  directory: string,
  source: PromptTemplateSource,
  notices: string[]
): Promise<readonly PromptTemplate[]> {
  const entries = await listMarkdownFiles(directory);
  const templates: PromptTemplate[] = [];
  for (const entry of entries) {
    const name = basename(entry, ".md");
    if (!TEMPLATE_NAME_PATTERN.test(name)) {
      notices.push(
        `Skipped prompt template "${join(directory, entry)}": invalid name "${name}".`
      );
      continue;
    }
    const path = join(directory, entry);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const { body, metadata } = parseMarkdownFrontmatter(raw);
    const content = body.trim();
    if (content.length === 0) {
      notices.push(`Skipped prompt template "${path}": empty body.`);
      continue;
    }
    templates.push({
      content,
      description:
        metadata.description?.trim() || `Prompt template (${source}): ${name}`,
      name,
      path,
      source,
    });
  }
  return templates;
}

async function listMarkdownFiles(
  directory: string
): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function hasMarkdownFiles(directory: string): Promise<boolean> {
  return (await listMarkdownFiles(directory)).length > 0;
}
