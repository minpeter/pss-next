export function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value;
}

export function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value;
}

export function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty string.`);
  }
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be boolean.`);
  }
  return value;
}

export function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite.`);
  }
  return value;
}

export function nullableFinite(value: unknown, path: string): number | null {
  return value === null ? null : finite(value, path);
}

export function positiveInteger(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${path} must be a positive safe integer.`);
  }
  return parsed;
}

export function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${path} must be a nonnegative safe integer.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIntervalOrNull(value: unknown): boolean {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => typeof item === "number"))
  );
}
