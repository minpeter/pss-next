import type { TuiCommand, TuiCommandResult } from "./command";

export interface CreateModelCommandOptions {
  /** Current model id for markers and messages. */
  readonly currentModelId: () => string;
  /** Provider model catalog (OpenAI-compatible `/models`). */
  readonly listModelIds: () => Promise<string[]>;
  /** Applies the switch and refreshes any session labels. */
  readonly switchModel: (modelId: string) => void;
}

/**
 * `/model` — interactive model selector.
 *
 * - `/model` asks the TUI to open its pi-style inline picker
 *   (`select-model` action).
 * - `/model <id>` switches directly; the id is validated against the
 *   catalog when the provider exposes one.
 * - `/model list` prints the catalog.
 */
export const createModelCommand = (
  options: CreateModelCommandOptions
): TuiCommand => ({
  name: "model",
  aliases: ["models"],
  argumentSuggestions: ["list"],
  description: "Show or switch the active model",
  execute: async ({ args }): Promise<TuiCommandResult> => {
    const requested = args[0]?.trim();

    if (requested === undefined || requested === "") {
      return { success: true, action: { type: "select-model" } };
    }
    if (requested === "list") {
      return await printModelList(options);
    }
    return await switchToModel(options, requested);
  },
});

async function printModelList(
  options: CreateModelCommandOptions
): Promise<TuiCommandResult> {
  const current = options.currentModelId();
  const catalog = await loadCatalog(options);
  if (catalog.error !== undefined || catalog.ids.length === 0) {
    return {
      success: false,
      message: catalogUnavailableMessage(current, catalog.error),
    };
  }
  const lines = catalog.ids.map((id) => `${id === current ? "* " : "  "}${id}`);
  return {
    success: true,
    message: [
      "Available models (* = current). Switch with /model <id>:",
      ...lines,
    ].join("\n"),
  };
}

async function switchToModel(
  options: CreateModelCommandOptions,
  requested: string
): Promise<TuiCommandResult> {
  const current = options.currentModelId();
  if (requested === current) {
    return { success: true, message: `Model unchanged (${current}).` };
  }

  const catalog = await loadCatalog(options);
  if (catalog.error === undefined && !catalog.ids.includes(requested)) {
    return {
      success: false,
      message: `Unknown model ${JSON.stringify(requested)}. Run /model to pick from the catalog.`,
    };
  }

  const result = applySwitch(options, requested);
  if (catalog.error !== undefined && result.success) {
    return {
      ...result,
      message: `${result.message} (catalog unavailable; the id was not validated)`,
    };
  }
  return result;
}

function applySwitch(
  options: CreateModelCommandOptions,
  modelId: string
): TuiCommandResult {
  try {
    options.switchModel(modelId);
  } catch (error) {
    return {
      success: false,
      message: `Model switch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    action: { type: "refresh-header" },
    success: true,
    message: `Model switched to ${modelId}. New steps use it immediately.`,
  };
}

async function loadCatalog(options: CreateModelCommandOptions): Promise<{
  readonly ids: string[];
  readonly error?: string;
}> {
  try {
    return { ids: await options.listModelIds() };
  } catch (error) {
    return {
      ids: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function catalogUnavailableMessage(
  current: string,
  error: string | undefined
): string {
  return [
    `Current model: ${current}.`,
    error === undefined
      ? "The provider returned an empty model catalog."
      : `Could not list models: ${error}`,
    "Switch directly with /model <model-id>.",
  ].join(" ");
}
