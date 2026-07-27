import { boundedLcsMatches } from "./bounded-lcs";
import {
  type CodeToken,
  computeRefinedParts,
  type IntraTokenPart,
  markChangedTokens,
  pairRefinements,
  tokenizeCode,
} from "./highlight";
import { ANSI_RESET, normalizedLines } from "./utils";

// senpi's dark-theme diff scheme: plain red/green fg per line, changed words
// emphasized with inverse video instead of block backgrounds.
const DIFF_REMOVE_FG = "\x1b[31m";
const DIFF_ADD_FG = "\x1b[32m";
const DIFF_INVERSE_ON = "\x1b[7m";
const DIFF_INVERSE_OFF = "\x1b[27m";
// faint line-region tints behind the touched token; the strong inverse
// highlight marks only the intra-token characters that actually changed.
const DIFF_REMOVE_FAINT_BG = "\x1b[48;2;61;38;40m";
const DIFF_ADD_FAINT_BG = "\x1b[48;2;38;61;40m";
// unchanged context rows (identical on both sides) get a dim line number.
const DIFF_CONTEXT_DIM = "\x1b[2m";

interface DiffLine {
  kind: "add" | "remove";
  lineNo: number;
  text: string;
}

const DIFF_LINE_PATTERN = /^([+-])(\d+)(?:#[A-Z]+)?\|([\s\S]*)$/;

export const parseDiffSection = (output: string): DiffLine[][] | undefined => {
  const lines = normalizedLines(output);
  const diffIndex = lines.indexOf("diff:");
  if (diffIndex < 0) {
    return;
  }

  const groups: DiffLine[][] = [];
  let current: DiffLine[] | undefined;
  for (const line of lines.slice(diffIndex + 1)) {
    if (line.startsWith("@@ edit")) {
      current = [];
      groups.push(current);
      continue;
    }
    const match = line.match(DIFF_LINE_PATTERN);
    if (!match) {
      continue;
    }
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push({
      kind: match[1] === "+" ? "add" : "remove",
      lineNo: Number(match[2]),
      text: match[3],
    });
  }

  // A trailing "@@ edit" with no lines can arrive from truncated streaming
  // output; empty groups would render as stray blank separators.
  const nonEmpty = groups.filter((group) => group.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : undefined;
};
/**
 * A segment that carries no emphasis: plain syntax color terminated by a
 * reset. Used for unchanged tokens, tinted whitespace, and context rows.
 */
const renderPlainSegment = (token: CodeToken): string =>
  `${token.color}${token.text}${ANSI_RESET}`;

const renderDiffLine = (params: {
  changed: boolean[];
  kind: "add" | "remove";
  lineNo: number;
  refinedParts: ReadonlyMap<number, IntraTokenPart[]>;
  tokens: CodeToken[];
}): string => {
  const fg = params.kind === "remove" ? DIFF_REMOVE_FG : DIFF_ADD_FG;
  const faintBg =
    params.kind === "remove" ? DIFF_REMOVE_FAINT_BG : DIFF_ADD_FAINT_BG;
  const prefix = params.kind === "remove" ? "-" : "+";

  const segments = params.tokens.flatMap((token, index) => {
    if (!params.changed[index]) {
      return [renderPlainSegment(token)];
    }

    // Whitespace never takes the strong highlight; even when it changed it
    // drops to the faint region tint, so only real characters glow.
    if (token.text.trim().length === 0) {
      return [`${faintBg}${renderPlainSegment(token)}`];
    }

    const parts = params.refinedParts.get(index);
    if (parts === undefined) {
      return [
        `${fg}${DIFF_INVERSE_ON}${token.text}${DIFF_INVERSE_OFF}${ANSI_RESET}`,
      ];
    }

    return parts.map((part) =>
      part.changed
        ? `${fg}${DIFF_INVERSE_ON}${part.text}${DIFF_INVERSE_OFF}${ANSI_RESET}`
        : `${faintBg}${token.color}${part.text}${ANSI_RESET}`
    );
  });

  return `${fg}${prefix}${params.lineNo} ${ANSI_RESET}${segments.join("")}`;
};

/**
 * LCS over whole line texts; returns index pairs of lines that are
 * identical on both sides of the diff, in order.
 */
const matchIdenticalLines = (
  oldLines: readonly string[],
  newLines: readonly string[]
): Array<readonly [number, number]> => boundedLcsMatches(oldLines, newLines);

const renderEditedSide = (
  line: DiffLine,
  kind: "add" | "remove",
  counterpart: DiffLine | undefined
): string => {
  const tokens = tokenizeCode(line.text);
  if (counterpart === undefined) {
    return renderDiffLine({
      changed: tokens.map(() => true),
      kind,
      lineNo: line.lineNo,
      refinedParts: new Map(),
      tokens,
    });
  }
  const counterpartTokens = tokenizeCode(counterpart.text);
  const { oldChanged, newChanged } = markChangedTokens(
    tokens.map((token) => token.text),
    counterpartTokens.map((token) => token.text)
  );
  const { oldPairs } = pairRefinements(oldChanged, newChanged);
  const refinedParts = computeRefinedParts(tokens, counterpartTokens, oldPairs);
  return renderDiffLine({
    changed: oldChanged,
    kind,
    lineNo: line.lineNo,
    refinedParts,
    tokens,
  });
};

const renderContextLine = (line: DiffLine): string =>
  `${DIFF_CONTEXT_DIM} ${line.lineNo} ${ANSI_RESET}${tokenizeCode(line.text)
    .map(renderPlainSegment)
    .join("")}`;

export const renderDiffGroup = (lines: readonly DiffLine[]): string => {
  const removed = lines.filter((line) => line.kind === "remove");
  const added = lines.filter((line) => line.kind === "add");

  // Lines that are identical on both sides carry no edit; they collapse
  // into a single dim context row no matter how far the edit shifted them.
  const identical = matchIdenticalLines(
    removed.map((line) => line.text),
    added.map((line) => line.text)
  );
  const matchedOld = new Set(identical.map(([oldIndex]) => oldIndex));
  const matchedNew = new Set(identical.map(([, newIndex]) => newIndex));

  // Only genuinely edited lines get a counterpart for token-level refinement.
  const unmatchedOld = removed.filter((_, index) => !matchedOld.has(index));
  const unmatchedNew = added.filter((_, index) => !matchedNew.has(index));
  const counterpartOf = new Map<DiffLine, DiffLine>();
  for (const [index, oldLine] of unmatchedOld.entries()) {
    const newLine = unmatchedNew[index];
    if (newLine !== undefined) {
      counterpartOf.set(oldLine, newLine);
      counterpartOf.set(newLine, oldLine);
    }
  }

  const events: Array<{ key: number; text: string }> = [];
  for (const [, newIndex] of identical) {
    const line = added[newIndex];
    if (line !== undefined) {
      events.push({ key: line.lineNo, text: renderContextLine(line) });
    }
  }
  for (const [index, oldLine] of removed.entries()) {
    if (matchedOld.has(index)) {
      continue;
    }
    const counterpart = counterpartOf.get(oldLine);
    const rows = [
      renderEditedSide(oldLine, "remove", counterpart),
      ...(counterpart === undefined
        ? []
        : [renderEditedSide(counterpart, "add", oldLine)]),
    ];
    events.push({
      key: counterpart?.lineNo ?? oldLine.lineNo,
      text: rows.join("\n"),
    });
  }
  for (const [index, newLine] of added.entries()) {
    if (matchedNew.has(index) || counterpartOf.has(newLine)) {
      continue;
    }
    events.push({
      key: newLine.lineNo,
      text: renderEditedSide(newLine, "add", undefined),
    });
  }

  return events
    .sort((left, right) => left.key - right.key)
    .map((event) => event.text)
    .join("\n");
};

export const groupStartLine = (group: readonly DiffLine[]): number =>
  Math.min(...group.map((line) => line.lineNo));
