export function stringBinding(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error(`Expected SQL string binding, received ${typeof value}`);
}

export function nullableStringBinding(value: unknown): string | null {
  return value === null ? null : stringBinding(value);
}

export function numberBinding(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Expected SQL number binding, received ${typeof value}`);
}
