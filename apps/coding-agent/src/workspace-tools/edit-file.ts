import { readFile } from "node:fs/promises";
import { type Tool, tool } from "ai";
import { z } from "zod";
import {
  computeFileHash,
  formatLineAnchor,
  resolveLineAnchor,
} from "./hashline";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";
import { atomicWrite } from "./write-file";

const editSchema = z
  .object({
    op: z.enum(["replace", "append", "prepend"]),
    /** Single-line replace anchor, and the insertion point for append/prepend. */
    target: z.string().optional(),
    /** Inclusive range start for replace. Pair with `last`. */
    first: z.string().optional(),
    /** Inclusive range end for replace. Pair with `first`. */
    last: z.string().optional(),
    new_content: z.union([z.string().min(1), z.array(z.string()).min(1)]),
  })
  .strict();
const END_OF_LINE_PATTERN = /\r?\n/u;
const inputSchema = z
  .object({
    path: z.string().min(1),
    expected_file_hash: z.string().length(8).optional(),
    edits: z.array(editSchema).min(1).max(100),
  })
  .strict();

type EditInput = z.infer<typeof editSchema>;

interface ResolvedEdit {
  readonly end: number;
  readonly index: number;
  readonly lines: readonly string[];
  readonly op: EditInput["op"];
  readonly order: number;
}

function replacementLines(
  value: string | readonly string[]
): readonly string[] {
  if (value.length === 0) {
    throw new Error(
      "new_content must not be empty; provide at least one line."
    );
  }
  if (typeof value !== "string") {
    return value;
  }
  const lines = value.split(END_OF_LINE_PATTERN);
  return value.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function resolveEdit(
  edit: EditInput,
  lines: readonly string[],
  order: number
): ResolvedEdit {
  if (edit.op !== "replace") {
    const anchorIndex =
      edit.target === undefined
        ? undefined
        : resolveLineAnchor(edit.target, lines);
    const index =
      edit.op === "append"
        ? (anchorIndex ?? lines.length - 1) + 1
        : (anchorIndex ?? 0);
    return {
      end: index - 1,
      index,
      lines: replacementLines(edit.new_content),
      op: edit.op,
      order,
    };
  }
  if (edit.first !== undefined || edit.last !== undefined) {
    if (edit.target !== undefined) {
      throw new Error(
        "replace accepts either target for one line or first+last for a range, not both."
      );
    }
    if (edit.first === undefined) {
      throw new Error(
        `replace range requires first; received only last=${edit.last}. Use target for one line, or first+last for an inclusive range.`
      );
    }
    if (edit.last === undefined) {
      throw new Error(
        `replace range requires last; received only first=${edit.first}. Use target for one line, or first+last for an inclusive range.`
      );
    }
    const index = resolveLineAnchor(edit.first, lines);
    const end = resolveLineAnchor(edit.last, lines);
    if (end < index) {
      throw new Error(
        `replace last precedes first: ${edit.first}..${edit.last}`
      );
    }
    return {
      end,
      index,
      lines: replacementLines(edit.new_content),
      op: edit.op,
      order,
    };
  }
  if (edit.target === undefined) {
    throw new Error(
      "replace requires target: LINE#ID for one line, or first+last for an inclusive range."
    );
  }
  const index = resolveLineAnchor(edit.target, lines);
  return {
    end: index,
    index,
    lines: replacementLines(edit.new_content),
    op: edit.op,
    order,
  };
}

function assertNoOverlappingReplacements(edits: readonly ResolvedEdit[]): void {
  const replacements = edits
    .filter((edit) => edit.op === "replace")
    .sort((left, right) => left.index - right.index);
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (previous && current && current.index <= previous.end) {
      throw new Error("Overlapping replace ranges are not allowed.");
    }
  }
}

function assertNoIntersectingInsertions(edits: readonly ResolvedEdit[]): void {
  const replacements = edits.filter((edit) => edit.op === "replace");
  for (const insertion of edits) {
    if (insertion.op === "replace") {
      continue;
    }
    for (const replacement of replacements) {
      if (
        insertion.index >= replacement.index &&
        insertion.index <= replacement.end
      ) {
        throw new Error(
          "Insertion intersects a replace range; split it into a separate edit_file call."
        );
      }
    }
  }
}

