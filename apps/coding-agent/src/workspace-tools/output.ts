const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const HEAD_BUDGET_RATIO = 0.65;
const UTF8_CONTINUATION_MASK = 0b1100_0000;
const UTF8_CONTINUATION_PREFIX = 0b1000_0000;

function isContinuationByte(value: number | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 continuation-byte detection is defined by bit patterns (10xxxxxx).
  return (value & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX;
}

function utf8SafeHead(buffer: Buffer, maxLength: number): Buffer {
  let end = Math.min(maxLength, buffer.length);
  while (end > 0 && isContinuationByte(buffer[end])) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function utf8SafeTail(buffer: Buffer, maxLength: number): Buffer {
  let start = Math.max(0, buffer.length - maxLength);
  while (start < buffer.length && isContinuationByte(buffer[start])) {
    start += 1;
  }
  return buffer.subarray(start);
}

export function truncateToolOutput(
  value: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES
): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }

  // The marker text contains the omitted byte count, whose digit width feeds
  // back into the budget; iterate until the count is exact (at most one
  // digit drifts per pass).
  let omitted = buffer.length - maxBytes;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const marker = Buffer.from(
      `\n... truncated ${omitted} bytes ...\n`,
      "utf8"
    );
    if (marker.length >= maxBytes) {
      break;
    }
    const contentBudget = maxBytes - marker.length;
    const headLength = Math.floor(contentBudget * HEAD_BUDGET_RATIO);
    const head = utf8SafeHead(buffer, headLength);
    const tail = utf8SafeTail(buffer, contentBudget - head.length);
    // Omitted = source bytes not shown; the marker itself is not source.
    const actualOmitted = buffer.length - (head.length + tail.length);
    if (actualOmitted === omitted) {
      return `${head.toString("utf8")}${marker.toString("utf8")}${tail.toString("utf8")}`;
    }
    omitted = actualOmitted;
  }
  return utf8SafeHead(buffer, maxBytes).toString("utf8");
}
