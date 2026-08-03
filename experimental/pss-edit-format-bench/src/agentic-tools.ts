import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { createWorkspaceTools } from "@minpeter/pss-coding-agent";
import type { AgenticToolEvent } from "./agentic";
import type { AgenticTraceSink } from "./agentic-trace";
import type { EditTask } from "./tasks";

interface AgenticToolsOptions {
  readonly events: AgenticToolEvent[];
  readonly requestAttempt: number;
  readonly run: number;
  readonly task: EditTask;
  readonly trace: AgenticTraceSink | undefined;
  readonly workspace: string;
}

const stringify = (value: unknown): string => JSON.stringify(value) ?? "null";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const outputText = async (
  output: string | AsyncIterable<string>
): Promise<string> => {
  if (typeof output === "string") {
    return output;
  }
  const chunks: string[] = [];
  for await (const chunk of output) {
    chunks.push(chunk);
  }
  return chunks.join("");
};

export const createAgenticTools = (options: AgenticToolsOptions) => {
  const { events, requestAttempt, run, task, trace, workspace } = options;
  const workspaceTools = createWorkspaceTools({ workspace });
  const readFileTool = workspaceTools.read_file;
  const editFileTool = workspaceTools.edit_file;
  if (readFileTool === undefined || editFileTool === undefined) {
    throw new Error("Workspace tools must include read_file and edit_file");
  }
  const readExecute = readFileTool.execute;
  const editExecute = editFileTool.execute;
  if (readExecute === undefined || editExecute === undefined) {
    throw new Error("Workspace tools must provide execute functions");
  }
  return {
    edit_file: tool({
      description: editFileTool.description,
      inputSchema: editFileTool.inputSchema,
      execute: async (input, executionOptions) => {
        const inputJson = stringify(input);
        await trace?.({
          inputJson,
          name: "edit_file",
          requestAttempt,
          run,
          task: task.id,
          timestampMs: Date.now(),
          type: "tool_call",
        });
        try {
          const output = await outputText(
            await editExecute(input, executionOptions)
          );
          const fileAfter = await readFile(join(workspace, task.path), "utf8");
          events.push({
            fileAfter,
            inputJson,
            name: "edit_file",
            output,
          });
          await trace?.({
            name: "edit_file",
            output,
            requestAttempt,
            run,
            task: task.id,
            timestampMs: Date.now(),
            type: "tool_result",
          });
          return output;
        } catch (error) {
          const message = errorMessage(error);
          const output = `ERROR - ${message}`;
          events.push({
            error: message,
            inputJson,
            name: "edit_file",
            output,
          });
          await trace?.({
            error: message,
            name: "edit_file",
            output,
            requestAttempt,
            run,
            task: task.id,
            timestampMs: Date.now(),
            type: "tool_result",
          });
          return output;
        }
      },
    }),
    read_file: tool({
      description: readFileTool.description,
      inputSchema: readFileTool.inputSchema,
      execute: async (input, executionOptions) => {
        const inputJson = stringify(input);
        await trace?.({
          inputJson,
          name: "read_file",
          requestAttempt,
          run,
          task: task.id,
          timestampMs: Date.now(),
          type: "tool_call",
        });
        try {
          const output = await outputText(
            await readExecute(input, executionOptions)
          );
          events.push({
            inputJson,
            name: "read_file",
            output,
          });
          await trace?.({
            name: "read_file",
            output,
            requestAttempt,
            run,
            task: task.id,
            timestampMs: Date.now(),
            type: "tool_result",
          });
          return output;
        } catch (error) {
          const message = errorMessage(error);
          const output = `ERROR - ${message}`;
          events.push({
            error: message,
            inputJson,
            name: "read_file",
            output,
          });
          await trace?.({
            error: message,
            name: "read_file",
            output,
            requestAttempt,
            run,
            task: task.id,
            timestampMs: Date.now(),
            type: "tool_result",
          });
          return output;
        }
      },
    }),
  };
};
