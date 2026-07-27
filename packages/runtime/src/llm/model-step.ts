import type { ModelMessage } from "ai";
import { hydrateRuntimeAttachments } from "../thread/input/attachments";
import {
  compactionContextForModel,
  type ThreadContextMessage,
} from "../thread/state/context";
import { enforceContextGate } from "./context-gate";
import { ModelToolSelectionError } from "./model-step-error";
import { resolveModelStepOptions } from "./model-step-preparation";
import {
  createModelStepStream,
  type ModelStepStreamPart,
} from "./model-step-stream";
import type {
  ModelPrompt,
  ModelStepOptions,
  ModelStepOutput,
  ModelStepResult,
} from "./model-step-types";
import {
  configuredModelId,
  configuredProvider,
  firstSafeTelemetryIdentifier,
  modelUsageEvent,
} from "./model-usage";
import { assertNoUnsupportedToolApproval } from "./tool-approval";
import { rewriteMessageToolCallIds } from "./tool-call-ids";
import { normalizeToolCallIds } from "./tool-execution-wrapper";

export async function generateModelStep(
  options: ModelStepOptions
): Promise<ModelStepOutput> {
  return (await generateModelStepResult(options)).messages;
}

export async function generateModelStepResult({
  alwaysActiveTools,
  attachmentStore,
  contextGate,
  diagnostics,
  history,
  model,
  instructions,
  maxOutputTokens,
  onStreamEvent,
  prepareModelStep,
  runtimeStepIndex = 0,
  seed,
  signal,
  temperature,
  threadKey,
  toolChoice,
  toolOrder,
  toolExecution,
  tools,
}: ModelStepOptions): Promise<ModelStepResult> {
  if (prepareModelStep && threadKey === undefined) {
    throw new ModelToolSelectionError(
      "prepareModelStep requires a runtime threadKey."
    );
  }
  const attemptId = crypto.randomUUID();
  const historySnapshot = snapshotModelHistory(history);
  const toolCallIds = new Map<string, string>();
  const prepared = await resolveModelStepOptions({
    alwaysActiveTools,
    attemptId,
    diagnostics,
    history: historySnapshot,
    model,
    prepareModelStep,
    runtimeStepIndex,
    signal,
    threadKey,
    toolChoice,
    toolOrder,
    tools,
  });
  const prompt = promptForModel({ history: historySnapshot, instructions });
  const messages = await hydrateRuntimeAttachments(
    prompt.messages,
    attachmentStore
  );
  enforceContextGate({
    contextGate,
    instructions: prompt.instructions,
    messages,
  });
  assertNoUnsupportedToolApproval(prepared.tools);
  const handle = createModelStepStream({
    activeTools: prepared.activeTools,
    abortSignal: signal,
    instructions: prompt.instructions,
    maxOutputTokens,
    messages,
    model: prepared.model,
    seed,
    temperature,
    toolChoice: prepared.toolChoice,
    toolOrder: prepared.toolOrder,
    tools: normalizeToolCallIds(prepared.tools, toolCallIds, toolExecution),
  });
  prepared.startToolCacheFingerprintReport?.();
  let aborted = false;
  try {
    for await (const part of handle.parts) {
      if (part.type === "abort") {
        aborted = true;
        continue;
      }
      const event = mapStreamPartToAgentEvent(part);
      if (event) {
        onStreamEvent?.(event);
      }
    }
    if (aborted || signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const { finalStep, finishReason, response, responseMessages, usage } =
      await handle.finalize();

    return {
      messages: responseMessages.map((message) =>
        rewriteMessageToolCallIds(message, toolCallIds)
      ),
      usage: modelUsageEvent({
        attemptId,
        durationMs: finalStep?.performance.responseTimeMs,
        finishReason,
        modelId: firstSafeTelemetryIdentifier(
          response?.modelId ??
            finalStep?.model.modelId ??
            configuredModelId(prepared.model),
          finalStep?.model.modelId,
          configuredModelId(prepared.model)
        ),
        provider: firstSafeTelemetryIdentifier(
          finalStep?.model.provider,
          configuredProvider(prepared.model)
        ),
        usage,
      }),
    };
  } catch (error) {
    await handle.finalize().then(
      () => undefined,
      () => undefined
    );
    throw error;
  }
}

function mapStreamPartToAgentEvent(part: ModelStepStreamPart) {
  switch (part.type) {
    case "text-delta":
      return { text: part.text, type: "assistant-output-delta" } as const;
    case "reasoning-delta":
      return { text: part.text, type: "assistant-reasoning-delta" } as const;
    case "tool-input-start":
      return {
        toolCallId: part.id,
        toolName: part.toolName,
        type: "tool-call-input-start",
      } as const;
    case "tool-input-delta":
      return {
        inputTextDelta: part.delta,
        toolCallId: part.id,
        type: "tool-call-input-delta",
      } as const;
    case "tool-input-end":
      return {
        toolCallId: part.id,
        type: "tool-call-input-end",
      } as const;
    default:
      return;
  }
}

export function snapshotModelHistory(
  history: readonly ThreadContextMessage[]
): readonly ThreadContextMessage[] {
  if (!Array.isArray(history)) {
    throw new TypeError("history must be an array of model messages.");
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(history, "length");
  } catch {
    throw new TypeError("history has an invalid length descriptor.");
  }
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      typeof lengthDescriptor.value === "number" &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
    )
  ) {
    throw new TypeError("history has an invalid length.");
  }
  const snapshot: ThreadContextMessage[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(history, String(index));
    } catch {
      throw new TypeError("history contains an invalid message descriptor.");
    }
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(
        "history must be a dense array of data-property model messages."
      );
    }
    snapshot.push(descriptor.value as ThreadContextMessage);
  }
  return Object.freeze(snapshot);
}

export function promptForModel({
  history,
  instructions,
}: {
  readonly history: readonly ThreadContextMessage[];
  readonly instructions?: string;
}): ModelPrompt {
  const messages: ModelMessage[] = [];
  const systemContents: string[] = instructions ? [instructions] : [];
  for (const message of history) {
    if (message.role === "compaction") {
      messages.push(compactionContextForModel(message));
      continue;
    }
    if (message.role === "system") {
      systemContents.push(systemContentText(message.content));
      continue;
    }
    messages.push(message);
  }

  return {
    ...(systemContents.length === 0
      ? {}
      : { instructions: systemContents.join("\n\n") }),
    messages,
  };
}

function systemContentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}
