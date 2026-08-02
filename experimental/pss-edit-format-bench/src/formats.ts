import { createHash } from "node:crypto";
import { applyEdits } from "@oh-my-pi/hashline/apply";
import { resolveBlockEdits } from "@oh-my-pi/hashline/block";
import { parsePatch } from "@oh-my-pi/hashline/parser";

/**
 * Structural block resolver standing in for a tree-sitter BlockResolver.
 * Brace languages resolve by brace depth from the opening line; Python
 * resolves by indentation. On the bench fixtures it resolves the same spans
 * tree-sitter would; a real host injects a proper resolver.
 */
const resolveBenchBlock = ({
  path,
  text,
  line,
}: {
  path: string;
  text: string;
  line: number;
}): { start: number; end: number } | null => {
  const lines = text.split("\n");
  const opener = lines[line - 1];
  if (opener === undefined || opener.trim().length === 0) {
    return null;
  }
  if (path.endsWith(".py")) {
    const indent = (/^(\s*)/u.exec(opener)?.[1] ?? "").length;
    let end = line;
    for (let index = line; index < lines.length; index += 1) {
      const current = lines[index] as string;
      if (current.trim().length === 0) {
        continue;
      }
      const currentIndent = (/^(\s*)/u.exec(current)?.[1] ?? "").length;
      if (currentIndent > indent) {
        end = index + 1;
      } else {
        break;
      }
    }
    return end > line ? { start: line, end } : null;
  }
  if (!opener.includes("{")) {
    return null;
  }
  let depth = 0;
  for (let index = line - 1; index < lines.length; index += 1) {
    for (const char of lines[index] as string) {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (depth === 0) {
      return index + 1 > line ? { start: line, end: index + 1 } : null;
    }
  }
  return null;
};
import { z } from "zod";

export interface RenderedTask {
  readonly system: string;
  readonly user: string;
}

export interface ApplyOutcome {
  readonly text?: string;
  readonly error?: string;
  /**
   * Names of the recovery paths a format had to fire to accept the reply.
   * grok-build ships tolerances the strict pss/omp parsers do not, so a pass
   * that needed one is reported separately from a pass that did not — the
   * comparison would otherwise credit grok for replies the others reject.
   */
  readonly tolerances?: readonly string[];
}

export interface EditFormat {
  readonly name: string;
  render(path: string, initial: string): RenderedTask;
  apply(reply: string, initial: string): ApplyOutcome;
}

const LINE_SEPARATOR = /\r?\n/u;

const splitBody = (text: string): string[] => {
  const lines = text.split(LINE_SEPARATOR);
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
};

const joinBody = (lines: readonly string[]): string =>
  lines.length === 0 ? "" : `${lines.join("\n")}\n`;

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
// Hashline helpers, matching apps/coding-agent/src/workspace-tools/hashline.ts
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

const NIBBLES = "ZPMQVRWSNKTXJBYH";

const HASHLINE_DICTIONARY = Array.from({ length: 256 }, (_, value) => {
  const high = Math.floor(value / 16);
  const low = value % 16;
  return `${NIBBLES[high]}${NIBBLES[low]}`;
});

const SIGNIFICANT_TEXT = /[\p{L}\p{N}]/u;

function hashToUInt32(input: string): number {
  return createHash("sha256").update(input).digest().readUInt32BE(0);
}

function computeLineHash(lineNumber: number, content: string): string {
  const stripped = content.replace(/\s+/g, "");
  const seed = SIGNIFICANT_TEXT.test(stripped) ? 0 : lineNumber;
  return HASHLINE_DICTIONARY[hashToUInt32(`${seed}:${stripped}`) % 256];
}

export function computeFileHash(content: string): string {
  return hashToUInt32(content).toString(16).padStart(8, "0");
}

function formatHashLine(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`;
}

function formatLineAnchor(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}`;
}

// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––
// PSS JSON schema – 100% matching apps/coding-agent/src/workspace-tools/edit-file.ts
// –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

const pssEditSchema = z
  .object({
    op: z.enum(["replace", "append", "prepend"]),
    /** Single-line replace anchor, and the insertion point for append/prepend. */
    target: z.string().optional(),
    /** Inclusive range start for replace. Pair with `last`. */
    first: z.string().optional(),
    /** Inclusive range end for replace. Pair with `first`. */
    last: z.string().optional(),
    /** Replacement or inserted lines. Never empty. */
    new_content: z.union([
      z.string().min(1),
      z.array(z.string()).min(1),
    ]),
  })
  .strict();

const pssCallSchema = z
  .object({
    path: z.string().min(1),
    expected_file_hash: z.string().length(8).optional(),
    edits: z.array(pssEditSchema).min(1).max(100),
  })
  .strict();

const extractJson = (reply: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(reply);
  const body = (fenced?.[1] ?? reply).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON object in reply");
  }
  return body.slice(start, end + 1);
};

