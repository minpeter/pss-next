import type { LanguageModel } from "ai";
import { isRecord as isObjectRecord } from "../internal/guards";
import { ModelToolSelectionError } from "./model-step-error";
import type {
  PreparedModelToolChoice,
  PrepareModelStep,
  PrepareModelStepResult,
} from "./model-step-preparation-types";
import {
  dataPropertyInPrototypeChain,
  isPlainRecord,
  MISSING_DATA_PROPERTY,
  ownDataProperty,
  ownProperty,
  propertyCanProvideValue,
  propertyDescriptorInPrototypeChain,
} from "./tool-property-descriptors";
import { snapshotToolNames } from "./tool-registry-snapshot";

const PREPARED_RESULT_KEYS = new Set(["activeTools", "model", "toolChoice"]);

export function mapPrepareModelStepModel(
  prepareModelStep: PrepareModelStep,
  mapModel: (
    model: Exclude<LanguageModel, string>
  ) => Exclude<LanguageModel, string>
): PrepareModelStep {
  return async (input) => {
    const prepared = parsePrepareModelStepResult(
      await prepareModelStep(input),
      Object.keys(input.tools).length
    );
    if (prepared?.model === undefined) {
      return prepared;
    }
    return {
      ...prepared,
      model: mapModel(prepared.model),
    };
  };
}

export function parsePrepareModelStepResult(
  value: unknown,
  registeredToolCount: number
): PrepareModelStepResult | undefined {
  if (value === undefined) {
    return;
  }
  if (!isPlainRecord(value)) {
    throw new ModelToolSelectionError(
      "prepareModelStep must return a plain object or undefined."
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !PREPARED_RESULT_KEYS.has(key)) {
      throw new ModelToolSelectionError(
        `prepareModelStep returned unsupported field ${JSON.stringify(String(key))}.`
      );
    }
  }
  const activeTools = ownDataProperty(value, "activeTools", "prepareModelStep");
  const model = ownDataProperty(value, "model", "prepareModelStep");
  const toolChoice = ownDataProperty(value, "toolChoice", "prepareModelStep");
  if (activeTools !== undefined && !Array.isArray(activeTools)) {
    throw new ModelToolSelectionError(
      "prepareModelStep activeTools must be an array of tool names."
    );
  }
  const activeToolSnapshot =
    activeTools === undefined
      ? undefined
      : snapshotToolNames(
          activeTools,
          "prepareModelStep activeTools",
          registeredToolCount
        );
  if (model !== undefined && !isLanguageModelObject(model)) {
    throw new ModelToolSelectionError(
      "prepareModelStep model must implement an AI SDK v2, v3, or v4 language model."
    );
  }
  return {
    ...(activeToolSnapshot === undefined
      ? {}
      : { activeTools: activeToolSnapshot }),
    ...(model === undefined ? {} : { model }),
    ...(toolChoice === undefined
      ? {}
      : {
          toolChoice: snapshotToolChoice(toolChoice) as PreparedModelToolChoice,
        }),
  };
}

export function snapshotToolChoice(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new ModelToolSelectionError(
        "toolChoice must contain only named string fields."
      );
    }
    snapshot[key] = ownDataProperty(value, key, "toolChoice");
  }
  return Object.freeze(snapshot);
}

function isLanguageModelObject(
  value: unknown
): value is Exclude<LanguageModel, string> {
  if (!isObjectRecord(value) || Array.isArray(value)) {
    return false;
  }
  const specificationVersion = dataPropertyInPrototypeChain(
    value,
    "specificationVersion"
  );
  const provider = propertyDescriptorInPrototypeChain(value, "provider");
  const modelId = dataPropertyInPrototypeChain(value, "modelId");
  const supportedUrls = propertyDescriptorInPrototypeChain(
    value,
    "supportedUrls"
  );
  const doGenerate = dataPropertyInPrototypeChain(value, "doGenerate");
  const doStream = dataPropertyInPrototypeChain(value, "doStream");
  return (
    (specificationVersion === "v2" ||
      specificationVersion === "v3" ||
      specificationVersion === "v4") &&
    propertyCanProvideValue(provider, "string") &&
    typeof modelId === "string" &&
    propertyCanProvideValue(supportedUrls) &&
    typeof doGenerate === "function" &&
    (doStream === MISSING_DATA_PROPERTY ||
      doStream === undefined ||
      typeof doStream === "function")
  );
}

export function validateToolChoice(
  toolChoice: PreparedModelToolChoice | undefined,
  registry: ReadonlySet<string>,
  activeTools: ReadonlySet<string>
): void {
  if (
    toolChoice === undefined ||
    toolChoice === "auto" ||
    toolChoice === "none"
  ) {
    return;
  }
  if (toolChoice === "required" && activeTools.size === 0) {
    throw new ModelToolSelectionError(
      'toolChoice "required" cannot be used without an active tool.'
    );
  }
  if (toolChoice === "required") {
    return;
  }
  if (
    !isPlainRecord(toolChoice) ||
    ownProperty(toolChoice, "type") !== "tool"
  ) {
    throw new ModelToolSelectionError(
      'toolChoice must be "auto", "none", "required", or a named tool selection.'
    );
  }
  if (
    Reflect.ownKeys(toolChoice).some(
      (key) => typeof key !== "string" || (key !== "type" && key !== "toolName")
    )
  ) {
    throw new ModelToolSelectionError(
      "named toolChoice may contain only type and toolName."
    );
  }
  const name = ownProperty(toolChoice, "toolName");
  if (typeof name !== "string" || !registry.has(name)) {
    throw new ModelToolSelectionError(
      `toolChoice references unknown tool ${JSON.stringify(name)}.`
    );
  }
  if (!activeTools.has(name)) {
    throw new ModelToolSelectionError(
      `toolChoice references inactive tool ${JSON.stringify(name)}.`
    );
  }
}
