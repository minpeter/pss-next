import { stat } from "node:fs/promises";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";
import { globPatternToRegExp, walkWorkspaceFiles } from "./walk";

const inputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    include_ignored: z.boolean().optional(),
    max_results: z.number().int().positive().max(2000).optional(),
  })
  .strict();

export function createGlobFilesTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Find workspace files by glob pattern. Supports *, **, and ?. Defaults to excluding .git, node_modules, .next, dist, and coverage.",
    inputSchema,
    execute: async ({
      pattern,
      path = ".",
      include_ignored: includeIgnored = false,
      max_results: maxResults = 500,
    }) => {
      const resolved = await resolveWorkspacePath(workspace, path);
      const startPath = resolved.path;
      if (!(await stat(startPath)).isDirectory()) {
        throw new Error(`Glob path is not a directory: ${path}`);
      }
      const matcher = globPatternToRegExp(pattern);
      const { files, truncated } = await walkWorkspaceFiles(
        resolved.root,
        startPath,
        includeIgnored
      );
      const matches = files
        .filter((file) => matcher.test(workspaceRelativePath(startPath, file)))
        .map((file) => workspaceRelativePath(resolved.root, file))
        .sort();
      const limited = matches.slice(0, maxResults);
      const hasMore = truncated || matches.length > limited.length;
      const count = hasMore ? `${limited.length}+` : `${limited.length}`;
      const suffix = hasMore ? ", truncated" : "";
      return truncateToolOutput(
        `OK - ${count} file(s)${suffix}\n${limited.join("\n")}`
      );
    },
  });
}
