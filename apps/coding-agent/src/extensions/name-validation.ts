import { requiredString } from "./data-validation";

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_COMMAND_NAMES = new Set([
  "clear",
  "compact",
  "fork",
  "help",
  "model",
  "name",
  "new",
  "reload",
  "resume",
  "session",
]);
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function snapshotCommandName(value: unknown): string {
  const name = snapshotName(
    value,
    "Coding agent command name",
    COMMAND_NAME_PATTERN
  );
  if (RESERVED_COMMAND_NAMES.has(name.toLowerCase())) {
    throw new Error(`Reserved coding agent command name or alias "${name}"`);
  }
  return name;
}

export function snapshotToolName(value: unknown): string {
  return snapshotName(value, "Tool name", TOOL_NAME_PATTERN);
}

export function snapshotToolRendererName(value: unknown): string {
  return snapshotName(value, "Tool renderer name", TOOL_NAME_PATTERN);
}

function snapshotName(value: unknown, label: string, pattern: RegExp): string {
  const name = requiredString(value, label).trim();
  if (name.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  if (UNSAFE_NAMES.has(name)) {
    throw new TypeError(`Unsafe ${label.toLowerCase()} "${name}"`);
  }
  if (!pattern.test(name)) {
    throw new TypeError(`Invalid ${label.toLowerCase()} "${name}"`);
  }
  return name;
}
