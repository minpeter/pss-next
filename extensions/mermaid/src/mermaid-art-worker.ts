import { parentPort } from "node:worker_threads";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMermaidASCII } from "beautiful-mermaid";

const MAX_SOURCE_LENGTH = 32_768;
const MAX_ART_LINES = 80;
const MAX_EXPANDED_EDGES = 200;
const MAX_NODES = 200;
const MAX_PLACEHOLDER_INDICES = 16_384;
const RESERVED_PUA_PATTERN = /[\uE000-\uE07F]/;
const HEADER_SEMICOLON_PATTERN =
  /^(\s*(?:graph|flowchart)\s+[A-Za-z]{2})\s*;+\s*/;
const TRAILING_SEMICOLON_PATTERN = /;[ \t]*$/gm;
const FLOWCHART_HEADER_PATTERN = /^\s*(?:graph|flowchart)\b/;
const ARROW_TOKEN = "(-->>|->>|-->|->|==>|-.->)";
const ARROW_PREFIX = "([\\w\\]\\)}\"'가-힯])";
const ARROW_BEFORE_NODE_PATTERN = new RegExp(
  `${ARROW_PREFIX}${ARROW_TOKEN}(?=[^\\s|])`,
  "gu"
);
const ARROW_BEFORE_LABEL_PATTERN = new RegExp(
  `${ARROW_PREFIX}${ARROW_TOKEN}(?=\\|)`,
  "gu"
);
const ARROW_BEFORE_SPACE_PATTERN = new RegExp(
  `${ARROW_PREFIX}${ARROW_TOKEN}(?=\\s)`,
  "gu"
);
const EDGE_LABEL_TARGET_PATTERN = /((?:-->|->>|-->>|->)\|[^|\n]+\|)(?=\S)/g;
const TIGHT_BARE_LINK_PATTERN = /(\w)--(\w)/g;
const EDGE_RUN_PATTERN = /-{2,}|-\.|-|={2,}|\.\./;
const AMPERSAND_PATTERN = /&/g;
const NODE_DECLARATION_PATTERN = /[[({][^\](){}]*[\])}]/g;
const ARROW_TOKEN_PATTERN = /-{1,2}>+|-{1,2}\+{1,2}>/;
const PLACEHOLDER_BASE = 0xe0_00;
const PLACEHOLDER_DIGIT = 0x7f;
const PLACEHOLDER_PATTERN = /[\uE000-\uE07F]{2}/g;

interface AsciiPreset {
  readonly boxBorderPadding: number;
  readonly paddingX: number;
  readonly paddingY: number;
}

const DEFAULT_PRESET: AsciiPreset = {
  boxBorderPadding: 1,
  paddingX: 5,
  paddingY: 5,
};
const TIGHT_PRESET: AsciiPreset = {
  boxBorderPadding: 1,
  paddingX: 2,
  paddingY: 2,
};

// beautiful-mermaid accepts the header only alone on the first line, while
// mermaid itself also allows `graph LR;` and single-line diagrams. Its
// flowchart parser likewise requires whitespace around arrows, so common
// idioms like `A-->B` and `A-->|yes|B` are spaced out here first - outside
// bracket and pipe spans, where arrow-like text is content. Nesting a
// bracket inside a label makes the source unsupported instead.
const spaceSegment = (text: string): string =>
  text
    .replace(ARROW_BEFORE_LABEL_PATTERN, "$1 $2")
    .replace(ARROW_BEFORE_NODE_PATTERN, "$1 $2 ")
    .replace(ARROW_BEFORE_SPACE_PATTERN, "$1 $2")
    .replace(EDGE_LABEL_TARGET_PATTERN, "$1 ")
    .replace(TIGHT_BARE_LINK_PATTERN, "$1 -- $2");

const isSpanOpener = (char: string): boolean =>
  char === "[" || char === "{" || char === "(";

const isSpanCloser = (char: string): boolean =>
  char === "]" || char === "}" || char === ")";

