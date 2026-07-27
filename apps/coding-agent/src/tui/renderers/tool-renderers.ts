import type { BaseToolCallView, ToolRendererMap } from "../tool-call-view";
import {
  renderDeleteFile,
  renderEditFile,
  renderReadFile,
  renderWriteFile,
} from "./file";
import {
  isRecord,
  normalizedLines,
  renderToolError,
  stringField,
} from "./utils";

const MAX_SINGLE_LINE = 200;
const FETCH_TEXT_PREVIEW_LIMIT = 1500;

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  const half = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
};

const renderGlobFiles = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const pattern = stringField(input, "pattern");
  if (!pattern) {
    return;
  }
  if (renderToolError(view, "glob")) {
    return;
  }

  const path = stringField(input, "path");
  const header = `**glob** \`${pattern}\`${path ? ` (path: ${path})` : ""}`;

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(output);
  view.setPrettyBlock(header, lines.slice(1).join("\n"), {
    useBackground: false,
  });
};

const renderGrepFiles = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const pattern = stringField(input, "pattern");
  if (!pattern) {
    return;
  }
  if (renderToolError(view, "grep")) {
    return;
  }

  const context: string[] = [];
  const path = stringField(input, "path");
  if (path) {
    context.push(`path: ${path}`);
  }
  const include = stringField(input, "include");
  if (include) {
    context.push(`include: ${include}`);
  }
  const header = `**grep** \`${pattern}\`${context.length > 0 ? ` (${context.join(", ")})` : ""}`;

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(output);
  view.setPrettyBlock(header, lines.slice(1).join("\n"), {
    useBackground: false,
  });
};

const renderShellExecute = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const command = stringField(input, "command");
  if (!command) {
    return;
  }
  if (renderToolError(view, "bash")) {
    return;
  }

  const displayCommand = truncateMiddle(toSingleLine(command), MAX_SINGLE_LINE);

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(`**bash** \`${displayCommand}\``, "");
    return;
  }

  const lines = normalizedLines(output);
  const isErrorOutput =
    output.startsWith("ERROR") ||
    lines[1]?.startsWith("exit_code: 0") === false;
  const exitCodeLine = lines[1]?.startsWith("exit_code: ")
    ? lines[1].slice("exit_code: ".length).trim()
    : undefined;
  const headerSuffix =
    exitCodeLine !== undefined && exitCodeLine !== "0"
      ? `  (exit ${exitCodeLine})`
      : "";
  // "OK|ERROR - ...", "exit_code:", "signal:", "stdout:" precede the body.
  const body = lines.slice(4).join("\n");

  view.setPrettyBlock(`**bash** \`${displayCommand}\`${headerSuffix}`, body, {
    isError: isErrorOutput,
  });
};

const renderWebSearch = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const query = stringField(input, "query");
  if (!query) {
    return;
  }
  if (renderToolError(view, "web_search")) {
    return;
  }

  const header = `**web_search** \`${truncateMiddle(toSingleLine(query), MAX_SINGLE_LINE)}\``;
  if (output === undefined) {
    view.setPrettyBlock(header, "");
    return;
  }
  if (!Array.isArray(output)) {
    return;
  }

  const body =
    output.length === 0
      ? "No results."
      : output
          .map((result, index) => {
            const title = stringField(result, "title");
            const url = stringField(result, "url") ?? "";
            const snippet = stringField(result, "snippet");
            const lines = [`${index + 1}. ${title ?? url}`];
            if (title && url) {
              lines.push(`   ${url}`);
            }
            if (snippet) {
              lines.push(`   ${toSingleLine(snippet)}`);
            }
            return lines.join("\n");
          })
          .join("\n\n");

  view.setPrettyBlock(header, body);
};

const renderWebFetch = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const urlsValue = input.urls;
  const urls = Array.isArray(urlsValue)
    ? urlsValue.filter((url): url is string => typeof url === "string")
    : [];
  if (urls.length === 0) {
    return;
  }
  if (renderToolError(view, "web_fetch")) {
    return;
  }

  const header =
    urls.length === 1
      ? `**web_fetch** \`${truncateMiddle(urls[0], MAX_SINGLE_LINE)}\``
      : `**web_fetch** \`${urls.length} urls\``;
  if (output === undefined) {
    view.setPrettyBlock(header, "");
    return;
  }
  if (!Array.isArray(output)) {
    return;
  }

  const body = output
    .map((result, index) => {
      const url = stringField(result, "url") ?? urls[index] ?? "(unknown url)";
      const title = stringField(result, "title");
      const text = stringField(result, "content") ?? "";
      const truncated = text.length > FETCH_TEXT_PREVIEW_LIMIT;
      const preview = truncated
        ? `${text.slice(0, FETCH_TEXT_PREVIEW_LIMIT)}\n… (truncated, ${text.length} chars total)`
        : text;
      return [title === undefined ? url : `${url}\n# ${title}`, preview].join(
        "\n"
      );
    })
    .join("\n\n");

  view.setPrettyBlock(header, body);
};

/**
 * Pretty per-tool renderers for the pss coding-agent tool surface.
 * Renderers claim a tool view and replace the raw JSON block with a
 * header + ANSI-background body via `BaseToolCallView.setPrettyBlock`.
 */
export function createToolRenderers(): ToolRendererMap {
  return {
    delete_file: renderDeleteFile,
    edit_file: renderEditFile,
    glob_files: renderGlobFiles,
    grep_files: renderGrepFiles,
    read_file: renderReadFile,
    shell_execute: renderShellExecute,
    web_fetch: renderWebFetch,
    web_search: renderWebSearch,
    write_file: renderWriteFile,
  };
}
