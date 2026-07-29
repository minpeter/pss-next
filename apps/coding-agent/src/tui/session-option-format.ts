import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  sessionDisplayKey,
  sessionDisplayLabel,
  sessionDisplayTitle,
} from "../sessions/session-display";
import type { SessionIndexEntry } from "../sessions/session-index";
import { sanitizeTerminalText } from "./terminal-safety";

export const SESSION_PRIMARY_COLUMN_WIDTH = 30;

export const sessionPrimaryLabel = (
  entry: SessionIndexEntry,
  width = SESSION_PRIMARY_COLUMN_WIDTH
): string => {
  const key = sanitizeTerminalText(sessionDisplayKey(entry));
  const separator = "  ";
  const reservedWidth = visibleWidth(separator) + visibleWidth(key);
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
  return `${title}${separator}${key}`;
};
