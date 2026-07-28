import { realpath } from "node:fs/promises";
import { extensionTrustPath } from "../extensions/manager/paths";
import { readTrustedProjects } from "../extensions/manager/settings";
import type { TuiCommand, TuiCommandResult } from "../tui/command";
import {
  type AgentsContextFile,
  discoverAgentsContextFiles,
  formatAgentsContextInstructions,
} from "./agents-context";
import {
  discoverPromptTemplates,
  expandPromptTemplate,
  type PromptTemplate,
} from "./prompt-templates";
import {
  discoverSkills,
  formatSkillsInstructions,
  type SkillDefinition,
} from "./skills";

export interface ExtensionResourceRoots {
  readonly prompts: readonly string[];
  readonly skills: readonly string[];
}

export interface ContextResources {
  readonly agentsFiles: readonly AgentsContextFile[];
  /** System-prompt fragments derived from AGENTS.md files and skills. */
  readonly instructionFragments: readonly string[];
  readonly notices: readonly string[];
  readonly promptTemplates: readonly PromptTemplate[];
  readonly skills: readonly SkillDefinition[];
}

/**
 * Load file-based context resources: AGENTS.md context files, prompt
 * templates, and skills, from the global scope, the (trust-gated) project
 * scope, and extension-contributed resource roots.
 *
 * Failures degrade to an empty resource set with a notice; context files
 * must never prevent the session from starting.
 */
export async function loadContextResources({
  cwd,
  home,
  resourceRoots,
}: {
  readonly cwd: string;
  readonly home: string;
  readonly resourceRoots?: ExtensionResourceRoots;
}): Promise<ContextResources> {
  const notices: string[] = [];
  const projectTrusted = await isProjectTrusted({ cwd, home, notices });
  const [agentsFiles, promptDiscovery, skillDiscovery] = await Promise.all([
    discoverAgentsContextFiles({ cwd, home }).catch((error: unknown) => {
      notices.push(`AGENTS.md discovery failed: ${message(error)}`);
      return [] as const;
    }),
    discoverPromptTemplates({
      cwd,
      extensionDirs: resourceRoots?.prompts ?? [],
      home,
      projectTrusted,
    }).catch((error: unknown) => {
      notices.push(`Prompt template discovery failed: ${message(error)}`);
      return { notices: [], templates: [] } as const;
    }),
    discoverSkills({
      cwd,
      extensionDirs: resourceRoots?.skills ?? [],
      home,
      projectTrusted,
    }).catch((error: unknown) => {
      notices.push(`Skill discovery failed: ${message(error)}`);
      return { notices: [], skills: [] } as const;
    }),
  ]);
  notices.push(...promptDiscovery.notices, ...skillDiscovery.notices);
  const instructionFragments = [
    formatAgentsContextInstructions(agentsFiles),
    formatSkillsInstructions(skillDiscovery.skills),
  ].filter((fragment): fragment is string => fragment !== undefined);
  return {
    agentsFiles,
    instructionFragments,
    notices,
    promptTemplates: promptDiscovery.templates,
    skills: skillDiscovery.skills,
  };
}

/**
 * Wrap prompt templates as TUI slash commands. Templates never shadow an
 * existing command (built-in or extension); shadowed templates are skipped
 * with a notice instead of failing the session.
 */
export function mergePromptTemplateCommands(
  commands: readonly TuiCommand[],
  templates: readonly PromptTemplate[]
): { readonly commands: TuiCommand[]; readonly notices: readonly string[] } {
  const taken = new Set<string>();
  for (const command of commands) {
    taken.add(command.name.toLowerCase());
    for (const alias of command.aliases ?? []) {
      taken.add(alias.toLowerCase());
    }
  }
  const merged = [...commands];
  const notices: string[] = [];
  for (const template of templates) {
    const key = template.name.toLowerCase();
    if (taken.has(key)) {
      notices.push(
        `Skipped prompt template "/${template.name}" (${template.path}): the command name is already taken.`
      );
      continue;
    }
    taken.add(key);
    merged.push(createPromptTemplateCommand(template));
  }
  return { commands: merged, notices };
}

export function createPromptTemplateCommand(
  template: PromptTemplate
): TuiCommand {
  return {
    description: template.description,
    execute: ({ args }): TuiCommandResult => ({
      action: {
        prompt: expandPromptTemplate(template.content, args),
        type: "submit-prompt",
      },
      success: true,
    }),
    name: template.name,
  };
}

async function isProjectTrusted({
  cwd,
  home,
  notices,
}: {
  readonly cwd: string;
  readonly home: string;
  readonly notices: string[];
}): Promise<boolean> {
  let project: string;
  try {
    project = await realpath(cwd);
  } catch {
    // A nonexistent working directory has no project resources to unlock.
    return false;
  }
  try {
    const trustedProjects = await readTrustedProjects(extensionTrustPath(home));
    return trustedProjects.includes(project);
  } catch (error) {
    // Malformed trust settings fail safe: project resources stay blocked.
    notices.push(
      `Project resources are blocked: trust settings could not be read (${message(error)}).`
    );
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
