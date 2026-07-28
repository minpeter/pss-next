export interface ParsedMarkdownDocument {
  readonly body: string;
  readonly metadata: Readonly<Record<string, string>>;
}

const FRONTMATTER_OPEN = /^---\r?\n/;
const FRONTMATTER_CLOSE = /\r?\n---(?:\r?\n|$)/;
const METADATA_LINE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
const LINE_BREAK = /\r?\n/;

/**
 * Parse an optional `---` frontmatter block of simple `key: value` string
 * pairs. Unknown or malformed lines are ignored rather than rejected so a
 * hand-edited resource file degrades to "no metadata" instead of failing
 * the whole discovery pass.
 */
export function parseMarkdownFrontmatter(
  content: string
): ParsedMarkdownDocument {
  if (!FRONTMATTER_OPEN.test(content)) {
    return { body: content, metadata: {} };
  }
  const afterOpen = content.replace(FRONTMATTER_OPEN, "");
  const closeMatch = FRONTMATTER_CLOSE.exec(afterOpen);
  if (closeMatch === null || closeMatch.index === undefined) {
    return { body: content, metadata: {} };
  }
  const block = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const metadata: Record<string, string> = {};
  for (const line of block.split(LINE_BREAK)) {
    const match = METADATA_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    if (key === undefined || Object.hasOwn(metadata, key)) {
      continue;
    }
    metadata[key] = stripQuotes((match[2] ?? "").trim());
  }
  return { body, metadata: Object.freeze(metadata) };
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