/**
 * Resolves a LINE#ID anchor exactly like the real edit_file tool: strict
 * LINE#ID format, out-of-range and stale anchors rejected, no recovery.
 */
const resolveLineAnchor = (
  anchor: string,
  lines: readonly string[]
): number => {
  const match = /^(\d+)#([ZPMQVRWSNKTXJBYH]{2})$/.exec(anchor);
  if (match === null) {
    throw new Error(
      `Invalid hashline anchor: ${anchor}. Re-read the file and use LINE#ID.`
    );
  }
  const lineNumber = Number.parseInt(match[1] as string, 10);
  const content = lines[lineNumber - 1];
  if (content === undefined) {
    throw new Error(
      `Anchor ${anchor} is outside the file (${lines.length} lines).`
    );
  }
  const currentAnchor = formatLineAnchor(lineNumber, content);
  if (currentAnchor !== anchor) {
    throw new Error(
      `Stale anchor ${anchor}; current anchor is ${currentAnchor}. Re-read the file.`
    );
  }
  return lineNumber - 1;
};

interface ResolvedPssEdit {
  readonly end: number;
  readonly index: number;
  readonly lines: readonly string[];
  readonly op: "replace" | "append" | "prepend";
  readonly order: number;
}

function pssReplacementLines(
  value: string | readonly string[]
): readonly string[] {
  if (typeof value !== "string") {
    return value;
  }
  const lines = value.split(LINE_SEPARATOR);
  return value.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function resolvePssEdit(
  edit: z.infer<typeof pssEditSchema>,
  lines: readonly string[],
  order: number
): ResolvedPssEdit {
  if (edit.op === "replace") {
    if (edit.first !== undefined || edit.last !== undefined) {
      if (edit.target !== undefined) {
        throw new Error(
          "replace accepts either target for one line or first+last for a range, not both."
        );
      }
      if (edit.first === undefined) {
        throw new Error(
          `replace range requires first; received only last=${edit.last}. Use target for one line, or first+last for an inclusive range.`
        );
      }
      if (edit.last === undefined) {
        throw new Error(
          `replace range requires last; received only first=${edit.first}. Use target for one line, or first+last for an inclusive range.`
        );
      }
      const index = resolveLineAnchor(edit.first, lines);
      const end = resolveLineAnchor(edit.last, lines);
      if (end < index) {
        throw new Error(
          `replace last precedes first: ${edit.first}..${edit.last}`
        );
      }
      return {
        end,
        index,
        lines: pssReplacementLines(edit.new_content),
        op: edit.op,
        order,
      };
    }
    if (edit.target === undefined) {
      throw new Error(
        "replace requires target: LINE#ID for one line, or first+last for an inclusive range."
      );
    }
    const index = resolveLineAnchor(edit.target, lines);
    return {
      end: index,
      index,
      lines: pssReplacementLines(edit.new_content),
      op: edit.op,
      order,
    };
  }
  const anchorIndex =
    edit.target === undefined
      ? undefined
      : resolveLineAnchor(edit.target, lines);
  const index =
    edit.op === "append"
      ? (anchorIndex ?? lines.length - 1) + 1
      : (anchorIndex ?? 0);
  return {
    end: index - 1,
    index,
    lines: pssReplacementLines(edit.new_content),
    op: edit.op,
    order,
  };
}

function assertNoOverlappingPssReplacements(
  edits: readonly ResolvedPssEdit[]
): void {
  const replacements = edits
    .filter((edit) => edit.op === "replace")
    .sort((left, right) => left.index - right.index);
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (previous && current && current.index <= previous.end) {
      throw new Error("Overlapping replace ranges are not allowed.");
    }
  }
}

