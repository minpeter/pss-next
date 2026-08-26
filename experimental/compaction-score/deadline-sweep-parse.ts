export function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value;
}

export function string(value: unknown, path: string): string {
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

export function rate(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0 || parsed > 1) {
    throw new TypeError(`${path} must be a rate.`);
  }
  return parsed;
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} cells must be unique.`);
  }
}