const readBracketSpan = (
  line: string,
  start: number
): { end: number; span: string } | undefined => {
  let depth = 0;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (isSpanOpener(char)) {
      depth += 1;
    } else if (isSpanCloser(char)) {
      depth -= 1;
    }
    if (depth > 1) {
      return;
    }
    if (depth === 0) {
      return { end: index + 1, span: line.slice(start, index + 1) };
    }
  }
  return { end: line.length, span: line.slice(start) };
};

const spaceArrowsOutsideSpans = (line: string): string | undefined => {
  let output = "";
  let segment = "";
  let pipe = false;
  const flush = (suffix?: string): void => {
    const spaced = spaceSegment(segment + (suffix ?? ""));
    output += suffix === undefined ? spaced : spaced.slice(0, -suffix.length);
    segment = "";
  };
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? "";
    if (!pipe && isSpanOpener(char)) {
      flush();
      const span = readBracketSpan(line, index);
      if (span === undefined) {
        return;
      }
      output += span.span;
      index = span.end;
      continue;
    }
    if (char === "|") {
      if (pipe) {
        pipe = false;
        output += `${char} `;
      } else {
        flush("|");
        pipe = true;
        output += char;
      }
      index += 1;
      continue;
    }
    if (pipe) {
      output += char;
    } else {
      segment += char;
    }
    index += 1;
  }
  flush();
  return output;
};

const normalizeDiagramSource = (source: string): string | undefined => {
  const match = HEADER_SEMICOLON_PATTERN.exec(source);
  const headerSplit =
    match === null ? source : `${match[1]}\n${source.slice(match[0].length)}`;
  const trimmed = headerSplit.replace(TRAILING_SEMICOLON_PATTERN, "");
  if (!FLOWCHART_HEADER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const lines: string[] = [];
  for (const line of trimmed.split("\n")) {
    const spaced = spaceArrowsOutsideSpans(line);
    if (spaced === undefined) {
      return;
    }
    lines.push(spaced);
  }
  return lines.join("\n");
};

const ampCount = (text: string): number =>
  text.match(AMPERSAND_PATTERN)?.length ?? 0;

// Split each statement into the node groups between edge runs and sum the
// cartesian product of every adjacent pair: `A & B --> C & D` is 4 edges, a
// one-line chain counts every hop, and group sizes double as the node
// estimate. Declaration-only lines contribute bracketed declarations or one
// bare node. The worker timeout is the hard bound; this estimate is the
// cheap pre-filter for obviously degenerate input.
const exceedsComplexityBudget = (source: string): boolean => {
  let expandedEdges = 0;
  let nodeEstimate = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("%%") || trimmed.length === 0) {
      continue;
    }
    if (EDGE_RUN_PATTERN.test(trimmed)) {
      const sizes = trimmed
        .split(EDGE_RUN_PATTERN)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .map((segment) => ampCount(segment) + 1);
      for (let index = 0; index + 1 < sizes.length; index += 1) {
        expandedEdges += (sizes[index] ?? 1) * (sizes[index + 1] ?? 1);
      }
      nodeEstimate += sizes.reduce((total, size) => total + size, 0);
    } else {
      nodeEstimate +=
        (trimmed.match(NODE_DECLARATION_PATTERN)?.length ?? 0) || 1;
    }
    if (nodeEstimate > MAX_NODES || expandedEdges > MAX_EXPANDED_EDGES) {
      return true;
    }
  }
  return false;
};

const graphemes = (text: string): string[] => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].map((part) => part.segment);
};

