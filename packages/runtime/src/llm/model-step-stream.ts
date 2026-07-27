import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolChoice,
  type ToolSet,
} from "ai";

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

export interface ModelStepStreamOptions {
  readonly abortSignal?: AbortSignal;
  readonly activeTools?: readonly string[];
  readonly instructions?: string;
  readonly maxOutputTokens?: number;
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly seed?: number;
  readonly temperature?: number;
  readonly toolChoice?: ToolChoice<ToolSet>;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export interface ModelStepStreamFinalResult {
  readonly finalStep: GenerateTextResult["finalStep"];
  readonly finishReason: GenerateTextResult["finishReason"];
  readonly response: GenerateTextResult["response"];
  readonly responseMessages: GenerateTextResult["responseMessages"];
  readonly usage: GenerateTextResult["usage"];
}

export interface ModelStepStreamHandle {
  finalize(): Promise<ModelStepStreamFinalResult>;
  readonly parts: AsyncIterable<ModelStepStreamPart>;
}

type ModelStepTextPart = {
  readonly id: string;
  readonly providerMetadata?: unknown;
} & (
  | { readonly type: "text-start" | "text-end" }
  | { readonly text: string; readonly type: "text-delta" }
);

type ModelStepReasoningPart = {
  readonly id: string;
  readonly providerMetadata?: unknown;
} & (
  | { readonly type: "reasoning-start" | "reasoning-end" }
  | { readonly text: string; readonly type: "reasoning-delta" }
);

type ModelStepToolInputPart =
  | {
      readonly dynamic?: boolean;
      readonly id: string;
      readonly providerExecuted?: boolean;
      readonly providerMetadata?: unknown;
      readonly title?: string;
      readonly toolMetadata?: unknown;
      readonly toolName: string;
      readonly type: "tool-input-start";
    }
  | {
      readonly delta: string;
      readonly id: string;
      readonly providerMetadata?: unknown;
      readonly type: "tool-input-delta";
    }
  | {
      readonly id: string;
      readonly providerMetadata?: unknown;
      readonly type: "tool-input-end";
    };

type ModelStepLifecyclePart =
  | { readonly type: "start" }
  | {
      readonly request: unknown;
      readonly type: "start-step";
      readonly warnings: readonly unknown[];
    }
  | {
      readonly finishReason: string;
      readonly performance: unknown;
      readonly providerMetadata?: unknown;
      readonly rawFinishReason: string | undefined;
      readonly response: unknown;
      readonly type: "finish-step";
      readonly usage: unknown;
    }
  | {
      readonly finishReason: string;
      readonly rawFinishReason: string | undefined;
      readonly totalUsage: unknown;
      readonly type: "finish";
    }
  | { readonly reason?: string; readonly type: "abort" }
  | { readonly error: unknown; readonly type: "error" };

interface ModelStepOpaquePart {
  readonly type:
    | "custom"
    | "file"
    | "raw"
    | "reasoning-file"
    | "source"
    | "tool-approval-request"
    | "tool-approval-response"
    | "tool-call"
    | "tool-error"
    | "tool-output-denied"
    | "tool-result";
  readonly [key: string]: unknown;
}

export type ModelStepStreamPart =
  | ModelStepTextPart
  | ModelStepReasoningPart
  | ModelStepToolInputPart
  | ModelStepLifecyclePart
  | ModelStepOpaquePart;

export function createModelStepStream(
  options: ModelStepStreamOptions
): ModelStepStreamHandle {
  if (hasDoStream(options.model)) {
    return streamingModelStep(options);
  }
  return generatedModelStep(options);
}

function streamingModelStep(
  options: ModelStepStreamOptions
): ModelStepStreamHandle {
  let streamFailure: { readonly error: unknown } | undefined;
  const result = streamText({
    ...options,
    onError: ({ error }) => {
      streamFailure ??= { error };
    },
  });
  let finalization: Promise<ModelStepStreamFinalResult> | undefined;
  return {
    parts: result.stream as AsyncIterable<ModelStepStreamPart>,
    finalize() {
      finalization ??= finalizeStreamingModelStep(result, () => streamFailure);
      return finalization;
    },
  };
}

function generatedModelStep(
  options: ModelStepStreamOptions
): ModelStepStreamHandle {
  const result = generateText(options);
  let finalization: Promise<ModelStepStreamFinalResult> | undefined;
  return {
    parts: synthesizedParts(result),
    finalize() {
      finalization ??= result.then(finalResultFromGenerateText);
      return finalization;
    },
  };
}

async function* synthesizedParts(
  resultPromise: Promise<GenerateTextResult>
): AsyncIterable<ModelStepStreamPart> {
  const result = await resultPromise;
  let reasoningIndex = 0;
  for (const part of result.content) {
    if (part.type === "reasoning") {
      yield {
        id: `reasoning-${reasoningIndex}`,
        text: part.text,
        type: "reasoning-delta",
      };
      reasoningIndex += 1;
    }
  }

  let textIndex = 0;
  for (const part of result.content) {
    if (part.type === "text") {
      yield {
        id: `text-${textIndex}`,
        text: part.text,
        type: "text-delta",
      };
      textIndex += 1;
      continue;
    }
    if (part.type !== "tool-call") {
      continue;
    }
    yield {
      id: part.toolCallId,
      toolName: part.toolName,
      type: "tool-input-start",
    };
    yield {
      delta: serializeToolInput(part.input),
      id: part.toolCallId,
      type: "tool-input-delta",
    };
    yield { id: part.toolCallId, type: "tool-input-end" };
  }
}

function serializeToolInput(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) {
    throw new TypeError("Generated tool input is not JSON-serializable.");
  }
  return serialized;
}

async function finalizeStreamTextResult(
  result: ReturnType<typeof streamText>
): Promise<ModelStepStreamFinalResult> {
  const [responseMessages, usage, finalStep, finishReason, response] =
    await Promise.all([
      result.responseMessages,
      result.usage,
      result.finalStep,
      result.finishReason,
      result.response,
    ]);
  return { finalStep, finishReason, response, responseMessages, usage };
}

async function finalizeStreamingModelStep(
  result: ReturnType<typeof streamText>,
  getStreamFailure: () => { readonly error: unknown } | undefined
): Promise<ModelStepStreamFinalResult> {
  try {
    return await finalizeStreamTextResult(result);
  } catch (error) {
    throw getStreamFailure()?.error ?? error;
  }
}

function finalResultFromGenerateText(
  result: GenerateTextResult
): ModelStepStreamFinalResult {
  const { finalStep, finishReason, response, responseMessages, usage } = result;
  return { finalStep, finishReason, response, responseMessages, usage };
}

function hasDoStream(model: LanguageModel): boolean {
  return (
    typeof model === "object" &&
    model !== null &&
    typeof (model as { readonly doStream?: unknown }).doStream === "function"
  );
}
