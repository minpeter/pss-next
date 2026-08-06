import type { SchemaInput, ValueBuilder } from "./types";

/** `includes(substring)` — value (coerced to string) contains `substring`. Gate. */
export function includes(substring: string): ValueBuilder<unknown> {
  return {
    defaultSeverity: "gate",
    label: `includes ${JSON.stringify(substring)}`,
    score: (value) => {
      const text = stringify(value);
      const pass = text.includes(substring);
      return {
        detail: pass ? undefined : `got ${JSON.stringify(truncate(text))}`,
        pass,
        score: pass ? 1 : 0,
      };
    },
  };
}

/** `equals(value)` — deep structural equality. Gate. */
export function equals(expected: unknown): ValueBuilder<unknown> {
  return {
    defaultSeverity: "gate",
    label: "equals",
    score: (value) => {
      const pass = deepEqual(value, expected);
      return {
        detail: pass
          ? undefined
          : `got ${JSON.stringify(truncate(stringify(value)))}`,
        pass,
        score: pass ? 1 : 0,
      };
    },
  };
}

/** `matches(schema)` — validate against a Standard Schema (e.g. Zod). Gate. */
export function matches(schema: SchemaInput): ValueBuilder<unknown> {
  return {
    defaultSeverity: "gate",
    label: "matches schema",
    score: (value) => {
      const result = schema["~standard"].validate(value);
      if (isPromise(result)) {
        throw new TypeError(
          "matches(): async schemas are not supported in evals"
        );
      }
      const issues = result.issues;
      const pass = !issues || issues.length === 0;
      return {
        detail: pass
          ? undefined
          : (issues?.[0]?.message ?? "schema rejected value"),
        pass,
        score: pass ? 1 : 0,
      };
    },
  };
}

/** `similarity(expected)` — normalized Levenshtein similarity, 1 = identical. Soft. */
export function similarity(expected: string): ValueBuilder<unknown> {
  return {
    defaultSeverity: "soft",
    label: "similarity",
    score: (value) => {
      const actual = stringify(value);
      const score = levenshteinSimilarity(actual, expected);
      return { pass: score >= 1, score };
    },
  };
}

/**
 * Match a tool-call field against a `FieldMatcher`: a literal (partial-deep
 * match), a RegExp (tested against the coerced string), or a predicate (returns
 * boolean, or an expected value to compare against).
 */
export function matchField(matcher: unknown, value: unknown): boolean {
  if (matcher instanceof RegExp) {
    return matcher.test(typeof value === "string" ? value : stringify(value));
  }
  if (typeof matcher === "function") {
    const returned = (matcher as (v: unknown) => boolean | unknown)(value);
    return typeof returned === "boolean"
      ? returned
      : deepEqual(value, returned);
  }
  return partialDeepEqual(value, matcher);
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return String(a) === String(b);
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) {
    return false;
  }
  return ka.every(
    (k) =>
      k in (b as Record<string, unknown>) &&
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
  );
}

/** Subset match: every key in `expected` must deep-equal the value's key. */
export function partialDeepEqual(value: unknown, expected: unknown): boolean {
  if (
    expected === null ||
    typeof expected !== "object" ||
    expected instanceof RegExp
  ) {
    return deepEqual(value, expected);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const exp = expected as Record<string, unknown>;
  return Object.keys(exp).every(
    (k) =>
      k in (value as Record<string, unknown>) &&
      deepEqual((value as Record<string, unknown>)[k], exp[k])
  );
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const distance = levenshtein(a, b);
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - distance / longest;
}

function levenshtein(a: string, b: string): number {
  let previousRow = Array.from({ length: a.length + 1 }, (_, index) => index);
  for (let i = 1; i <= b.length; i++) {
    const row = [i];
    for (let j = 1; j <= a.length; j++) {
      const deletion = previousRow[j];
      const insertion = row[j - 1];
      const substitution = previousRow[j - 1];
      if (
        deletion === undefined ||
        insertion === undefined ||
        substitution === undefined
      ) {
        throw new Error("Levenshtein matrix cell is missing.");
      }
      const cost = a.charAt(j - 1) === b.charAt(i - 1) ? 0 : 1;
      row[j] = Math.min(deletion + 1, insertion + 1, substitution + cost);
    }
    previousRow = row;
  }
  const distance = previousRow[a.length];
  if (distance === undefined) {
    throw new Error("Levenshtein distance is missing.");
  }
  return distance;
}