function assertNoIntersectingPssInsertions(
  edits: readonly ResolvedPssEdit[]
): void {
  const replacements = edits.filter((edit) => edit.op === "replace");
  for (const insertion of edits) {
    if (insertion.op === "replace") {
      continue;
    }
    for (const replacement of replacements) {
      if (
        insertion.index >= replacement.index &&
        insertion.index <= replacement.end
      ) {
        throw new Error(
          "Insertion intersects a replace range; split it into a separate edit_file call."
        );
      }
    }
  }
}

/**
 * pss-json is the real coding-agent edit_file surface: the same strict zod
 * schema, the same SHA-256 hashline anchors, the same stale-file and
 * stale-anchor checks, and the same error messages. No tolerance paths exist
 * here; a reply either parses cleanly or fails exactly as the real tool does.
 */
export const pssFormat: EditFormat = {
  apply(reply, initial) {
    try {
      const call = pssCallSchema.parse(JSON.parse(extractJson(reply)));
      for (const edit of call.edits) {
        if (edit.op === "replace") {
          continue;
        }
        if (edit.first !== undefined || edit.last !== undefined) {
          throw new Error(
            `${edit.op} does not support first/last; it inserts at an optional target anchor.`
          );
        }
      }
      const lines = splitBody(initial);
      const originalHash = computeFileHash(initial);
      if (
        call.expected_file_hash !== undefined &&
        call.expected_file_hash !== originalHash
      ) {
        throw new Error(
          `Stale file hash ${call.expected_file_hash}; current hash is ${originalHash}.`
        );
      }
      const resolvedEdits = call.edits.map((edit, order) =>
        resolvePssEdit(edit, lines, order)
      );
      assertNoOverlappingPssReplacements(resolvedEdits);
      assertNoIntersectingPssInsertions(resolvedEdits);
      const output = [...lines];
      const ordered = [...resolvedEdits].sort(
        (left, right) => right.index - left.index || right.order - left.order
      );
      for (const edit of ordered) {
        const deleteCount =
          edit.op === "replace" ? edit.end - edit.index + 1 : 0;
        output.splice(edit.index, deleteCount, ...edit.lines);
      }
      return { text: joinBody(output) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
  name: "pss-json",
  render(path, initial) {
    const lines = splitBody(initial);
    const body = lines
      .map((line, index) => formatHashLine(index + 1, line))
      .join("\n");
    const range =
      lines.length === 0 ? "0/0" : `1-${lines.length}/${lines.length}`;
    return {
      system: [
        "You are PSS, a coding agent working directly in the provided workspace.",
        "",
        "Use the dedicated tools instead of guessing:",
        "- read_file reads files with LINE#ID anchors and a file hash.",
        "- edit_file applies surgical hashline-anchored edits.",
        "",
        "read_file output looks like:",
        "OK - file",
        "path: <path>",
        "file_hash: <8 hex chars>",
        "lines: <first>-<last>/<total>",
        "N#ID|<content>   (LINE#ID is the anchor for line N; copy it exactly)",
        "",
        "edit_file applies deterministic plugsuits-style hashline edits. Re-read the file, then use LINE#ID anchors. replace addresses one line with target, or an inclusive range with first+last; append/prepend insert relative to an optional target.",
        "",
        "Call edit_file by emitting one JSON object and nothing else:",
        '{"path":"<path>","expected_file_hash":"<file_hash from read_file>","edits":[{"op":"replace","target":"2#ZT","new_content":["  line one","  line two"]}]}',
        "",
        "Rules:",
        "- op is one of replace, append, prepend.",
        "- replace with target replaces one line; replace with first+last replaces the inclusive range; never give both target and first/last.",
        "- append inserts after the optional target anchor, or at end of file; prepend inserts before the optional target anchor, or at start of file. They never take first/last.",
        "- new_content is a string (newlines split into lines) or an array of final lines; never empty.",
        "- anchors are LINE#ID exactly as shown in read_file output. Never invent an anchor; if an anchor is rejected as stale, re-read the file because anchors change when lines shift.",
        "- expected_file_hash is the file_hash from your latest read_file of that path; a mismatched hash is rejected as a stale file.",
        "After applying, edit_file returns an OK block with a diff: lines prefixed -/+ carry their LINE#ID anchors.",
        "Output only the JSON object, no prose and no code fence.",
      ].join("\n"),
      user: [
        "OK - file",
        `path: ${path}`,
        `file_hash: ${computeFileHash(initial)}`,
        `lines: ${range}`,
        body,
      ].join("\n"),
    };
  },
};

const FILE_TAG = "A1B2";

export const ompFormat: EditFormat = {
  apply(reply, initial) {
    try {
      const fenced = /```(?:\w+)?\s*([\s\S]*?)```/u.exec(reply);
      const patch = (fenced?.[1] ?? reply).trim();
      const parsed = parsePatch(patch);
      if (parsed.edits.length === 0) {
        throw new Error("No hashline operations parsed");
      }
      return { text: applyEdits(initial, parsed.edits).text };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
  name: "omp-dsl",
  render(path, initial) {
    const body = splitBody(initial)
      .map((line, index) => `${index + 1}:${line}`)
      .join("\n");
    return {
      system: [
        "You edit files by emitting one hashline patch and nothing else.",
        "",
        "Every patch starts with a section header [PATH#TAG] copied from the file below.",
        "Line numbers refer to the ORIGINAL file and never shift as hunks apply.",
        "",
        "Operations:",
        "SWAP N.=M: — replace original lines N through M inclusive with the body rows below.",
        "DEL N.=M — delete original lines N through M inclusive. No body.",
        "INS.PRE N: — insert the body rows immediately before line N.",
        "INS.POST N: — insert the body rows immediately after line N.",
        "INS.HEAD: — insert the body rows at the very start of the file.",
        "INS.TAIL: — insert the body rows at the very end of the file.",
        "Single line: SWAP N.=N: or DEL N.",
        "",
        "Body rows appear only under a header ending in ':'. Every body row is +TEXT,",
        "adding one literal line TEXT with leading whitespace kept. '+' alone adds a",
        "blank line. Never write -old or a bare context line. A literal line starting",
        "with + or - still needs the body prefix: '- item' becomes '+- item'.",
        "",
        "Ranges cover ONLY lines whose content changes; never widen over unchanged lines.",
        "Never start or end a range mid-expression or mid-block: if you change a block's body, the range must also consume the block's closing line.",
        "Output only the patch, no prose and no code fence.",
      ].join("\n"),
      user: `[${path}#${FILE_TAG}]\n${body}`,
    };
  },
};

/**
 * omp's DSL vocabulary as a provider-safe tool-call schema: flat object, op
 * enum, every field optional. Combination rules live in
 * `validateOmpJsonHunk` because provider JSON Schema subsets cannot express
 * them (no anyOf/if-then). The surface is JSON; the semantics are omp's,
 * because apply translates each call into hashline DSL and runs the real
 * parser/applier — the comparison against omp-dsl isolates transport only.
 */
const OMP_JSON_OPS = [
  "swap",
  "swap_block",
  "insert_pre",
  "insert_post",
  "insert_head",
  "insert_tail",
  "insert_block_after",
  "delete",
  "delete_block",
  "remove",
  "move",
] as const;

const ompJsonLine = z.number().int().min(1);

const ompJsonHunkSchema = z
  .object({
    op: z.enum(OMP_JSON_OPS),
    line: ompJsonLine.optional(),
    first: ompJsonLine.optional(),
    last: ompJsonLine.optional(),
    content: z.string().optional(),
    dest: z.string().min(1).optional(),
  })
  .strict();

const ompJsonCallSchema = z
  .object({
    file_path: z.string().min(1),
    tag: z.string().regex(/^[0-9A-F]{4}$/u),
    hunks: z.array(ompJsonHunkSchema).min(1).max(100),
  })
  .strict();

type OmpJsonHunk = z.infer<typeof ompJsonHunkSchema>;

const validateOmpJsonHunk = (hunk: OmpJsonHunk): void => {
  const need = (key: keyof OmpJsonHunk): void => {
    if (hunk[key] === undefined) {
      throw new Error(`${hunk.op} requires ${key}`);
    }
  };
  const forbid = (key: keyof OmpJsonHunk): void => {
    if (hunk[key] !== undefined) {
      throw new Error(`${hunk.op} does not take ${key}`);
    }
  };
  const bodyRequired = (): void => {
    need("content");
    if (hunk.content === "") {
      throw new Error(`${hunk.op} requires non-empty content; use delete instead`);
    }
  };
  switch (hunk.op) {
    case "swap":
      need("first");
      need("last");
      bodyRequired();
      forbid("line");
      forbid("dest");
      break;
    case "swap_block":
      need("line");
      bodyRequired();
      forbid("first");
      forbid("last");
      forbid("dest");
      break;
    case "insert_pre":
    case "insert_post":
    case "insert_block_after":
      need("line");
      bodyRequired();
      forbid("first");
      forbid("last");
      forbid("dest");
      break;
    case "insert_head":
    case "insert_tail":
      bodyRequired();
      forbid("line");
      forbid("first");
      forbid("last");
      forbid("dest");
      break;
    case "delete":
      need("first");
      need("last");
      forbid("line");
      forbid("content");
      forbid("dest");
      break;
    case "delete_block":
      need("line");
      forbid("first");
      forbid("last");
      forbid("content");
      forbid("dest");
      break;
    case "remove":
      forbid("line");
      forbid("first");
      forbid("last");
      forbid("content");
      forbid("dest");
      break;
    case "move":
      need("dest");
      forbid("line");
      forbid("first");
      forbid("last");
      forbid("content");
      break;
  }
};

/**
 * Translates a validated call into hashline DSL. Every body row is `+TEXT`, so
 * a literal line is prefixed once; lines starting with `+` or `-` survive
 * because the parser strips exactly one prefix.
 */
const ompJsonToDsl = (call: z.infer<typeof ompJsonCallSchema>): string => {
  const rows: string[] = [`[${call.file_path}#${call.tag}]`];
  const body = (content: string): string[] =>
    content.split("\n").map((line) => `+${line}`);
  for (const hunk of call.hunks) {
    switch (hunk.op) {
      case "swap":
        rows.push(
          `SWAP ${hunk.first as number}.=${hunk.last as number}:`,
          ...body(hunk.content as string)
        );
        break;
      case "swap_block":
        rows.push(`SWAP.BLK ${hunk.line as number}:`, ...body(hunk.content as string));
        break;
      case "insert_pre":
        rows.push(`INS.PRE ${hunk.line as number}:`, ...body(hunk.content as string));
        break;
      case "insert_post":
        rows.push(`INS.POST ${hunk.line as number}:`, ...body(hunk.content as string));
        break;
      case "insert_head":
        rows.push("INS.HEAD:", ...body(hunk.content as string));
        break;
      case "insert_tail":
        rows.push("INS.TAIL:", ...body(hunk.content as string));
        break;
      case "insert_block_after":
        rows.push(`INS.BLK.POST ${hunk.line as number}:`, ...body(hunk.content as string));
        break;
      case "delete":
        rows.push(`DEL ${hunk.first as number}.=${hunk.last as number}`);
        break;
      case "delete_block":
        rows.push(`DEL.BLK ${hunk.line as number}`);
        break;
      case "remove":
        rows.push("REM");
        break;
      case "move":
        rows.push(`MV ${hunk.dest as string}`);
        break;
    }
  }
  return rows.join("\n");
};

export const ompJsonFormat: EditFormat = {
  apply(reply, initial) {
    try {
      const call = ompJsonCallSchema.parse(JSON.parse(extractJson(reply)));
      for (const hunk of call.hunks) {
        validateOmpJsonHunk(hunk);
      }
      const parsed = parsePatch(ompJsonToDsl(call));
      const edits = resolveBlockEdits(
        parsed.edits,
        initial,
        call.file_path,
        resolveBenchBlock
      );
      if (edits.length === 0) {
        throw new Error("No hashline operations parsed");
      }
      return { text: applyEdits(initial, edits).text };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
  name: "omp-json",
  render(path, initial) {
    const body = splitBody(initial)
      .map((line, index) => `${index + 1}:${line}`)
      .join("\n");
    return {
      system: [
        "You edit files by emitting one JSON object and nothing else.",
        "",
        "The file is shown with a [PATH#TAG] header and numbered lines N:content.",
        "Line numbers refer to the ORIGINAL file and never shift as hunks apply.",
        "",
        "Emit exactly:",
        '{"file_path":"<path>","tag":"<TAG>","hunks":[{"op":"swap","first":2,"last":2,"content":"..."}]}',
        "",
        "ops and their required fields:",
        "- swap: replace lines first through last inclusive. Needs first, last, content.",
        "- swap_block: replace the syntactic block OPENING at line; the block end is resolved for you. Needs line, content.",
        "- insert_pre / insert_post: insert before / after line. Needs line, content.",
        "- insert_head / insert_tail: insert at the start / end of the file. Needs content. Never give a line.",
        "- insert_block_after: insert after the block OPENING at line. Needs line, content.",
        "- delete: remove lines first through last. Needs first, last. Never give content.",
        "- delete_block: remove the block OPENING at line. Needs line. Never give content.",
        "- remove: delete the whole file. No other fields.",
        "- move: move the file to dest after the edits. Needs dest.",
        "",
        "content is one string; embed newlines to write multiple lines. It is always",
        "the FINAL content for that hunk — never retype lines you keep, and never",
        "widen a range over unchanged lines. Ranges cover ONLY lines whose content",
        "changes. Never start or end a range mid-expression or mid-block.",
        "An empty content is an error; use delete instead.",
        "Output only the JSON object, no prose and no code fence.",
      ].join("\n"),
      user: `[${path}#${FILE_TAG}]\n${body}`,
    };
  },
};

const GROK_FNV_OFFSET = 2_166_136_261;
const GROK_FNV_PRIME = 16_777_619;
const GROK_HASH_LEN = 3;
const GROK_CHUNK_SIZE = 16;
const GROK_ARROW = "\u2192";

const grokStep = (hash: number, byte: number): number =>
  Math.imul(hash ^ byte, GROK_FNV_PRIME) >>> 0;

/**
 * Whitespace-normalized FNV-1a 32-bit line fingerprint: trim, then collapse
 * internal whitespace runs to a single ASCII space, matching
 * `crate::util::hash::line_hash`. Keeps anchors stable across formatter-only
 * edits while still separating `return x` from `returnx`.
 */
const grokLineHash = (line: string): number => {
  let hash = GROK_FNV_OFFSET;
  let previousWasSpace = false;
  for (const byte of new TextEncoder().encode(line.trim())) {
    const isSpace = byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
    if (isSpace) {
      if (!previousWasSpace) {
        hash = grokStep(hash, 0x20);
        previousWasSpace = true;
      }
      continue;
    }
    hash = grokStep(hash, byte);
    previousWasSpace = false;
  }
  return hash;
};

/** Spread entropy across byte regions, as `encode_hash` does. */
const grokEncode = (hash: number, length: number): string => {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCodePoint(((hash >>> (index * 8)) % 26) + 0x61);
  }
  return out;
};

/**
 * Candidate B (`ChunkFingerprint`), grok's default scheme: local line hash plus
 * a fingerprint over the fixed-size chunk holding the line, so an edit only
 * invalidates anchors inside the affected chunk.
 */
const grokAnchor = (lines: readonly string[], lineIndex: number): string => {
  const local = grokEncode(
    grokLineHash(lines[lineIndex] as string),
    GROK_HASH_LEN
  );
  const chunkStart =
    Math.floor(lineIndex / GROK_CHUNK_SIZE) * GROK_CHUNK_SIZE;
  let chunk = GROK_FNV_OFFSET;
  for (const line of lines.slice(chunkStart, chunkStart + GROK_CHUNK_SIZE)) {
    for (const byte of new TextEncoder().encode(line.trim())) {
      chunk = grokStep(chunk, byte);
    }
    chunk = grokStep(chunk, 0x0a);
  }
  return `${lineIndex + 1}:${local}:${grokEncode(chunk, GROK_HASH_LEN)}`;
};

const GROK_ANCHOR_PATTERN = /^(\d+):([a-z]+)(?::([a-z]+))?$/u;

interface GrokResolved {
  readonly index: number;
  readonly end: number;
  readonly payload: readonly string[];
}

const grokEditSchema = z
  .object({
    op: z.enum(["replace", "insert_after", "write"]),
    anchor: z.string().optional(),
    end_anchor: z.string().optional(),
    content: z.string(),
  })
  .strict();

export const grokFormat: EditFormat = {
  apply(reply, initial) {
    const tolerances: string[] = [];
    try {
      const parsed = JSON.parse(extractJson(reply)) as { edits?: unknown };
      // grok's `deserialize_edits` accepts a double-encoded array or a single
      // bare operation, because models wrap the array in quotes or omit it.
      let rawEdits = parsed.edits;
      if (typeof rawEdits === "string") {
        rawEdits = JSON.parse(rawEdits);
        tolerances.push("string-wrapped-edits");
      }
      if (rawEdits !== null && !Array.isArray(rawEdits) && typeof rawEdits === "object") {
        rawEdits = [rawEdits];
        tolerances.push("bare-edits-object");
      }
      const edits = z.array(grokEditSchema).min(1).max(100).parse(rawEdits);
      const lines = splitBody(initial);
      const anchors = lines.map((_, index) => grokAnchor(lines, index));

      const resolveAnchor = (raw: string): number => {
        // A pasted anchor keeps its `ANCHOR\u2192content` separator.
        const arrowSplit = raw.split(GROK_ARROW)[0]?.split("->")[0] ?? raw;
        const candidate = arrowSplit.trim();
        if (candidate !== raw.trim()) {
          tolerances.push("arrow-stripped-anchor");
        }
        const match = GROK_ANCHOR_PATTERN.exec(candidate);
        if (match === null) {
          // Recovery: the model drops the line number and sends only the hash
          // suffix. Accept when exactly one line carries it.
          const suffixMatches = anchors.filter((anchor) =>
            anchor.endsWith(`:${candidate}`)
          );
          if (suffixMatches.length === 1) {
            tolerances.push("suffix-recovered-anchor");
            return anchors.indexOf(suffixMatches[0] as string);
          }
          throw new Error(
            `Malformed anchor: "${raw}". Expected format: "LINE:HASH1:HASH2".`
          );
        }
        const lineNumber = Number.parseInt(match[1] as string, 10);
        if (lineNumber < 1 || lineNumber > lines.length) {
          throw new Error(
            `Line ${lineNumber} is out of range (file has ${lines.length} lines).`
          );
        }
        if (anchors[lineNumber - 1] !== candidate) {
          throw new Error(`Anchor stale at line ${lineNumber}.`);
        }
        return lineNumber - 1;
      };

      const resolved = edits.map((edit): GrokResolved => {
        if (edit.op === "write") {
          if (edits.length > 1) {
            throw new Error("Write op must be the only operation in a batch.");
          }
          return {
            end: lines.length - 1,
            index: 0,
            payload: splitBody(edit.content),
          };
        }
        if (edit.anchor === undefined) {
          throw new Error(`${edit.op} requires an anchor.`);
        }
        if (edit.op === "insert_after") {
          if (edit.end_anchor !== undefined) {
            throw new Error("insert_after does not take end_anchor.");
          }
          const at =
            edit.anchor === "0:"
              ? 0
              : edit.anchor === "EOF"
                ? lines.length
                : resolveAnchor(edit.anchor) + 1;
          return {
            end: at - 1,
            index: at,
            payload: edit.content === "" ? [""] : splitBody(edit.content),
          };
        }
        const index = resolveAnchor(edit.anchor);
        const end =
          edit.end_anchor === undefined ? index : resolveAnchor(edit.end_anchor);
        if (end < index) {
          throw new Error(
            `end_anchor line ${end + 1} is before start anchor line ${index + 1}.`
          );
        }
        // Empty content deletes the addressed lines.
        return {
          end,
          index,
          payload: edit.content === "" ? [] : splitBody(edit.content),
        };
      });

      const spans = resolved
        .filter((edit) => edit.end >= edit.index)
        .map((edit) => [edit.index, edit.end] as const)
        .sort((a, b) => a[0] - b[0]);
      for (const [current, next] of spans.slice(0, -1).map((span, i) => [
        span,
        spans[i + 1] as readonly [number, number],
      ] as const)) {
        if (current[1] >= next[0]) {
          throw new Error(
            `Overlapping edits: lines ${current[0] + 1}-${current[1] + 1} and ${next[0] + 1}-${next[1] + 1}.`
          );
        }
      }

      const output = [...lines];
      for (const edit of [...resolved].sort((a, b) => b.index - a.index)) {
        output.splice(
          edit.index,
          Math.max(0, edit.end - edit.index + 1),
          ...edit.payload
        );
      }
      return { text: joinBody(output), tolerances };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        tolerances,
      };
    }
  },
  name: "grok-json",
  render(path, initial) {
    const lines = splitBody(initial);
    const body = lines
      .map((line, index) => `${grokAnchor(lines, index)}${GROK_ARROW}${line}`)
      .join("\n");
    return {
      system: [
        "You edit files by emitting one JSON object and nothing else.",
        "",
        `Each line of the file is shown as ANCHOR${GROK_ARROW}CONTENT, for example 22:abc:rst${GROK_ARROW}  let x = 1;`,
        "The anchor is everything before the arrow, including the line number.",
        "",
        "Emit exactly:",
        '{"edits":[{"op":"...","anchor":"...","content":"..."}]}',
        "",
        'op is one of "replace", "insert_after", "write".',
        '- replace: replaces the anchored line. Add "end_anchor" to replace an inclusive range. Empty content deletes the line(s).',
        '- insert_after: inserts content after the anchored line. Use "0:" for beginning of file and "EOF" for end of file.',
        '- write: replaces the entire file with content; it must be the only operation.',
        "content is one string; embed newlines to write multiple lines.",
        "Never fabricate or modify anchors, and never include the arrow or the line content in an anchor.",
        "Overlapping ranges are rejected, so keep every edit disjoint.",
        "Never start or end a range mid-expression or mid-block: if you change a block's body, the range must also consume the block's closing line.",
        "Output only the JSON object, no prose and no code fence.",
      ].join("\n"),
      user: `File ${path}:\n${body}`,
    };
  },
};

export const EDIT_FORMATS: readonly EditFormat[] = [
  pssFormat,
  ompFormat,
  ompJsonFormat,
  grokFormat,
];
