import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { EditFormat } from "../formats";
import { readWorkspaceText, writeWorkspaceText } from "./fs";
import type { EditMethod, EditMethodId, MethodToolHooks } from "./types";
import { wrapMethodTool } from "./wrap";

const readSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

const sharedRules = [
  "This benchmark exposes only read_file and edit_file as tools.",
  "Use the tools; never print edit payloads as plain assistant text.",
  "Read the target file before editing.",
  "The score compares the entire workspace byte-for-byte; preserve every unrequested byte and never create extra files.",
  "After an edit, inspect the tool result. If the task is not complete, call read_file again and retry.",
  "Return a short final response only after the target file matches the task.",
].join("\n");

const ompDslEditSchema = z
  .object({
    path: z.string().min(1),
    patch: z.string().min(1),
  })
  .strict();

const ompJsonEditSchema = z
  .object({
    file_path: z.string().min(1),
    tag: z.string().regex(/^[0-9A-F]{4}$/u),
    hunks: z
      .array(
        z
          .object({
            op: z.string().min(1),
            line: z.number().int().min(1).optional(),
            first: z.number().int().min(1).optional(),
            last: z.number().int().min(1).optional(),
            content: z.string().optional(),
            dest: z.string().min(1).optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();

const grokEditSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            op: z.enum(["replace", "insert_after", "write"]),
            anchor: z.string().optional(),
            end_anchor: z.string().optional(),
            content: z.string(),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();

type EditReplyBuilder = (input: unknown) => string;

const createFormatTools = (
  format: EditFormat,
  workspace: string,
  hooks: MethodToolHooks,
  editSchema: z.ZodTypeAny,
  editDescription: string,
  toReply: EditReplyBuilder
): ToolSet => {
  const readBase = tool({
    description:
      "Read a UTF-8 file with this method's line presentation. Read before editing.",
    inputSchema: readSchema,
    execute: async ({ path }) => {
      const file = await readWorkspaceText(workspace, path);
      return format.render(file.relative, file.content).user;
    },
  });

  const editBase = tool({
    description: editDescription,
    inputSchema: editSchema,
    execute: async (input) => {
      let path = hooks.targetPath;
      if (
        typeof input === "object" &&
        input !== null &&
        "path" in input &&
        typeof input.path === "string"
      ) {
        path = input.path;
      } else if (
        typeof input === "object" &&
        input !== null &&
        "file_path" in input &&
        typeof input.file_path === "string"
      ) {
        path = input.file_path;
      }
      const file = await readWorkspaceText(workspace, path);
      const outcome = format.apply(toReply(input), file.content, file.relative);
      if (outcome.error !== undefined) {
        throw new Error(outcome.error);
      }
      if (outcome.text === undefined) {
        throw new Error("Edit produced no text");
      }
      await writeWorkspaceText(workspace, path, outcome.text);
      return outcome.toolOutput ?? "OK - edited file";
    },
  });

  return {
    edit_file: wrapMethodTool("edit_file", editBase, hooks, workspace),
    read_file: wrapMethodTool("read_file", readBase, hooks, workspace),
  };
};

export const createFormatMethod = (
  id: EditMethodId,
  format: EditFormat,
  options: {
    readonly editDescription: string;
    readonly editSchema: z.ZodTypeAny;
    readonly instructionsExtra: string;
    readonly toReply: EditReplyBuilder;
  }
): EditMethod => ({
  id,
  instructions: [sharedRules, "", options.instructionsExtra].join("\n"),
  createTools(workspace: string, hooks: MethodToolHooks): ToolSet {
    return createFormatTools(
      format,
      workspace,
      hooks,
      options.editSchema,
      options.editDescription,
      options.toReply
    );
  },
});

export const ompDslMethodOptions = {
  editDescription:
    "Apply one hashline DSL patch to a file. Line numbers refer to the original file.",
  editSchema: ompDslEditSchema,
  instructionsExtra: [
    "read_file shows [PATH#TAG] and N:content lines.",
    "edit_file takes { path, patch } where patch is the full DSL body starting with [PATH#TAG].",
    "Ops: SWAP N.=M:, DEL N.=M, INS.PRE N:, INS.POST N:, INS.HEAD:, INS.TAIL:, plus block variants.",
  ].join("\n"),
  toReply: (input: unknown) => {
    const parsed = ompDslEditSchema.parse(input);
    return parsed.patch;
  },
};

export const ompJsonMethodOptions = {
  editDescription:
    "Apply structured hashline JSON hunks (swap/insert/delete/…) to a file.",
  editSchema: ompJsonEditSchema,
  instructionsExtra: [
    "read_file shows [PATH#TAG] and N:content lines.",
    "edit_file takes { file_path, tag, hunks:[{op,...}] } with original-file line numbers.",
    "ops: swap, swap_block, insert_pre/post/head/tail/block_after, delete, delete_block, remove, move.",
  ].join("\n"),
  toReply: (input: unknown) => JSON.stringify(ompJsonEditSchema.parse(input)),
};

export const grokMethodOptions = {
  editDescription:
    "Apply grok-style chunk-fingerprint edits (replace/insert_after/write).",
  editSchema: grokEditSchema,
  instructionsExtra: [
    "read_file shows ANCHOR→CONTENT lines with chunk fingerprints.",
    "edit_file takes { edits:[{op, anchor?, end_anchor?, content}] }.",
    "op is replace, insert_after, or write. Never invent anchors.",
  ].join("\n"),
  toReply: (input: unknown) => JSON.stringify(grokEditSchema.parse(input)),
};
