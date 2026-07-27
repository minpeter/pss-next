import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { isIgnoredWorkspacePath, workspaceRelativePath } from "./path-safety";

const GLOB_SPECIAL_CHARACTER = /[\\^$+.()|[\]{}]/g;
const MAX_WALK_FILES = 10_000;

interface WalkContext {
  readonly files: string[];
  readonly includeIgnored: boolean;
  readonly maxFiles: number;
  readonly root: string;
  truncated: boolean;
}

async function visitDirectory(
  context: WalkContext,
  directory: string
): Promise<boolean> {
  const entries: Dirent[] = [];
  for await (const entry of await opendir(directory)) {
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = workspaceRelativePath(context.root, absolutePath);
    if (!context.includeIgnored && isIgnoredWorkspacePath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (await visitDirectory(context, absolutePath)) {
        return true;
      }
    } else if (entry.isFile()) {
      context.files.push(absolutePath);
      if (context.files.length >= context.maxFiles) {
        context.truncated = true;
        return true;
      }
    }
  }
  return false;
}

export interface WalkWorkspaceFilesResult {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export async function walkWorkspaceFiles(
  root: string,
  startPath: string,
  includeIgnored = false,
  maxFiles = MAX_WALK_FILES
): Promise<WalkWorkspaceFilesResult> {
  const context: WalkContext = {
    files: [],
    includeIgnored,
    maxFiles,
    root,
    truncated: false,
  };
  await visitDirectory(context, startPath);
  return { files: context.files, truncated: context.truncated };
}

export function globPatternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(GLOB_SPECIAL_CHARACTER, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}
