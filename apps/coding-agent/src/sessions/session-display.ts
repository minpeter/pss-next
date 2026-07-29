import type { SessionIndexEntry } from "./session-index";

export const sessionDisplayLabel = (entry: SessionIndexEntry): string =>
  `${sessionDisplayTitle(entry)} · ${sessionDisplayKey(entry)}`;

export const sessionDisplayKey = (entry: SessionIndexEntry): string =>
  sessionShortKey(entry.key);

export const sessionDisplayTitle = (entry: SessionIndexEntry): string =>
  entry.name ?? "untitled";

export const sessionUpdatedLabel = (entry: SessionIndexEntry): string =>
  `updated ${entry.updatedAt.slice(0, 16).replace("T", " ")}`;

const sessionShortKey = (key: string): string => {
  const separator = key.lastIndexOf("#");
  if (separator >= 0) {
    return `#${key.slice(separator + 1)}`;
  }
  return key.startsWith("cwd:") ? "legacy" : key;
};
