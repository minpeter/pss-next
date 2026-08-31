import { asSchema, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import type { PreparedModelToolChoice } from "./model-step-preparation";

export interface ModelContextTokenEstimateInput {
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
  readonly toolChoice?: PreparedModelToolChoice;
  readonly tools?: readonly ModelPromptTool[];
}

export interface ModelPromptTool {
  readonly args?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly id?: string;
  readonly inputExamples?: readonly unknown[];
  readonly inputSchema?: unknown;
  readonly name: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
  readonly type?: string;
}

/** Product-neutral units measured for one provider-visible model request. */
export interface ModelPromptMeasurement {
  /** Stable identity for fixed prompt content; used for safe marginal calibration. */
  readonly fixedFingerprint: string;
  /** Instructions, tool definitions, tool choice, and request framing. */
  readonly fixedUnits: number;
  /** Marginal cost aligned by index with the input messages. */
  readonly messageUnits: readonly number[];
  readonly totalUnits: number;
}

export interface ModelPromptMeasurementProfile {
  readonly measureMessages: (
    messages: readonly ModelMessage[]
  ) => readonly number[];
  readonly measurePrompt: (
    input: ModelContextTokenEstimateInput
  ) => ModelPromptMeasurement;
}

export const defaultModelPromptMeasurementProfile = Object.freeze({
  measureMessages(messages: readonly ModelMessage[]) {
    return messages.map((message) => countJsonUnits(message));
  },
  measurePrompt(input: ModelContextTokenEstimateInput) {
    const messageUnits = measureDefaultMessageUnits(input.messages);
    const toolChoice = providerPromptToolChoice(input.toolChoice);
    const fixedUnits = countJsonUnits({
      instructions: input.instructions,
      toolChoice,
      tools: input.tools,
    });
    return {
      fixedFingerprint: JSON.stringify(
        {
          instructions: input.instructions,
          toolChoice,
          tools: input.tools,
        },
        promptTokenEstimateReplacer
      ),
      fixedUnits,
      messageUnits,
      totalUnits:
        fixedUnits + messageUnits.reduce((sum, units) => sum + units, 0),
    };
  },
}) satisfies ModelPromptMeasurementProfile;

export function estimateModelMessagesTokens(
  messages: readonly ModelMessage[]
): number {
  return Math.ceil(
    JSON.stringify(messages, promptTokenEstimateReplacer).length / 4
  );
}

function countJsonUnits(value: unknown): number {
  return JSON.stringify(value, promptTokenEstimateReplacer).length / 4;
}

function measureDefaultMessageUnits(
  messages: readonly ModelMessage[]
): readonly number[] {
  return messages.map((message) => countJsonUnits(message));
}

export async function modelPromptTools(
  tools: ToolSet | undefined
): Promise<readonly ModelPromptTool[] | undefined> {
  return (await materializeModelPromptTools(tools)).promptTools;
}

export async function materializeModelPromptTools(
  tools: ToolSet | undefined
): Promise<{
  readonly promptTools?: readonly ModelPromptTool[];
  readonly tools?: ToolSet;
}> {
  if (!tools) {
    return {};
  }
  const entries = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      if (tool.type === "provider") {
        return [
          name,
          tool,
          { args: tool.args, id: tool.id, name, type: tool.type },
        ] as const;
      }
      const description =
        typeof tool.description === "function"
          ? tool.description({
              context: undefined,
            })
          : tool.description;
      const schema = asSchema(tool.inputSchema);
      const resolvedInputSchema = await schema.jsonSchema;
      const promptTool = {
        ...(description === undefined ? {} : { description }),
        ...(tool.inputExamples === undefined
          ? {}
          : { inputExamples: tool.inputExamples }),
        inputSchema: resolvedInputSchema,
        name,
        ...(tool.providerOptions === undefined
          ? {}
          : { providerOptions: tool.providerOptions }),
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        type: "function",
      };
      return [
        name,
        {
          ...tool,
          ...(description === undefined ? {} : { description }),
          inputSchema: jsonSchema(
            resolvedInputSchema,
            schema.validate ? { validate: schema.validate } : undefined
          ),
        },
        promptTool,
      ] as const;
    })
  );
  return {
    promptTools: entries.map((entry) => entry[2]),
    tools: Object.fromEntries(entries.map(([name, tool]) => [name, tool])),
  };
}

function providerPromptToolChoice(
  toolChoice: PreparedModelToolChoice | undefined
): unknown {
  if (toolChoice === undefined) {
    return { type: "auto" };
  }
  return typeof toolChoice === "string" ? { type: toolChoice } : toolChoice;
}

function promptTokenEstimateReplacer(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return binaryPromptTokenEstimate(value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return binaryPromptTokenEstimate(value.byteLength);
  }
  return value;
}

function binaryPromptTokenEstimate(byteLength: number): {
  readonly byteLength: number;
  readonly type: "binary";
} {
  return { byteLength, type: "binary" };
}
