import type { TaskValidation } from "./task-utility-validator-types";

export type TaskValidatorErrorKind =
  | "output-limit"
  | "process"
  | "protocol"
  | "timeout"
  | "validation";

interface TaskValidatorErrorDetails {
  readonly kind: TaskValidatorErrorKind;
  readonly message: string;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ValidatorCompletion {
  readonly code: number | null;
  readonly details: { readonly stderr: string; readonly stdout: string };
  readonly expectedCheckIds: readonly string[];
  readonly failure: TaskValidatorErrorKind | undefined;
  readonly protocol: string;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: Error | undefined;
}

export class TaskValidatorProcessError extends Error {
  readonly kind: TaskValidatorErrorKind;
  readonly stderr: string;
  readonly stdout: string;

  constructor(details: TaskValidatorErrorDetails) {
    super(details.message);
    this.name = "TaskValidatorProcessError";
    this.kind = details.kind;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
  }
}

export function completeTaskValidation({
  code,
  details,
  expectedCheckIds,
  failure,
  protocol,
  signal,
  spawnError,
}: ValidatorCompletion): TaskValidation {
  if (failure !== undefined) {
    throw taskValidatorProcessError(
      failure,
      failure === "timeout"
        ? "Task validator exceeded its wall timeout."
        : "Task validator output exceeded its byte limit.",
      details
    );
  }
  if (spawnError !== undefined) {
    throw taskValidatorProcessError("process", spawnError.message, details);
  }
  let result: ValidatorProtocol;
  try {
    result = parseProtocol(protocol, expectedCheckIds);
  } catch {
    throw taskValidatorProcessError(
      "protocol",
      "Validator protocol payload is invalid.",
      details
    );
  }
  if (result.kind === "error") {
    throw taskValidatorProcessError(
      "validation",
      "Task validator rejected the workspace module.",
      details
    );
  }
  if (code !== 0 || signal !== null) {
    throw taskValidatorProcessError(
      "process",
      `Task validator closed with code ${String(code)} and signal ${String(signal)}.`,
      details
    );
  }
  return result.validation;
}

export function taskValidatorProcessError(
  kind: TaskValidatorErrorKind,
  message: string,
  output: { readonly stderr: string; readonly stdout: string } = {
    stderr: "",
    stdout: "",
  }
): TaskValidatorProcessError {
  return new TaskValidatorProcessError({ kind, message, ...output });
}

type ValidatorProtocol =
  | { readonly kind: "error"; readonly nonce: string }
  | {
      readonly kind: "result";
      readonly nonce: string;
      readonly validation: TaskValidation;
    };

function parseProtocol(
  raw: string,
  expectedCheckIds: readonly string[]
): ValidatorProtocol {
  const lines = raw.trim().split("\n");
  if (lines.length !== 2) {
    throw taskValidatorProcessError(
      "protocol",
      "Validator protocol framing is invalid."
    );
  }
  const challenge = parseObject(lines[0]);
  const result = parseObject(lines[1]);
  const nonce = Reflect.get(challenge, "nonce");
  if (
    Reflect.get(challenge, "kind") !== "challenge" ||
    typeof nonce !== "string" ||
    Reflect.get(result, "nonce") !== nonce
  ) {
    throw taskValidatorProcessError(
      "protocol",
      "Validator protocol challenge is invalid."
    );
  }
  const kind = Reflect.get(result, "kind");
  if (kind === "error") {
    return { kind, nonce };
  }
  if (kind === "result") {
    return {
      kind,
      nonce,
      validation: parseValidation(
        Reflect.get(result, "validation"),
        expectedCheckIds
      ),
    };
  }
  throw taskValidatorProcessError(
    "protocol",
    "Validator protocol kind is invalid."
  );
}

function parseObject(raw: string | undefined): object {
  if (raw === undefined) {
    throw taskValidatorProcessError(
      "protocol",
      "Validator protocol payload is missing."
    );
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw taskValidatorProcessError(
      "protocol",
      "Validator protocol payload is invalid."
    );
  }
  return value;
}

function parseValidation(
  value: unknown,
  expectedCheckIds: readonly string[]
): TaskValidation {
  if (!isObject(value)) {
    throw new TypeError("Task validator result must be an object.");
  }
  const rawChecks = Reflect.get(value, "checks");
  const passed = Reflect.get(value, "passed");
  if (!Array.isArray(rawChecks) || typeof passed !== "boolean") {
    throw new TypeError("Task validator result is invalid.");
  }
  const checks = rawChecks.map((raw) => {
    if (!isObject(raw)) {
      throw new TypeError("Task validator check must be an object.");
    }
    const id = Reflect.get(raw, "id");
    const checkPassed = Reflect.get(raw, "passed");
    if (typeof id !== "string" || typeof checkPassed !== "boolean") {
      throw new TypeError("Task validator check is invalid.");
    }
    return { id, passed: checkPassed };
  });
  const receivedIds = checks.map((check) => check.id);
  const expected = new Set(expectedCheckIds);
  if (
    receivedIds.length !== expected.size ||
    new Set(receivedIds).size !== receivedIds.length ||
    !receivedIds.every((id) => expected.has(id))
  ) {
    throw new TypeError("Task validator check set is inconsistent.");
  }
  const computedPassed = checks.every((check) => check.passed);
  if (passed !== computedPassed) {
    throw new TypeError("Task validator result pass state is inconsistent.");
  }
  return { checks, passed: computedPassed };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
