import type { BaseToolCallView } from "@minpeter/pss-coding-agent/extension";

const MAX_SINGLE_LINE = 200;
const FETCH_TEXT_PREVIEW_LIMIT = 1500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (obj: unknown, key: string): string | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  const half = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
};

const renderToolError = (view: BaseToolCallView, toolName: string): boolean => {
  const error = view.getError();
  if (error === undefined) {
    return false;
  }
  const body =
    typeof error === "string" ? error : JSON.stringify(error, null, 2);
  view.setPrettyBlock(`**${toolName}** error`, body, { isError: true });
  return true;
};

export const renderWebSearch = (
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

export const renderWebFetch = (
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