function applyEdits(
  lines: readonly string[],
  edits: readonly ResolvedEdit[]
): string[] {
  const output = [...lines];
  const ordered = [...edits].sort(
    (left, right) => right.index - left.index || right.order - left.order
  );
  for (const edit of ordered) {
    const deleteCount = edit.op === "replace" ? edit.end - edit.index + 1 : 0;
    output.splice(edit.index, deleteCount, ...edit.lines);
  }
  return output;
}

const netLineChange = (edit: ResolvedEdit): number => {
  const removedLineCount =
    edit.op === "replace" ? edit.end - edit.index + 1 : 0;
  return edit.lines.length - removedLineCount;
};

const finalStartIndex = (
  edit: ResolvedEdit,
  resolvedEdits: readonly ResolvedEdit[]
): number =>
  edit.index +
  resolvedEdits
    .filter(
      (candidate) =>
        candidate.index < edit.index ||
        (candidate.index === edit.index && candidate.order < edit.order)
    )
    .reduce((shift, candidate) => shift + netLineChange(candidate), 0);

const buildDiffSectionLines = (
  resolvedEdits: readonly ResolvedEdit[],
  sourceLines: readonly string[]
): string[] => {
  const diffLines: string[] = [];
  for (const [editIndex, resolved] of resolvedEdits.entries()) {
    diffLines.push(`@@ edit ${editIndex + 1}`);
    if (resolved.op === "replace") {
      for (
        let lineIndex = resolved.index;
        lineIndex <= resolved.end;
        lineIndex += 1
      ) {
        const sourceLine = sourceLines[lineIndex] ?? "";
        diffLines.push(
          `-${formatLineAnchor(lineIndex + 1, sourceLine)}|${sourceLine}`
        );
      }
    }
    const addedStartIndex = finalStartIndex(resolved, resolvedEdits);
    for (const [offset, line] of resolved.lines.entries()) {
      const lineNumber = addedStartIndex + 1 + offset;
      diffLines.push(`+${formatLineAnchor(lineNumber, line)}|${line}`);
    }
  }
  return diffLines;
};

export function createEditFileTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Apply deterministic plugsuits-style hashline edits. Re-read the file, then use LINE#ID anchors. replace addresses one line with target, or an inclusive range with first+last; append/prepend insert relative to an optional target.",
    inputSchema,
    execute: async ({ path, expected_file_hash: expectedHash, edits }) => {
      for (const edit of edits) {
        if (
          edit.op !== "replace" &&
          (edit.first !== undefined || edit.last !== undefined)
        ) {
          throw new Error(
            `${edit.op} does not support first/last; it inserts at an optional target anchor.`
          );
        }
      }
      const resolved = await resolveWorkspacePath(workspace, path);
      const absolutePath = resolved.path;
      const original = await readFile(absolutePath, "utf8");
      const originalHash = computeFileHash(original);
      if (expectedHash !== undefined && expectedHash !== originalHash) {
        throw new Error(
          `Stale file hash ${expectedHash}; current hash is ${originalHash}.`
        );
      }
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const trailingNewline = original.endsWith("\n");
      const sourceLines =
        original === "" ? [] : original.split(END_OF_LINE_PATTERN);
      if (trailingNewline) {
        sourceLines.pop();
      }
      const resolvedEdits = edits.map((edit, order) =>
        resolveEdit(edit, sourceLines, order)
      );
      assertNoOverlappingReplacements(resolvedEdits);
      assertNoIntersectingInsertions(resolvedEdits);
      const outputLines = applyEdits(sourceLines, resolvedEdits);
      const output = `${outputLines.join(eol)}${trailingNewline && outputLines.length > 0 ? eol : ""}`;
      await atomicWrite(absolutePath, output, originalHash);

      const diffLines = buildDiffSectionLines(resolvedEdits, sourceLines);

      return truncateToolOutput(
        [
          "OK - edited file",
          `path: ${workspaceRelativePath(resolved.root, absolutePath)}`,
          `edits: ${edits.length}`,
          `file_hash: ${computeFileHash(output)}`,
          "diff:",
          ...diffLines,
        ].join("\n")
      );
    },
  });
}
