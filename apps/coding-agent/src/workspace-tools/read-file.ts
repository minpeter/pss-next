import { readdir, readFile, stat } from "node:fs/promises";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { computeFileHash, formatHashLine } from "./hashline";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";

const END_OF_LINE_PATTERN = /\r?\n/u;
const inputSchema = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(2000).optional(),
  })
  .strict();

export function createReadFileTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Read a UTF-8 file with plugsuits-compatible LINE#ID hashline anchors. Directories return a sorted listing. Read before editing.",
    inputSchema,
    execute: async ({ path, offset = 1, limit = 500 }) => {
      const resolved = await resolveWorkspacePath(workspace, path);
      const absolutePath = resolved.path;
      const metadata = await stat(absolutePath);
      if (metadata.isDirectory()) {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        const limited = entries.slice(0, 1000);
        const listing = limited
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .join("\n");
        const truncation =
          entries.length > limited.length
            ? `\n... showing ${limited.length} of ${entries.length} entries (truncated) ...`
            : "";
        return truncateToolOutput(
          `OK - directory\npath: ${workspaceRelativePath(resolved.root, absolutePath)}\n${listing}${truncation}`
        );
      }
      if (!metadata.isFile()) {
        throw new Error(`Not a regular file: ${path}`);
      }
      if (metadata.size > 2 * 1024 * 1024) {
        throw new Error(`File is larger than 2 MiB: ${path}`);
      }
      const content = await readFile(absolutePath, "utf8");
      const lines = content === "" ? [] : content.split(END_OF_LINE_PATTERN);
      if (content.endsWith("\n")) {
        lines.pop();
      }
      const start = Math.min(offset - 1, lines.length);
      const selected = lines.slice(start, start + limit);
      const rendered = selected
        .map((line, index) => formatHashLine(start + index + 1, line))
        .join("\n");
      const range =
        lines.length === 0
          ? "0/0"
          : `${start + 1}-${start + selected.length}/${lines.length}`;
      return truncateToolOutput(
        [
          "OK - file",
          `path: ${workspaceRelativePath(resolved.root, absolutePath)}`,
          `file_hash: ${computeFileHash(content)}`,
          `lines: ${range}`,
          rendered,
        ].join("\n")
      );
    },
  });
}
