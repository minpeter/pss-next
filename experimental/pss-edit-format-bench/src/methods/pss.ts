import { CODING_AGENT_INSTRUCTIONS } from "@minpeter/pss-coding-agent/instructions";
import { createWorkspaceTools } from "@minpeter/pss-coding-agent/workspace-tools";
import type { ToolSet } from "ai";
import type { EditMethod, MethodToolHooks } from "./types";
import { wrapMethodTool } from "./wrap";

const instructions = [
  CODING_AGENT_INSTRUCTIONS,
  "",
  "This benchmark exposes only read_file and edit_file.",
  "Use read_file and edit_file as actual tools; never print edit JSON as plain text.",
  "Read the target file before editing, then call edit_file with its exact anchors and file hash.",
  "For replace, use target for one line OR first and last for a range; never combine them.",
  "For prepend or append, use target and new_content only.",
  "The score compares the entire workspace byte-for-byte; preserve every unrequested byte and never create extra files.",
  "After an edit, inspect the tool result. If the task is not complete, call read_file again and retry.",
  "Return a short final response only after the target file matches the task.",
].join("\n");

export const pssMethod: EditMethod = {
  id: "pss-json",
  instructions,
  createTools(workspace: string, hooks: MethodToolHooks): ToolSet {
    const workspaceTools = createWorkspaceTools({ workspace });
    const readFileTool = workspaceTools.read_file;
    const editFileTool = workspaceTools.edit_file;
    if (readFileTool === undefined || editFileTool === undefined) {
      throw new Error("Workspace tools must include read_file and edit_file");
    }
    return {
      edit_file: wrapMethodTool("edit_file", editFileTool, hooks, workspace),
      read_file: wrapMethodTool("read_file", readFileTool, hooks, workspace),
    };
  },
};
