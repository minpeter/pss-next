import type {
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionInput,
} from "./types";

export const DEFAULT_EXTENSION_TIMEOUT_MS = 10_000;
const MAX_EXTENSION_TIMEOUT_MS = 2_147_483_647;
const MAX_EXTENSION_ID_LENGTH = 214;
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;
const UNSAFE_EXTENSION_IDS = new Set(["__proto__", "constructor", "prototype"]);

export interface ValidatedCodingAgentExtensionInput {
  readonly id: string;
  readonly input: CodingAgentExtensionInput;
}

export function validateExtensionHostOptions(
  extensions: readonly CodingAgentExtensionInput[],
  options: CodingAgentExtensionHostOptions
): readonly ValidatedCodingAgentExtensionInput[] {
  const ids = new Set<string>();
  const validated: ValidatedCodingAgentExtensionInput[] = [];
  for (const extension of extensions) {
    const id = snapshotExtensionId(extension);
    if (ids.has(id)) {
      throw new Error("Duplicate coding agent extension id.");
    }
    ids.add(id);
    validated.push({ id, input: extension });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_EXTENSION_TIMEOUT_MS
  ) {
    throw new Error(
      "Coding agent extension timeout must be an integer between 0 and 2147483647"
    );
  }
  return validated;
}

function snapshotExtensionId(extension: CodingAgentExtensionInput): string {
  let value: unknown;
  try {
    value = extension.id;
  } catch {
    throw new TypeError("Invalid extension id.");
  }
  if (typeof value !== "string") {
    throw new Error("Coding agent extension id must not be empty");
  }
  const id = value.trim();
  if (id.length === 0) {
    throw new Error("Coding agent extension id must not be empty");
  }
  if (
    id !== value ||
    id.length > MAX_EXTENSION_ID_LENGTH ||
    !EXTENSION_ID_PATTERN.test(id) ||
    UNSAFE_EXTENSION_IDS.has(id)
  ) {
    throw new TypeError("Invalid extension id.");
  }
  return id;
}
