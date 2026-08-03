import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs } from "ai";
import { config as loadDotenv } from "dotenv";
import { CODING_AGENT_INSTRUCTIONS } from "../../../apps/coding-agent/src/instructions";
import { createAgenticTools } from "./agentic-tools";
import type { AgenticTraceSink } from "./agentic-trace";
import type { EditTask } from "./tasks";
import { verifyWorkspace } from "./workspace";

loadDotenv({ override: false, quiet: true });

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
  readonly format: "pss-json";
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

export interface AgenticRunOptions {
  readonly disableThinking: boolean;
  readonly maxSteps: number;
  readonly model: string;
  readonly provider: ReturnType<typeof createOpenAICompatible>;
  readonly requestAttempts: number;
  readonly requestTimeoutMs: number;
  readonly run: number;
  readonly task: EditTask;
  readonly trace?: AgenticTraceSink;
}

const stringify = (value: unknown): string => JSON.stringify(value) ?? "null";

const errorDetailsJson = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return stringify(error);
  }
  const details = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key) => [
      key,
      Reflect.get(error, key),
    ])
  );
  return stringify(details);
};

export const buildAgenticPrompt = (task: EditTask): string =>
  [
    `Target file: ${task.path}`,
    `Workspace files: ${Object.keys(task.initialFiles).sort().join(", ")}`,
    `Task: ${task.instruction}`,
  ].join("\n");

export const buildAgenticSystemPrompt = (): string =>
  [
    CODING_AGENT_INSTRUCTIONS,
    "",
    "This benchmark exposes only read_file and edit_file.",
    "Use read_file and edit_file as actual tools; never print edit JSON as plain text.",
    "Read the target file before editing, then call edit_file with its exact anchors and file hash.",
    "For replace, use target for one line OR first and last for a range; never combine them.",
    "For prepend or append, use target and new_content only.",
    "The score compares the entire workspace byte-for-byte; preserve every unrequested byte and never create extra files.",
    "After an edit, inspect the tool result. If the task is not complete, call read_file again and retry.",
    "Return a short final response only after the target file matches the task.",
  ].join("\n");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const providerOptionsFor = (
  disableThinking: boolean
): Record<string, unknown> =>
  disableThinking
    ? {
        providerOptions: {
          bench: { chat_template_kwargs: { enable_thinking: false } },
        },
      }
    : {};

const failureKindForVerification = (
  passed: boolean,
  fallback: AgenticFailureKind | undefined
): AgenticFailureKind | undefined =>
  passed ? fallback : "verification-failed";

const verificationStatusFor = (passed: boolean): AgenticVerificationStatus =>
  passed ? "passed" : "failed";

export async function runAgenticAttempt(
  options: AgenticRunOptions
): Promise<AgenticAttempt> {
  const {
    disableThinking,
    maxSteps,
    model,
    provider,
    requestAttempts,
    requestTimeoutMs,
    run,
    task,
    trace,
  } = options;
  const startedAt = Date.now();
  let lastError = "";
  const retryFailures: AgenticRetryFailure[] = [];
  const systemPrompt = buildAgenticSystemPrompt();
  const userPrompt = buildAgenticPrompt(task);

  for (let requestTry = 0; requestTry < requestAttempts; requestTry += 1) {
    const attemptStartedAt = Date.now();
    const requestAttempt = requestTry + 1;
    const workspace = await mkdtemp(join(tmpdir(), "pss-agentic-"));
    const events: AgenticToolEvent[] = [];
    try {
      await trace?.({
        requestAttempt,
        run,
        task: task.id,
        timestampMs: Date.now(),
        type: "attempt_started",
      });
      await trace?.({
        requestAttempt,
        run,
        system: systemPrompt,
        task: task.id,
        timestampMs: Date.now(),
        type: "prompt_sent",
        user: userPrompt,
      });
      for (const [path, content] of Object.entries(task.initialFiles)) {
        const absolutePath = join(workspace, path);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
      }
      const tools = createAgenticTools({
        events,
        requestAttempt,
        run,
        task,
        trace,
        workspace,
      });
      const result = await generateText({
        abortSignal: AbortSignal.timeout(requestTimeoutMs),
        instructions: systemPrompt,
        messages: [{ content: userPrompt, role: "user" }],
        model: provider(model),
        stopWhen: stepCountIs(maxSteps),
        temperature: 0,
        toolChoice: "auto",
        tools,
        ...providerOptionsFor(disableThinking),
      });
      const responseMessagesJson =
        JSON.stringify(result.response.messages) ?? "[]";
      await trace?.({
        requestAttempt,
        responseMessagesJson,
        run,
        task: task.id,
        text: result.text,
        timestampMs: Date.now(),
        type: "model_response",
      });
      const verification = await verifyWorkspace(
        workspace,
        task.initialFiles,
        task.expectedFiles
      );
      await trace?.({
        diagnostics: verification.diagnostics,
        passed: verification.passed,
        requestAttempt,
        run,
        task: task.id,
        timestampMs: Date.now(),
        type: "verification",
      });
      const summary = summarizeToolEvents(events, task.expected);
      const failureKind = failureKindForVerification(
        verification.passed,
        summary.failureKind
      );
      await trace?.({
        requestAttempt,
        run,
        task: task.id,
        timestampMs: Date.now(),
        type: "attempt_finished",
      });
      return {
        ...summary,
        durationMs: Date.now() - startedAt,
        failureKind,
        finalText: result.text,
        format: "pss-json",
        inputTokens: result.usage.inputTokens,
        model,
        outputTokens: result.usage.outputTokens,
        passed: verification.passed,
        retryFailures,
        responseMessagesJson,
        run,
        steps: result.steps.length,
        task: task.id,
        toolStatus: summary.toolStatus,
        toolEvents: events,
        totalTokens: result.usage.totalTokens,
        transportStatus: "ok",
        verificationDiagnostics: verification.diagnostics,
        verificationStatus: verificationStatusFor(verification.passed),
      };
    } catch (error) {
      lastError = errorMessage(error);
      await trace?.({
        error: lastError,
        requestAttempt,
        run,
        task: task.id,
        timestampMs: Date.now(),
        type: "request_error",
      });
      await trace?.({
        requestAttempt,
        run,
        task: task.id,
        timestampMs: Date.now(),
        type: "attempt_finished",
      });
      const errorCause =
        error instanceof Error
          ? (error as Error & { cause?: unknown }).cause
          : undefined;
      retryFailures.push({
        attempt: requestAttempt,
        durationMs: Date.now() - attemptStartedAt,
        errorCauseJson: stringify(errorCause),
        errorDetailsJson: errorDetailsJson(error),
        errorMessage: lastError,
        errorName: error instanceof Error ? error.name : typeof error,
        errorStack: error instanceof Error ? (error.stack ?? "") : "",
        toolEvents: events.slice(),
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }

  return {
    durationMs: Date.now() - startedAt,
    editCalls: 0,
    editSuccesses: 0,
    failureKind: "transport-failed",
    finalText: "",
    firstEditPassed: false,
    format: "pss-json",
    inputTokens: undefined,
    model,
    outputTokens: undefined,
    passed: false,
    readCalls: 0,
    recovered: false,
    requestFailure: lastError,
    retryFailures,
    responseMessagesJson: "[]",
    run,
    steps: 0,
    task: task.id,
    toolStatus: "not-called",
    toolEvents: [],
    totalTokens: undefined,
    transportStatus: "failed",
    verificationDiagnostics: [],
    verificationStatus: "not-run",
  };
}