// beautiful-mermaid pads box art by UTF-16 length, so East Asian wide
// labels break alignment. Expand every wide grapheme into a private-use
// pair (two narrow columns, self-describing index), let the library lay out
// with correct widths, then collapse each pair back to the original glyph.
// The pair alphabet is reserved: sources already using it render as plain
// fences rather than risking mis-decoded annotations.
const expandWideChars = (
  source: string
): { expanded: string; wideChars: string[] } => {
  const wideChars: string[] = [];
  let expanded = "";
  // NFC folds combining sequences into single codepoints so both sides of
  // the shim count the same widths; zero-width characters are dropped since
  // the library would count them but terminals never draw them.
  for (const grapheme of graphemes(source.normalize("NFC"))) {
    const width = visibleWidth(grapheme);
    if (width === 0 && grapheme !== "\n") {
      continue;
    }
    if (width === 2) {
      const index = wideChars.length;
      wideChars.push(grapheme);
      expanded +=
        String.fromCodePoint(
          PLACEHOLDER_BASE + Math.floor(index / (PLACEHOLDER_DIGIT + 1))
        ) +
        String.fromCodePoint(
          PLACEHOLDER_BASE + (index % (PLACEHOLDER_DIGIT + 1))
        );
    } else {
      expanded += grapheme;
    }
  }
  return { expanded, wideChars };
};

const collapsePlaceholders = (
  art: string,
  wideChars: readonly string[]
): string =>
  art.replace(PLACEHOLDER_PATTERN, (pair) => {
    const index =
      ((pair.codePointAt(0) ?? 0) - PLACEHOLDER_BASE) *
        (PLACEHOLDER_DIGIT + 1) +
      ((pair.codePointAt(1) ?? 0) - PLACEHOLDER_BASE);
    return wideChars[index] ?? "";
  });

const squareBracketsBalanced = (source: string): boolean => {
  let square = 0;
  for (const char of source) {
    if (char === "[") {
      square += 1;
    } else if (char === "]") {
      square -= 1;
    }
    if (square < 0) {
      return false;
    }
  }
  return square === 0;
};

// beautiful-mermaid parses permissively and silently drops malformed tails,
// so reject obviously broken bodies instead of annotating a partial diagram:
// unbalanced node brackets and arrows without targets.
const diagramBodySane = (source: string): boolean => {
  const flowchart = FLOWCHART_HEADER_PATTERN.test(source);
  if (flowchart && !squareBracketsBalanced(source)) {
    return false;
  }
  for (const line of source.split("\n")) {
    const arrow = ARROW_TOKEN_PATTERN.exec(line);
    if (
      arrow !== null &&
      line.slice(arrow.index + arrow[0].length).trim().length === 0
    ) {
      return false;
    }
  }
  return true;
};

const trimArtLines = (art: string): string[] => {
  const lines = art.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && (lines.at(-1) ?? "").length === 0) {
    lines.pop();
  }
  return lines;
};

/** Render diagram source to box-art lines, or undefined when unsupported. */
export const renderDiagramArt = (source: string): string[] | undefined => {
  const normalized = normalizeDiagramSource(source.trim());
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.length > MAX_SOURCE_LENGTH ||
    RESERVED_PUA_PATTERN.test(normalized) ||
    exceedsComplexityBudget(normalized) ||
    !diagramBodySane(normalized)
  ) {
    return;
  }
  const { expanded, wideChars } = expandWideChars(normalized);
  if (wideChars.length >= MAX_PLACEHOLDER_INDICES) {
    return;
  }
  let lines: string[];
  try {
    lines = trimArtLines(
      collapsePlaceholders(
        renderMermaidASCII(expanded, { ...DEFAULT_PRESET, colorMode: "none" }),
        wideChars
      )
    );
  } catch {
    return;
  }
  if (lines.length > MAX_ART_LINES) {
    try {
      lines = trimArtLines(
        collapsePlaceholders(
          renderMermaidASCII(expanded, { ...TIGHT_PRESET, colorMode: "none" }),
          wideChars
        )
      );
    } catch {
      return;
    }
  }
  return lines.length > MAX_ART_LINES || lines.length === 0 ? undefined : lines;
};

if (parentPort) {
  const port = parentPort;
  port.on("message", (request: { id: number; source: string }) => {
    try {
      port.postMessage({
        art: renderDiagramArt(request.source),
        id: request.id,
      });
    } catch {
      port.postMessage({
        art: undefined,
        id: request.id,
      });
    }
  });
}
