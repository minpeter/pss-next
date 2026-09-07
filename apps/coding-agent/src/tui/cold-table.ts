import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type ColdContent, selectTextTail } from "./cold-content";

export interface ColdTable {
  readonly bottom: boolean;
  readonly kind: "table";
  readonly paddingX: number;
  readonly rows: readonly {
    readonly cells: readonly string[];
    readonly before?: "top" | "separator";
  }[];
}

const TABLE_TOP = /^┌[─┬]+┐$/;
const TABLE_BOTTOM = /^└[─┴]+┘$/;
const TABLE_SEPARATOR = /^├[─┼]+┤$/;
const plain = (line: string) => stripTerminalSequences(line).trim();
const bottom = (line: string) => TABLE_BOTTOM.test(plain(line));
const separator = (line: string) => TABLE_SEPARATOR.test(plain(line));
const trimCell = (line: string): string =>
  sliceByColumn(line, 0, visibleWidth(stripTerminalSequences(line).trimEnd()));

/** Decode only pi-tui's table layout, generated from a known Markdown source.
 * Column offsets come from its border, not pipes in user text. This is a styled
 * cell snapshot, never an attempt to recover Markdown from arbitrary ANSI rows.
 */
const tableCells = (
  lines: readonly string[],
  paddingX: number
): { cells: string[][]; heights: number[] } => {
  const border = plain(lines[0]);
  const widths = border
    .slice(2, -2)
    .split("─┬─")
    .map((part) => part.length);
  const cells: string[][] = [];
  const heights: number[] = [];
  let current: string[][] = [];
  const flush = () => {
    if (!current.length) {
      return;
    }
    cells.push(
      widths.map((_, column) => current.map((row) => row[column]).join("\n"))
    );
    heights.push(current.length);
    current = [];
  };
  for (const line of lines.slice(1)) {
    if (separator(line) || bottom(line)) {
      flush();
      continue;
    }
    let offset = paddingX + 2;
    current.push(
      widths.map((width) => {
        const cell = trimCell(sliceByColumn(line, offset, width));
        offset += width + 3;
        return cell;
      })
    );
  }
  flush();
  return { cells, heights };
};

const borderLine = (
  widths: readonly number[],
  kind: "top" | "separator" | "bottom"
): string => {
  const [left, middle, right] = {
    top: ["┌", "┬", "┐"],
    bottom: ["└", "┴", "┘"],
    separator: ["├", "┼", "┤"],
  }[kind];
  return `${left}─${widths.map((width) => "─".repeat(width)).join(`─${middle}─`)}─${right}`;
};

export const renderColdTable = (table: ColdTable, width: number): string[] => {
  const columns = table.rows[0]?.cells.length ?? 0;
  if (!columns) {
    return [];
  }
  const available = Math.max(1, width - table.paddingX * 2);
  if (available < 4 * columns + 1) {
    return table.rows.flatMap((row) =>
      row.cells.flatMap((cell) => wrapTextWithAnsi(cell, available))
    );
  }
  const widths = Array.from({ length: columns }, () => 1);
  const natural = widths.map((_, column) =>
    Math.max(1, ...table.rows.map((row) => visibleWidth(row.cells[column])))
  );
  let remaining = available - (3 * columns + 1) - columns;
  while (remaining > 0 && widths.some((value, i) => value < natural[i])) {
    for (let i = 0; i < columns && remaining > 0; i += 1) {
      if (widths[i] < natural[i]) {
        widths[i] += 1;
        remaining -= 1;
      }
    }
  }
  const lines: string[] = [];
  for (const row of table.rows) {
    if (row.before) {
      lines.push(borderLine(widths, row.before));
    }
    const cells = row.cells.map((cell, i) => wrapTextWithAnsi(cell, widths[i]));
    const height = Math.max(...cells.map((cell) => cell.length));
    for (let y = 0; y < height; y += 1) {
      lines.push(
        `│ ${cells
          .map((cell, i) => {
            const text = cell[y] ?? "";
            return (
              text + " ".repeat(Math.max(0, widths[i] - visibleWidth(text)))
            );
          })
          .join(" │ ")} │`
      );
    }
  }
  if (table.bottom) {
    lines.push(borderLine(widths, "bottom"));
  }
  return lines.map(
    (line) =>
      `${" ".repeat(table.paddingX)}${line}${" ".repeat(Math.max(0, width - table.paddingX - visibleWidth(line)))}`
  );
};

