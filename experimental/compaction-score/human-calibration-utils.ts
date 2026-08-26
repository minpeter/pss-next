import { createHash } from "node:crypto";

const TRAILING_PERIOD_PATTERN = /\.$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonLines(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

export function normalizeCalibrationAnswer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(TRAILING_PERIOD_PATTERN, "");
}

export function seededCalibrationRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(7, 15), 16);
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

export function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function shuffleWith<T>(
  values: readonly T[],
  random: () => number
): T[] {
  const shuffled = values.map((value) => ({ value }));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const currentValue = shuffled[index];
    const targetValue = shuffled[target];
    if (currentValue === undefined || targetValue === undefined) {
      throw new RangeError("Shuffle index is outside the input bounds.");
    }
    shuffled[index] = targetValue;
    shuffled[target] = currentValue;
  }
  return shuffled.map(({ value }) => value);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
