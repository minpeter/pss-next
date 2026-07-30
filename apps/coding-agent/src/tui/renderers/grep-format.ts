const MATCH_LINE = /^(?<path>[^:]+):(?<line>\d+)#[A-Za-z]{2}\|(?<text>.*)$/u;
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/gu;

const ANSI_RESET = "\x1b[0m";
const ANSI_PATH = "\x1b[36m";
const ANSI_LINE_NUMBER = "\x1b[90m";
const ANSI_MATCH = "\x1b[1m\x1b[33m";

interface FileMatches {
  readonly matches: { line: string; text: string }[];
  readonly path: string;
}

const highlightPattern = (text: string, pattern: string): string => {
  if (pattern.length === 0) {
    return text;
  }
  const escaped = pattern.replace(REGEX_METACHARACTERS, "\\$&");
  return text.replace(
    new RegExp(escaped, "giu"),
    (hit) => `${ANSI_MATCH}${hit}${ANSI_RESET}`
  );
};

export const formatGrepMatches = (
  lines: readonly string[],
  pattern: string
): string => {
  const groups: FileMatches[] = [];
  const passthrough: string[] = [];

  for (const line of lines) {
    const parsed = MATCH_LINE.exec(line)?.groups;
    if (parsed === undefined) {
      passthrough.push(line);
      continue;
    }
    const existing = groups.find((group) => group.path === parsed.path);
    const entry = { line: parsed.line ?? "", text: parsed.text ?? "" };
    if (existing === undefined) {
      groups.push({ matches: [entry], path: parsed.path ?? "" });
    } else {
      existing.matches.push(entry);
    }
  }

  const blocks = groups.map(({ matches, path }) => {
    const width = Math.max(...matches.map(({ line }) => line.length));
    const rows = matches.map(({ line, text }) => {
      const number = `${ANSI_LINE_NUMBER}${line.padStart(width)}${ANSI_RESET}`;
      return `  ${number}  ${highlightPattern(text.trim(), pattern)}`;
    });
    return [`${ANSI_PATH}${path}${ANSI_RESET}`, ...rows].join("\n");
  });

  return [...blocks, ...passthrough].join("\n\n");
};
