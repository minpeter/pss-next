/**
 * Shared environment/CLI value resolution for benchmark harnesses.
 */

/**
 * Blank values (e.g. an empty dotenv entry) count as unset so they cannot
 * bypass a pinned fallback; padded values are returned trimmed.
 */
export function asSet(value) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Positive-integer knobs (rate limits, concurrency): anything that does not
 * parse to a positive integer falls back to the default.
 */
export function resolvePositiveInteger(raw, fallback) {
  const parsed = Number(asSet(raw));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
