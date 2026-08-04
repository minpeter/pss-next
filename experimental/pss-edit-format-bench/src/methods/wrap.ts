import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "ai";
import { tool } from "ai";
import type { AgenticToolName } from "../agentic";
import type { MethodToolHooks } from "./types";

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

/**
 * Wraps a tool so failures become recoverable `ERROR - …` strings (matching
 * the previous agentic harness) and every call is recorded for scoring/trace.
 */
export const wrapMethodTool = (
  name: AgenticToolName,
  // AI SDK Tool variants are a large union; keep the wrapper tolerant.
  base: {
    readonly description?: unknown;
    readonly execute?: (...args: never[]) => unknown;
    readonly inputSchema?: unknown;
  },
  hooks: MethodToolHooks,
  workspace: string
): Tool => {
  const execute = base.execute;
  if (execute === undefined) {
    throw new Error(`Tool ${name} must provide execute`);
  }
  if (base.inputSchema === undefined) {
    throw new Error(`Tool ${name} must provide inputSchema`);
  }
  const description =
    typeof base.description === "string" ? base.description : name;
  return tool({
    description,
    // biome-ignore lint/suspicious/noExplicitAny: AI SDK Tool schemas are heterogeneous across methods.
    inputSchema: base.inputSchema as any,
    execute: async (input, options) => {
      const inputJson = stringify(input);
      const { events, requestAttempt, run, task, trace } = hooks;
      await trace?.({
        inputJson,
        name,
        requestAttempt,
        run,
        task: task.id,
        timestampMs: Date.now(),
        type: "tool_call",
      });
      try {
        const raw = await execute(input as never, options as never);
        const output = await outputText(raw as string | AsyncIterable<string>);
        const fileAfter =
          name === "edit_file"
            ? await readFile(join(workspace, hooks.targetPath), "utf8").catch(
                () => undefined
              )
            : undefined;
        events.push({
          fileAfter,
          inputJson,
          name,
          output,
        });
        await trace?.({
          name,
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
          name,
          output,
        });
        await trace?.({
          error: message,
          name,
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
  });
};
