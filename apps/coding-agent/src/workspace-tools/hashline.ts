import { createHash } from "node:crypto";

const NIBBLES = "ZPMQVRWSNKTXJBYH";
const HASHLINE_DICTIONARY = Array.from({ length: 256 }, (_, value) => {
  const high = Math.floor(value / 16);
  const low = value % 16;
  return `${NIBBLES[high]}${NIBBLES[low]}`;
});
const ANCHOR_PATTERN = /^(\d+)#([ZPMQVRWSNKTXJBYH]{2})$/;
const SIGNIFICANT_TEXT = /[\p{L}\p{N}]/u;

function hashToUInt32(input: string): number {
  return createHash("sha256").update(input).digest().readUInt32BE(0);
}

export function computeLineHash(lineNumber: number, content: string): string {
  const stripped = content.replace(/\s+/g, "");
  const seed = SIGNIFICANT_TEXT.test(stripped) ? 0 : lineNumber;
  return HASHLINE_DICTIONARY[hashToUInt32(`${seed}:${stripped}`) % 256];
}

export function computeFileHash(content: string): string {
  return hashToUInt32(content).toString(16).padStart(8, "0");
}

export function formatHashLine(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`;
}

export function formatLineAnchor(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}`;
}

export function resolveLineAnchor(
  anchor: string,
  lines: readonly string[]
): number {
  const match = ANCHOR_PATTERN.exec(anchor);
  if (!match) {
    throw new Error(
      `Invalid hashline anchor: ${anchor}. Re-read the file and use LINE#ID.`
    );
  }
  const lineNumber = Number.parseInt(match[1], 10);
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
}
