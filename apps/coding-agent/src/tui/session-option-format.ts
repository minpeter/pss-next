import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  sessionDisplayKey,
  sessionDisplayLabel,
  sessionDisplayTitle,
} from "../sessions/session-display";
import type { SessionIndexEntry } from "../sessions/session-index";
import { sanitizeTerminalText } from "./terminal-safety";

export const SESSION_PRIMARY_COLUMN_WIDTH = 30;
const SESSION_KEY_COLUMN_WIDTH = 9;

export const sessionPrimaryLabel = (
  entry: SessionIndexEntry,
  width = SESSION_PRIMARY_COLUMN_WIDTH
): string => {
  const rawKey = sanitizeTerminalText(sessionDisplayKey(entry));
  const key = truncateToWidth(rawKey, SESSION_KEY_COLUMN_WIDTH);
  const paddedKey = `${key}${" ".repeat(Math.max(0, SESSION_KEY_COLUMN_WIDTH - visibleWidth(key)))}`;
  const separator = "  ";
  const reservedWidth = visibleWidth(separator) + SESSION_KEY_COLUMN_WIDTH;
  if (width <= reservedWidth) {
    return truncateToWidth(
      sanitizeTerminalText(sessionDisplayLabel(entry)),
      width
    );
  }
  const title = truncateToWidth(
    sanitizeTerminalText(sessionDisplayTitle(entry)),
    width - reservedWidth
  );
  const titleWidth = width - reservedWidth;
  const paddedTitle = `${title}${" ".repeat(Math.max(0, titleWidth - visibleWidth(title)))}`;
  return `${paddedTitle}${separator}${paddedKey}`;
};
