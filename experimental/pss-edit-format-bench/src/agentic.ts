import type { EditMethodId } from "./methods/types";
import type { EditTask } from "./tasks";

export type AgenticToolName = "read_file" | "edit_file";
export type AgenticFailureKind =
  | "tool-failed"
  | "tool-not-called"
  | "transport-failed"
  | "verification-failed";
export type AgenticToolStatus = "failed" | "not-called" | "succeeded";
export type AgenticVerificationStatus = "failed" | "not-run" | "passed";

export interface AgenticToolEvent {
  readonly error?: string;
  readonly fileAfter?: string;
  readonly inputJson: string;
  readonly name: AgenticToolName;
  readonly output?: string;
}

export interface AgenticRetryFailure {
  readonly attempt: number;
  readonly durationMs: number;
  readonly errorCauseJson: string;
  readonly errorDetailsJson: string;
  readonly errorMessage: string;
  readonly errorName: string;
  readonly errorStack: string;
  readonly toolEvents: readonly AgenticToolEvent[];
}

export interface AgenticAttempt {
  readonly durationMs: number;
  readonly editCalls: number;
  readonly editSuccesses: number;
  readonly failureKind?: AgenticFailureKind;
  readonly finalText: string;
  readonly firstEditPassed: boolean;
  readonly format: EditMethodId;
  readonly inputTokens: number | undefined;
  readonly model: string;
  readonly outputTokens: number | undefined;
  readonly passed: boolean;
  readonly readCalls: number;
  readonly recovered: boolean;
  readonly requestFailure?: string;
  readonly responseMessagesJson: string;
  readonly retryFailures: readonly AgenticRetryFailure[];
  readonly run: number;
  readonly steps: number;
  readonly task: string;
  readonly toolEvents: readonly AgenticToolEvent[];
  readonly toolStatus: AgenticToolStatus;
  readonly totalTokens: number | undefined;
  readonly transportStatus: "failed" | "ok";
  readonly verificationDiagnostics: readonly string[];
  readonly verificationStatus: AgenticVerificationStatus;
}

export const buildAgenticPrompt = (task: EditTask): string =>
  [
    `Target file: ${task.path}`,
    `Workspace files: ${Object.keys(task.initialFiles).sort().join(", ")}`,
    `Task: ${task.instruction}`,
  ].join("\n");

export const summarizeToolEvents = (
  events: readonly AgenticToolEvent[],
  expected: string
): Pick<
  AgenticAttempt,
  | "editCalls"
  | "editSuccesses"
  | "failureKind"
  | "firstEditPassed"
  | "readCalls"
  | "recovered"
  | "toolStatus"
  | "verificationStatus"
> & { readonly passed: boolean } => {
  const edits = events.filter((event) => event.name === "edit_file");
  const successfulEdits = edits.filter((event) => event.error === undefined);
  const firstEdit = edits[0];
  const passed = successfulEdits.some((event) => event.fileAfter === expected);
  const firstEditPassed =
    firstEdit !== undefined &&
    firstEdit.error === undefined &&
    firstEdit.fileAfter === expected;
  const toolStatus = classifyToolStatus(edits.length, successfulEdits.length);
  const failureKind = classifyFailure(toolStatus, passed);
  return {
    editCalls: edits.length,
    editSuccesses: successfulEdits.length,
    failureKind,
    firstEditPassed,
    passed,
    readCalls: events.filter((event) => event.name === "read_file").length,
    recovered: passed && !firstEditPassed,
    toolStatus,
    verificationStatus: passed ? "passed" : "failed",
  };
};

const classifyToolStatus = (
  editCalls: number,
  editSuccesses: number
): AgenticToolStatus => {
  if (editCalls === 0) {
    return "not-called";
  }
  return editSuccesses === 0 ? "failed" : "succeeded";
};

const classifyFailure = (
  toolStatus: AgenticToolStatus,
  passed: boolean
): AgenticFailureKind | undefined => {
  if (toolStatus === "not-called") {
    return "tool-not-called";
  }
  if (toolStatus === "failed") {
    return "tool-failed";
  }
  return passed ? undefined : "verification-failed";
};
