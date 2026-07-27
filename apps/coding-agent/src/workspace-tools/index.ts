import type { ToolSet } from "ai";
import { createDeleteFileTool } from "./delete-file";
import { createEditFileTool } from "./edit-file";
import { createGlobFilesTool } from "./glob-files";
import { createGrepFilesTool } from "./grep-files";
import { createReadFileTool } from "./read-file";
import { createShellExecuteTool } from "./shell-execute";
import { createWriteFileTool } from "./write-file";

export interface CreateWorkspaceToolsOptions {
  readonly workspace: string;
}

export function createWorkspaceTools({
  workspace,
}: CreateWorkspaceToolsOptions): ToolSet {
  return {
    read_file: createReadFileTool(workspace),
    glob_files: createGlobFilesTool(workspace),
    grep_files: createGrepFilesTool(workspace),
    edit_file: createEditFileTool(workspace),
    write_file: createWriteFileTool(workspace),
    delete_file: createDeleteFileTool(workspace),
    shell_execute: createShellExecuteTool(workspace),
  };
}
