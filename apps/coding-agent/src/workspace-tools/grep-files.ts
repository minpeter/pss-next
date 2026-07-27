import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { formatLineAnchor } from "./hashline";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";
import { globPatternToRegExp, walkWorkspaceFiles } from "./walk";

const END_OF_LINE_PATTERN = /\r?\n/u;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const inputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    include: z.string().min(1).optional(),
    fixed_strings: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    include_ignored: z.boolean().optional(),
    max_results: z.number().int().positive().max(1000).optional(),
  })
  .strict();

function createMatcher(
  pattern: string,
  fixedStrings: boolean,
  caseSensitive: boolean
): (line: string) => boolean {
  if (fixedStrings) {
    const expected = caseSensitive ? pattern : pattern.toLocaleLowerCase();
    return (line) =>
      (caseSensitive ? line : line.toLocaleLowerCase()).includes(expected);
  }
  const expression = new RegExp(pattern, caseSensitive ? "u" : "iu");
  return (line) => expression.test(line);
}

function skippedNote(skippedFiles: number): string {
  return skippedFiles > 0
    ? `; skipped ${skippedFiles} file(s) over 2 MiB or binary`
    : "";
}

interface SearchFileResult {
  readonly matches: readonly string[];
  readonly skipped: boolean;
}

async function searchFile(
  file: string,
  relativePath: string,
  matchesLine: (line: string) => boolean,
  budget: number
): Promise<SearchFileResult> {
  if ((await stat(file)).size > MAX_FILE_BYTES) {
    return { matches: [], skipped: true };
  }
  const content = await readFile(file);
  if (content.includes(0)) {
    return { matches: [], skipped: true };
  }
  const results: string[] = [];
  for (const [index, line] of content
    .toString("utf8")
    .split(END_OF_LINE_PATTERN)
    .entries()) {
    if (results.length >= budget) {
      break;
    }
    if (matchesLine(line)) {
      const clipped = line.length > 500 ? `${line.slice(0, 500)}…` : line;
      results.push(
        `${relativePath}:${formatLineAnchor(index + 1, line)}|${clipped}`
      );
    }
  }
  return { matches: results, skipped: false };
}

export function createGrepFilesTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Search text files and return path:LINE#ID|content matches compatible with plugsuits hashline anchors. Narrow path/include when output truncates.",
    inputSchema,
    execute: async ({
      pattern,
      path = ".",
      include,
      fixed_strings: fixedStrings = false,
      case_sensitive: caseSensitive = true,
      include_ignored: includeIgnored = false,
      max_results: maxResults = 200,
    }) => {
      const resolved = await resolveWorkspacePath(workspace, path);
      const startPath = resolved.path;
      if (!(await stat(startPath)).isDirectory()) {
        throw new Error(`Grep path is not a directory: ${path}`);
      }
      const includeMatcher = include ? globPatternToRegExp(include) : undefined;
      const matchesLine = createMatcher(pattern, fixedStrings, caseSensitive);
      const results: string[] = [];
      let skippedFiles = 0;
      const { files, truncated: walkTruncated } = await walkWorkspaceFiles(
        resolved.root,
        startPath,
        includeIgnored
      );
      for (const file of files) {
        const relativePath = workspaceRelativePath(resolved.root, file);
        if (
          includeMatcher &&
          !includeMatcher.test(relativePath) &&
          !includeMatcher.test(basename(relativePath))
        ) {
          continue;
        }
        const found = await searchFile(
          file,
          relativePath,
          matchesLine,
          maxResults - results.length
        );
        if (found.skipped) {
          skippedFiles += 1;
        }
        results.push(...found.matches);
        if (results.length >= maxResults) {
          return truncateToolOutput(
            `OK - ${results.length}+ match(es), truncated${skippedNote(skippedFiles)}\n${results.join("\n")}`
          );
        }
      }
      const walkNote = walkTruncated ? ", file scan truncated" : "";
      return truncateToolOutput(
        `OK - ${results.length} match(es)${walkNote}${skippedNote(skippedFiles)}\n${results.join("\n")}`
      );
    },
  });
}