const ranges = (
  rows: readonly string[],
  paddingX = 0
): { start: number; end: number; table: boolean }[] => {
  // Only unindented table borders emitted at Markdown's content margin count.
  // Fenced code's indentation and quote/list prefixes are not table metadata.
  const lines = rows.map((line) =>
    stripTerminalSequences(line).slice(paddingX).trimEnd()
  );
  const result: { start: number; end: number; table: boolean }[] = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!TABLE_TOP.test(lines[index])) {
      continue;
    }
    const end = lines.findIndex(
      (line, i) => i > index && TABLE_BOTTOM.test(line)
    );
    if (end < 0) {
      continue;
    }
    if (index > start) {
      result.push({ start, end: index, table: false });
    }
    result.push({ start: index, end: end + 1, table: true });
    index = end;
    start = end + 1;
  }
  if (start < lines.length) {
    result.push({ start, end: lines.length, table: false });
  }
  return result;
};

const selectedCell = (
  cell: string,
  width: number,
  discarded: number
): string => {
  const length = wrapTextWithAnsi(cell, width).length;
  if (discarded >= length) {
    return "";
  }
  const selected = selectTextTail(
    { kind: "text", text: cell, paddingX: 0, paddingY: 0 },
    width,
    length - discarded
  );
  if (selected.kind === "text") {
    return selected.text;
  }
  if (selected.kind === "selected" && selected.content.kind === "text") {
    return selected.content.text;
  }
  throw new Error("Expected a selected table text cell");
};

const selectTable = (
  logical: readonly string[],
  actual: readonly string[],
  start: number,
  paddingX: number
): ColdContent => {
  const source = tableCells(logical, 0);
  const displayed = tableCells(actual, paddingX);
  const widths = plain(actual[0])
    .slice(2, -2)
    .split("─┬─")
    .map((part) => part.length);
  const rows: { cells: string[]; before?: "top" | "separator" }[] = [];
  let position = 1;
  for (const [rowIndex, cells] of source.cells.entries()) {
    const height = displayed.heights[rowIndex];
    const discarded = Math.max(0, start - position);
    if (discarded < height) {
      const before = rowIndex === 0 ? "top" : "separator";
      rows.push({
        before: start <= position - 1 ? before : undefined,
        cells: cells.map((cell, column) =>
          selectedCell(cell, widths[column], discarded)
        ),
      });
    }
    position += height + 1;
  }
  return rows.length
    ? { kind: "table", rows, paddingX, bottom: true }
    : {
        kind: "fixed",
        rows: actual.slice(Math.max(start, 0)),
        reason: "opaque-renderer",
      };
};

/** Select the committed physical suffix, but retain cell-local soft-wrap origins. */
export const selectMarkdownTables = (
  natural: readonly string[],
  actual: readonly string[],
  width: number,
  count: number,
  paddingX: number
): ColdContent | undefined => {
  const sourceRanges = ranges(natural);
  if (!sourceRanges.some((range) => range.table)) {
    return;
  }
  const actualRanges = ranges(actual, paddingX);
  if (sourceRanges.length !== actualRanges.length) {
    return;
  }
  const start = actual.length - count;
  const children: ColdContent[] = [];
  for (const [index, range] of actualRanges.entries()) {
    if (range.end <= start) {
      continue;
    }
    const sourceRange = sourceRanges[index];
    const logical = natural.slice(sourceRange.start, sourceRange.end);
    if (!range.table) {
      children.push(
        selectTextTail(
          { kind: "text", text: logical.join("\n"), paddingX, paddingY: 0 },
          width,
          range.end - Math.max(start, range.start)
        )
      );
      continue;
    }
    children.push(
      selectTable(
        logical,
        actual.slice(range.start, range.end),
        start - range.start,
        paddingX
      )
    );
  }
  return {
    kind: "selected",
    width,
    rows: actual.slice(-count),
    content: { kind: "group", children },
  };
};
