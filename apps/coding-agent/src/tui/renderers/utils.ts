import { sanitizeTerminalText } from "../terminal-safety";
import type { BaseToolCallView } from "../tool-call-view";

export const ANSI_RESET = "\x1b[0m";
// Pretty-block bodies are re-wrapped in the gray background per line, so a
// colored token must restore fg-default + gray bg to keep the right padding
// from losing its background.
export const RESTORE_ON_GRAY_BG = "\x1b[39m\x1b[100m";

export const normalizedLines = (text: string): string[] =>
  sanitizeTerminalText(text).split("\n");

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const stringField = (obj: unknown, key: string): string | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const numberField = (obj: unknown, key: string): number | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

export const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return sanitizeTerminalText(value);
  }
  try {
    return sanitizeTerminalText(JSON.stringify(value, null, 2));
  } catch {
    return sanitizeTerminalText(String(value));
  }
};

export const renderToolError = (
  view: BaseToolCallView,
  toolName: string
): boolean => {
  const error = view.getError();
  if (error === undefined) {
    return false;
  }
  view.setPrettyBlock(`**${toolName}** error`, safeStringify(error), {
    isError: true,
  });
  return true;
};
