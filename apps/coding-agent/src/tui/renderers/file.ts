import type { BaseToolCallView } from "../tool-call-view";
import { groupStartLine, parseDiffSection, renderDiffGroup } from "./diff";
import { highlightCode } from "./highlight";
import {
  isRecord,
  normalizedLines,
  numberField,
  renderToolError,
  stringField,
} from "./utils";

const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

const HASHLINE_ANCHOR_PATTERN = /^\d+#[A-Z]+\|/gm;

const stripHashlineAnchors = (text: string): string =>
  text.replace(HASHLINE_ANCHOR_PATTERN, "");

interface EditOp {
  end?: string;
  lines: string | string[];
  op: "append" | "prepend" | "replace";
  pos?: string;
}

const isEditOp = (value: unknown): value is EditOp => {
  if (!isRecord(value)) {
    return false;
  }
  const op = value.op;
  const lines = value.lines;
  const hasValidLines =
    typeof lines === "string" ||
    (Array.isArray(lines) &&
      lines.every((line): line is string => typeof line === "string"));
  return (
    (op === "replace" || op === "append" || op === "prepend") && hasValidLines
  );
};

const editedLine = (line: string): string =>
  `${ANSI_GREEN}${line}${ANSI_RESET}`;

const formatEditHunk = (edit: EditOp): string =>
  normalizedLines(
    Array.isArray(edit.lines) ? edit.lines.join("\n") : edit.lines
  )
    .map(editedLine)
    .join("\n");

const summarizeEdits = (edits: EditOp[]): string =>
  edits.map(formatEditHunk).join("\n\n");

const looksLikeHeaderLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("====") &&
    (trimmed.endsWith("====") || trimmed.includes("===="))
  );
};

const buildDisplayContent = (params: {
  content: string;
  stripHeaders: boolean;
}): string => {
  const lines = normalizedLines(params.content);
  if (!params.stripHeaders) {
    return lines.join("\n");
  }
  const filtered: string[] = [];
  let headerRun = 0;
  for (const line of lines) {
    if (looksLikeHeaderLine(line)) {
      headerRun += 1;
      continue;
    }
    if (headerRun > 0 && line.trim().length === 0) {
      continue;
    }
    headerRun = 0;
    filtered.push(line);
  }
  return filtered.join("\n");
};

const getReadHeaderSuffix = (input: Record<string, unknown>): string => {
  const parts: string[] = [];
  if (numberField(input, "offset") !== undefined) {
    parts.push(`offset: ${numberField(input, "offset")}`);
  }
  if (numberField(input, "limit") !== undefined) {
    parts.push(`limit: ${numberField(input, "limit")}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
};

export const renderReadFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  if (renderToolError(view, "read")) {
    return;
  }

  const outputText = typeof output === "string" ? output : undefined;
  const isDirectory = outputText?.startsWith("OK - directory") === true;
  const header = `**read${isDirectory ? " dir" : ""}** \`${path}\`${getReadHeaderSuffix(input)}`;

  if (outputText === undefined) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(outputText);
  if (isDirectory) {
    view.setPrettyBlock(header, lines.slice(2).join("\n"), {
      useBackground: false,
    });
    return;
  }

  // "OK - file", "path:", "file_hash:", "lines:" precede the hashline body.
  view.setPrettyBlock(
    header,
    highlightCode(stripHashlineAnchors(lines.slice(4).join("\n"))),
    { allowAnsi: true }
  );
};

export const renderWriteFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  const content = input.content;
  if (!(path && typeof content === "string")) {
    return;
  }
  if (renderToolError(view, "write")) {
    return;
  }

  view.setPrettyBlock(
    `**write** \`${path}\``,
    typeof output === "string" && output.startsWith("OK - wrote")
      ? buildDisplayContent({ content, stripHeaders: false })
      : ""
  );
};

export const renderEditFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  if (renderToolError(view, "edit")) {
    return;
  }

  const diffGroups =
    typeof output === "string" ? parseDiffSection(output) : undefined;
  if (diffGroups !== undefined) {
    // Present hunks in file order regardless of the model's edits order.
    const sortedGroups = [...diffGroups].sort(
      (left, right) => groupStartLine(left) - groupStartLine(right)
    );
    view.setPrettyBlock(
      `**edit** \`${path}\``,
      sortedGroups.map(renderDiffGroup).join("\n\n"),
      { allowAnsi: true, useBackground: false }
    );
    return;
  }

  const editsValue = input.edits;
  const edits = Array.isArray(editsValue) ? editsValue.filter(isEditOp) : [];
  const body = edits.length > 0 ? summarizeEdits(edits) : "";

  view.setPrettyBlock(`**edit** \`${path}\``, body, {
    allowAnsi: true,
    useBackground: false,
  });
};

export const renderDeleteFile = (
  view: BaseToolCallView,
  input: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  if (renderToolError(view, "delete")) {
    return;
  }
  view.setPrettyBlock(`**delete** \`${path}\``, "");
};
