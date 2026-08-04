import type { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { runAgent } from "@minpeter/pss-runtime/evals";
import type { LanguageModel } from "ai";
import {
  type AgenticAttempt,
  type AgenticFailureKind,
  type AgenticRetryFailure,
  type AgenticToolEvent,
  type AgenticToolStatus,
  type AgenticVerificationStatus,
  buildAgenticPrompt,
  summarizeToolEvents,
} from "../agentic";
import type { AgenticTraceSink } from "../agentic-trace";
import type { EditMethod } from "../methods";
import type { EditTask } from "../tasks";
import { verifyWorkspace } from "../workspace";
import { cleanupWorkspace, setupWorkspace } from "./setup-workspace";
import { createStepCap } from "./step-cap";

export interface MethodAttemptOptions {
  readonly disableThinking: boolean;
  /** Optional override for tests (scripted models). */
  readonly languageModel?: LanguageModel;
  readonly maxSteps: number;
  readonly method: EditMethod;
  readonly model: string;
  readonly provider: ReturnType<typeof createOpenAICompatible>;
  readonly requestAttempts: number;
  readonly requestTimeoutMs: number;
  readonly run: number;
  readonly task: EditTask;
  readonly trace?: AgenticTraceSink;
}

const stringify = (value: unknown): string => JSON.stringify(value) ?? "null";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const sumUsage = (
  usages: readonly {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  }[]
): {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
} => {
  if (usages.length === 0) {
    return {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    };
  }
  let input = 0;
  let output = 0;
  let total = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawTotal = false;
  for (const usage of usages) {
    if (usage.inputTokens !== undefined) {
      input += usage.inputTokens;
      sawInput = true;
    }
    if (usage.outputTokens !== undefined) {
      output += usage.outputTokens;
      sawOutput = true;
    }
    if (usage.totalTokens !== undefined) {
      total += usage.totalTokens;
      sawTotal = true;
    }
  }
  return {
    inputTokens: sawInput ? input : undefined,
    outputTokens: sawOutput ? output : undefined,
    totalTokens: sawTotal ? total : undefined,
  };
};

const failureKindForVerification = (
  passed: boolean,
  fallback: AgenticFailureKind | undefined
): AgenticFailureKind | undefined =>
  passed ? fallback : "verification-failed";

const verificationStatusFor = (passed: boolean): AgenticVerificationStatus =>
  passed ? "passed" : "failed";

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export async function runMethodAttempt(
  options: MethodAttemptOptions
): Promise<AgenticAttempt> {
  const {
    languageModel,
    maxSteps,
    method,
    model,
    provider,
    requestAttempts,
    requestTimeoutMs,
    run,
    task,
    trace,
  } = options;
  // options.disableThinking reserved for providers that support thinking control
  const startedAt = Date.now();
  let lastError = "";
  const retryFailures: AgenticRetryFailure[] = [];
  const systemPrompt = method.instructions;
  const userPrompt = buildAgenticPrompt(task);

  for (let requestTry = 0; requestTry < requestAttempts; requestTry += 1) {
    const attemptStartedAt = Date.now();
    const requestAttempt = requestTry + 1;
    const events: AgenticToolEvent[] = [];
    const workspace = await setupWorkspace(task.initialFiles);
    let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
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

      const tools = method.createTools(workspace, {
        events,
        requestAttempt,
        run,
        task,
        targetPath: task.path,
        trace,
      });

      agent = await createAgent({
        instructions: systemPrompt,
        model: languageModel ?? provider(model),
        prepareModelStep: createStepCap(maxSteps),
        tools,
      });
      const thread = agent.thread(
        `bench-${method.id}-${task.id}-r${run}-a${requestAttempt}`
      );
      const evalRun = await withTimeout(
        runAgent(thread, userPrompt),
        requestTimeoutMs,
        "agent turn"
      );

      const responseMessagesJson = stringify({
        toolCalls: evalRun.toolCalls,
        toolResults: evalRun.toolResults,
      });
      await trace?.({
        requestAttempt,
        responseMessagesJson,
        run,
        task: task.id,
        text: evalRun.output,
        timestampMs: Date.now(),
        type: "model_response",
      });

      if (evalRun.error !== undefined) {
        throw new Error(evalRun.error);
      }

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
      const usage = sumUsage(evalRun.modelUsage);
      const steps = evalRun.modelUsage.length;

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
        finalText: evalRun.output,
        format: method.id,
        inputTokens: usage.inputTokens,
        model,
        outputTokens: usage.outputTokens,
        passed: verification.passed,
        responseMessagesJson,
        retryFailures,
        run,
        steps,
        task: task.id,
        toolEvents: events,
        toolStatus: summary.toolStatus,
        totalTokens: usage.totalTokens,
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
      if (agent !== undefined) {
        await agent.dispose().catch(() => undefined);
      }
      await cleanupWorkspace(workspace);
    }
  }

  return {
    durationMs: Date.now() - startedAt,
    editCalls: 0,
    editSuccesses: 0,
    failureKind: "transport-failed",
    finalText: "",
    firstEditPassed: false,
    format: method.id,
    inputTokens: undefined,
    model,
    outputTokens: undefined,
    passed: false,
    readCalls: 0,
    recovered: false,
    requestFailure: lastError,
    responseMessagesJson: "[]",
    retryFailures,
    run,
    steps: 0,
    task: task.id,
    toolEvents: [],
    toolStatus: "not-called" satisfies AgenticToolStatus,
    totalTokens: undefined,
    transportStatus: "failed",
    verificationDiagnostics: [],
    verificationStatus: "not-run",
  };
}
