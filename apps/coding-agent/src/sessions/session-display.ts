import type { SessionIndexEntry } from "./session-index";

export const sessionDisplayLabel = (entry: SessionIndexEntry): string => {
  const shortKey = sessionShortKey(entry.key);
  return `${entry.name ?? "untitled"} · ${shortKey}`;
};

export const sessionUpdatedLabel = (entry: SessionIndexEntry): string =>
  `updated ${entry.updatedAt}`;

const sessionShortKey = (key: string): string => {
  const separator = key.lastIndexOf("#");
  if (separator >= 0) {
    return `#${key.slice(separator + 1)}`;
  }
  return key.startsWith("cwd:") ? "legacy" : key;
};
