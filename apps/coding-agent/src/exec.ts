import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AgentEvent,
  type AgentOptions,
  isStreamAgentEvent,
} from "@minpeter/pss-runtime";
import { createCodingAgent } from "./coding-agent";
import type { CodingAgentExtensionInput } from "./extensions";
import { createCodingAgentExtensionHost } from "./extensions";
import type { WebToolsAvailability } from "./tools";

interface TokenUsageSummary {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

interface ExecState {
  error?: string;
  finalText: string;
  status: CodingAgentExecResult["status"];
  usage: TokenUsageSummary;
}

interface TextOutput {
  write(text: string): unknown;
}

export interface CodingAgentExecResult {
  readonly durationMs: number;
  readonly error?: string;
  readonly events: readonly AgentEvent[];
  readonly finalText: string;
  readonly modelIds: readonly string[];
  readonly status: "aborted" | "completed" | "error";
  readonly usage: TokenUsageSummary;
}

export interface RunCodingAgentExecOptions {
  readonly extensions?: readonly CodingAgentExtensionInput[];
  readonly model: AgentOptions["model"];
  readonly prompt: string;
  readonly resultFile?: string;
  readonly stdout?: TextOutput;
  readonly timeoutMs?: number;
  readonly webToolsAvailability?: WebToolsAvailability;
  readonly workspace: string;
}

function addUsage(
  summary: TokenUsageSummary,
  event: Extract<AgentEvent, { type: "model-usage" }>
): TokenUsageSummary {
  return {
    cacheReadTokens: summary.cacheReadTokens + (event.cacheReadTokens ?? 0),
    cacheWriteTokens: summary.cacheWriteTokens + (event.cacheWriteTokens ?? 0),
    inputTokens: summary.inputTokens + (event.inputTokens ?? 0),
    outputTokens: summary.outputTokens + (event.outputTokens ?? 0),
    reasoningTokens: summary.reasoningTokens + (event.reasoningTokens ?? 0),
    totalTokens: summary.totalTokens + (event.totalTokens ?? 0),
  };
}

function writeJsonLine(output: TextOutput, value: unknown): void {
  output.write(
    `${JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item
    )}\n`
  );
}

function recordEvent(
  state: ExecState,
  modelIds: Set<string>,
  event: AgentEvent
): void {
  switch (event.type) {
    case "assistant-output":
      state.finalText += event.text;
      return;
    case "model-usage":
      state.usage = addUsage(state.usage, event);
      if (event.modelId !== undefined) {
        modelIds.add(event.modelId);
      }
      return;
    case "turn-end":
      state.status = "completed";
      return;
    case "turn-abort":
      state.status = "aborted";
      return;
    case "turn-error":
      state.status = "error";
      state.error = event.message;
      return;
    default:
      return;
  }
}

export async function runCodingAgentExec({
  extensions = [],
  model,
  prompt,
  resultFile,
  stdout = process.stdout,
  timeoutMs = 20 * 60 * 1000,
  webToolsAvailability = "disabled",
  workspace,
}: RunCodingAgentExecOptions): Promise<CodingAgentExecResult> {
  const startedAt = performance.now();
  const events: AgentEvent[] = [];
  const modelIds = new Set<string>();
  const state: ExecState = {
    finalText: "",
    status: "error",
    usage: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  };
  const absoluteWorkspace = resolve(workspace);
  const extensionHost = await createCodingAgentExtensionHost(extensions);
  let agent: Awaited<ReturnType<typeof createCodingAgent>>;
  try {
    agent = await createCodingAgent({
      extensionHost,
      model,
      webTools: { webToolsAvailability },
      workspace: absoluteWorkspace,
    });
  } catch (error) {
    await extensionHost.dispose();
    throw error;
  }
  try {
    await extensionHost.activate(agent, "exec");
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      agent.dispose(),
      extensionHost.dispose(),
    ]);
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Coding agent extension activation and cleanup failed"
      );
    }
    throw error;
  }
  const thread = agent.thread(`exec:${randomUUID()}`);
  let timeoutFired = false;
  const timeout = setTimeout(() => {
    timeoutFired = true;
    thread.interrupt();
  }, timeoutMs);
  writeJsonLine(stdout, {
    model: typeof model === "string" ? model : model.modelId,
    schema: "pss-headless-v1",
    startedAt: new Date().toISOString(),
    type: "metadata",
    workspace: absoluteWorkspace,
  });

  try {
    const turn = await thread.send(prompt);
    // If the timer fired while send() was still starting, interrupt() was a
    // no-op; interrupt again now that the turn is active.
    if (timeoutFired) {
      thread.interrupt();
    }
    for await (const event of turn.events()) {
      // Stream deltas stream to stdout but stay out of the accumulated
      // result payload; only committed events are durable.
      if (!isStreamAgentEvent(event)) {
        events.push(event);
      }
      writeJsonLine(stdout, { event, type: "agent_event" });
      recordEvent(state, modelIds, event);
    }
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
    state.status = "error";
  } finally {
    clearTimeout(timeout);
    const cleanupFailures: unknown[] = [];
    for (const cleanup of [
      () => agent.dispose(),
      () => extensionHost.dispose(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0 && state.error === undefined) {
      state.error = cleanupFailures
        .map((failure) =>
          failure instanceof Error ? failure.message : String(failure)
        )
        .join("; ");
      state.status = "error";
    }
  }

  const result: CodingAgentExecResult = {
    durationMs: Math.round(performance.now() - startedAt),
    ...(state.error === undefined ? {} : { error: state.error }),
    events,
    finalText: state.finalText,
    modelIds: [...modelIds],
    status: state.status,
    usage: state.usage,
  };
  writeJsonLine(stdout, { result, type: "result" });
  if (resultFile !== undefined) {
    await writeFile(
      resolve(resultFile),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8"
    );
  }
  return result;
}
