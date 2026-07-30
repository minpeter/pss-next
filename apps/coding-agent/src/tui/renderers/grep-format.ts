const MATCH_LINE = /^(?<path>[^:]+):(?<line>\d+)#[A-Za-z]{2}\|(?<text>.*)$/u;

interface FileMatches {
  readonly matches: { line: string; text: string }[];
  readonly path: string;
}

export const formatGrepMatches = (lines: readonly string[]): string => {
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
    const rows = matches.map(
      ({ line, text }) => `  ${line.padStart(width)}  ${text.trim()}`
    );
    return [path, ...rows].join("\n");
  });

  return [...blocks, ...passthrough].join("\n\n");
};
