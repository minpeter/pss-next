import { sanitizeTerminalText } from "../terminal-safety";
import { boundedLcsMatches } from "./bounded-lcs";
import { normalizedLines, RESTORE_ON_GRAY_BG } from "./utils";

// senpi dark-theme syntax palette (VS Code Dark+ hues), truecolor.
const fgRgb = (r: number, g: number, b: number): string =>
  `\x1b[38;2;${r};${g};${b}m`;
const SYN_COMMENT = fgRgb(0x6a, 0x99, 0x55);
const SYN_KEYWORD = fgRgb(0x56, 0x9c, 0xd6);
const SYN_FUNCTION = fgRgb(0xdc, 0xdc, 0xaa);
const SYN_VARIABLE = fgRgb(0x9c, 0xdc, 0xfe);
const SYN_STRING = fgRgb(0xce, 0x91, 0x78);
const SYN_NUMBER = fgRgb(0xb5, 0xce, 0xa8);
const SYN_TYPE = fgRgb(0x4e, 0xc9, 0xb0);
const SYN_OPERATOR = fgRgb(0xd4, 0xd4, 0xd4);

export interface CodeToken {
  color: string;
  text: string;
}

const CODE_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

const CODE_TOKEN_PATTERN =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\\n]|\\.)*`?)|(\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;

const UPPERCASE_START_PATTERN = /^[A-Z]/;

const classifyWordToken = (word: string): string => {
  if (CODE_KEYWORDS.has(word)) {
    return SYN_KEYWORD;
  }
  if (UPPERCASE_START_PATTERN.test(word)) {
    return SYN_TYPE;
  }
  return SYN_VARIABLE;
};

export const tokenizeCode = (line: string): CodeToken[] => {
  const tokens: CodeToken[] = [];
  const sanitized = sanitizeTerminalText(line);
  CODE_TOKEN_PATTERN.lastIndex = 0;
  let match = CODE_TOKEN_PATTERN.exec(sanitized);
  while (match !== null) {
    const [text, comment, str, num, word] = match;
    if (comment !== undefined) {
      tokens.push({ color: SYN_COMMENT, text });
    } else if (str !== undefined) {
      tokens.push({ color: SYN_STRING, text });
    } else if (num !== undefined) {
      tokens.push({ color: SYN_NUMBER, text });
    } else if (word === undefined) {
      tokens.push({ color: SYN_OPERATOR, text });
    } else {
      tokens.push({ color: classifyWordToken(text), text });
    }
    match = CODE_TOKEN_PATTERN.exec(sanitized);
  }

  // identifiers directly followed by "(" are function calls
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (
      token.color === SYN_VARIABLE &&
      next !== undefined &&
      next.text.startsWith("(")
    ) {
      token.color = SYN_FUNCTION;
    }
  }

  return tokens;
};

const highlightCodeLine = (line: string): string =>
  tokenizeCode(line)
    .map((token) => `${token.color}${token.text}${RESTORE_ON_GRAY_BG}`)
    .join("");

export const highlightCode = (text: string): string =>
  normalizedLines(text).map(highlightCodeLine).join("\n");

export const markChangedTokens = (
  oldTokens: readonly string[],
  newTokens: readonly string[]
): { newChanged: boolean[]; oldChanged: boolean[] } => {
  const oldChanged = new Array<boolean>(oldTokens.length).fill(true);
  const newChanged = new Array<boolean>(newTokens.length).fill(true);
  for (const [oldIndex, newIndex] of boundedLcsMatches(oldTokens, newTokens)) {
    oldChanged[oldIndex] = false;
    newChanged[newIndex] = false;
  }

  return { newChanged, oldChanged };
};

export interface IntraTokenPart {
  changed: boolean;
  text: string;
}

const toIntraParts = (
  text: string,
  prefixLen: number,
  suffixLen: number
): IntraTokenPart[] =>
  [
    { changed: false, text: text.slice(0, prefixLen) },
    { changed: true, text: text.slice(prefixLen, text.length - suffixLen) },
    { changed: false, text: text.slice(text.length - suffixLen) },
  ].filter((part) => part.text.length > 0);

const splitIntraToken = (
  oldText: string,
  newText: string
): { newParts: IntraTokenPart[]; oldParts: IntraTokenPart[] } => {
  let prefixLen = 0;
  while (
    prefixLen < oldText.length &&
    prefixLen < newText.length &&
    oldText[prefixLen] === newText[prefixLen]
  ) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldText.length - prefixLen &&
    suffixLen < newText.length - prefixLen &&
    oldText.at(-1 - suffixLen) === newText.at(-1 - suffixLen)
  ) {
    suffixLen += 1;
  }

  return {
    newParts: toIntraParts(newText, prefixLen, suffixLen),
    oldParts: toIntraParts(oldText, prefixLen, suffixLen),
  };
};

const computeChangedRuns = (
  changed: readonly boolean[]
): [number, number][] => {
  const runs: [number, number][] = [];
  let start = -1;
  for (let index = 0; index <= changed.length; index += 1) {
    if (index < changed.length && changed[index]) {
      if (start < 0) {
        start = index;
      }
    } else if (start >= 0) {
      runs.push([start, index - 1]);
      start = -1;
    }
  }
  return runs;
};

/**
 * Pairs single-token changed runs between the old and new line so the
 * renderer can refine them intra-token (faint region + strong changed
 * characters) instead of highlighting the whole token.
 */
export const pairRefinements = (
  oldChanged: readonly boolean[],
  newChanged: readonly boolean[]
): { newPairs: Map<number, number>; oldPairs: Map<number, number> } => {
  const oldRuns = computeChangedRuns(oldChanged);
  const newRuns = computeChangedRuns(newChanged);
  const oldPairs = new Map<number, number>();
  const newPairs = new Map<number, number>();

  const pairCount = Math.min(oldRuns.length, newRuns.length);
  for (let pair = 0; pair < pairCount; pair += 1) {
    const [oldStart, oldEnd] = oldRuns[pair];
    const [newStart, newEnd] = newRuns[pair];
    if (oldStart === oldEnd && newStart === newEnd) {
      oldPairs.set(oldStart, newStart);
      newPairs.set(newStart, oldStart);
    }
  }

  return { newPairs, oldPairs };
};

export const computeRefinedParts = (
  tokens: readonly CodeToken[],
  counterpartTokens: readonly CodeToken[],
  pairs: ReadonlyMap<number, number>
): Map<number, IntraTokenPart[]> => {
  const refined = new Map<number, IntraTokenPart[]>();
  for (const [tokenIndex, counterpartIndex] of pairs) {
    const token = tokens[tokenIndex];
    const counterpart = counterpartTokens[counterpartIndex];
    if (!(token && counterpart)) {
      continue;
    }
    const { oldParts } = splitIntraToken(token.text, counterpart.text);
    refined.set(tokenIndex, oldParts);
  }
  return refined;
};
