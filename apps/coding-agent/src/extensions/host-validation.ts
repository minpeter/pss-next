import type {
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionInput,
} from "./types";

export const DEFAULT_EXTENSION_TIMEOUT_MS = 10_000;
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;
const UNSAFE_EXTENSION_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function validateExtensionHostOptions(
  extensions: readonly CodingAgentExtensionInput[],
  options: CodingAgentExtensionHostOptions
): void {
  const ids = new Set<string>();
  for (const extension of extensions) {
    if (typeof extension.id !== "string" || extension.id.trim().length === 0) {
      throw new Error("Coding agent extension id must not be empty");
    }
    if (
      extension.id !== extension.id.trim() ||
      !EXTENSION_ID_PATTERN.test(extension.id) ||
      UNSAFE_EXTENSION_IDS.has(extension.id)
    ) {
      throw new TypeError(`Invalid extension id "${extension.id}"`);
    }
    if (ids.has(extension.id)) {
      throw new Error(`Duplicate coding agent extension "${extension.id}"`);
    }
    ids.add(extension.id);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Coding agent extension timeout must be non-negative");
  }
}
