import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AgentsContextFile {
  readonly content: string;
  readonly path: string;
}

const AGENTS_FILENAME = "AGENTS.md";
const MAX_AGENTS_FILE_BYTES = 128 * 1024;

/**
 * Discover `AGENTS.md` context files: the global `~/.pss/AGENTS.md` first,
 * then every `AGENTS.md` from the repository root down to the working
 * directory. The walk is bounded at the first ancestor containing `.git`
 * (the repository root); without one, only the working directory itself is
 * consulted so an unrelated home-directory file is never picked up.
 *
 * The returned order is outermost-first so the closest file appears last
 * and its guidance wins when instructions conflict.
 */
export async function discoverAgentsContextFiles({
  cwd,
  home,
}: {
  readonly cwd: string;
  readonly home: string;
}): Promise<readonly AgentsContextFile[]> {
  const candidates: string[] = [join(home, ".pss", AGENTS_FILENAME)];
  const directories: string[] = [];
  let directory = cwd;
  for (;;) {
    directories.push(directory);
    if (await isDirectory(join(directory, ".git"))) {
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      // No repository root above cwd: only the working directory applies.
      directories.length = 0;
      directories.push(cwd);
      break;
    }
    directory = parent;
  }
  directories.reverse();
  for (const dir of directories) {
    candidates.push(join(dir, AGENTS_FILENAME));
  }
  const files: AgentsContextFile[] = [];
  for (const path of candidates) {
    const content = await readContextFile(path);
    if (content !== undefined) {
      files.push({ content, path });
    }
  }
  return files;
}

export function formatAgentsContextInstructions(
  files: readonly AgentsContextFile[]
): string | undefined {
  if (files.length === 0) {
    return;
  }
  const sections = files.map(
    (file) =>
      `<context-file path=${JSON.stringify(file.path)}>\n${file.content.trim()}\n</context-file>`
  );
  return [
    "Project and user context files (AGENTS.md). Later files are closer to the working directory and take precedence when guidance conflicts:",
    ...sections,
  ].join("\n\n");
}

async function readContextFile(path: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return;
  }
  if (content.trim().length === 0) {
    return;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_AGENTS_FILE_BYTES) {
    throw new Error(
      `AGENTS.md context file ${JSON.stringify(path)} exceeds ${MAX_AGENTS_FILE_BYTES} bytes`
    );
  }
  return content;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
