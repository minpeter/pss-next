import { homedir } from "node:os";
import { join } from "node:path";
import { type Agent, createAgent } from "@minpeter/pss-runtime";
import type { LanguageModel } from "ai";
import { assertJsonValue, createExtensionJsonState } from "./json-state";
import { createExtensionExec } from "./process-exec";
import type {
  CodingAgentExtensionAgents,
  CodingAgentExtensionLogger,
  CodingAgentExtensionMode,
  CodingAgentExtensionModelProvider,
  CodingAgentExtensionServices,
  CodingAgentExtensionUi,
  ExtensionJsonValue,
} from "./types";

export interface ExtensionServiceScope {
  readonly dispose: () => Promise<void>;
  readonly services: CodingAgentExtensionServices;
}

export function createExtensionServiceScope(options: {
  readonly config?: Readonly<Record<string, ExtensionJsonValue>>;
  readonly dataRoot?: string;
  readonly extensionId: string;
  readonly mode: CodingAgentExtensionMode;
  readonly model?: LanguageModel;
  readonly providers: ReadonlyMap<string, CodingAgentExtensionModelProvider>;
  readonly signal: AbortSignal;
  readonly ui?: CodingAgentExtensionUi;
  readonly workspace?: string;
}): ExtensionServiceScope {
  const logger = createExtensionLogger(options.extensionId);
  const children: Agent[] = [];
  const agents: CodingAgentExtensionAgents = {
    create: async (
      input: Parameters<CodingAgentExtensionAgents["create"]>[0]
    ) => {
      const model = resolveModel(input.model, options.model, options.providers);
      const agent = await createAgent({
        instructions: input.instructions,
        model,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      });
      if (options.signal.aborted) {
        await agent.dispose();
        throw new Error("Coding agent extension host is disposed");
      }
      children.push(agent);
      return agent;
    },
  };
  const services: CodingAgentExtensionServices = Object.freeze({
    agents,
    config: snapshotConfig(options.config),
    exec: createExtensionExec({
      signal: options.signal,
      workspace: options.workspace ?? process.cwd(),
    }),
    logger,
    state: createExtensionJsonState({
      extensionId: options.extensionId,
      root: options.dataRoot ?? join(homedir(), ".pss", "extension-state"),
    }),
    ui: options.ui ?? createNoninteractiveExtensionUi(options.mode, logger),
  });
  return {
    dispose: async () => {
      const results = await Promise.allSettled(
        children.reverse().map(async (agent) => await agent.dispose())
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Extension "${options.extensionId}" child agent cleanup failed`
        );
      }
    },
    services,
  };
}

function resolveModel(
  requested:
    | {
        readonly id: string;
        readonly provider: string;
      }
    | undefined,
  defaultModel: LanguageModel | undefined,
  providers: ReadonlyMap<string, CodingAgentExtensionModelProvider>
): LanguageModel {
  if (requested === undefined) {
    if (defaultModel === undefined) {
      throw new Error(
        "Extension child agents require a model or a registered model provider"
      );
    }
    return defaultModel;
  }
  const provider = providers.get(requested.provider);
  if (provider === undefined) {
    throw new Error(`Unknown extension model provider "${requested.provider}"`);
  }
  if (!provider.models.includes(requested.id)) {
    throw new Error(
      `Unknown model "${requested.id}" for extension provider "${requested.provider}"`
    );
  }
  return provider.create(requested.id);
}

function snapshotConfig(
  config: Readonly<Record<string, ExtensionJsonValue>> | undefined
): Readonly<Record<string, ExtensionJsonValue>> {
  const value = config ?? {};
  assertJsonValue(value, "Extension config");
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    throw new TypeError("Extension config must be a JSON object");
  }
  return freezeJson(structuredClone(value)) as Readonly<
    Record<string, ExtensionJsonValue>
  >;
}

function freezeJson<Value extends ExtensionJsonValue>(value: Value): Value {
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeJson(item);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      freezeJson(item);
    }
  }
  return Object.freeze(value);
}

function createExtensionLogger(
  extensionId: string
): CodingAgentExtensionLogger {
  const write = (level: string, message: string, data: unknown): void => {
    try {
      process.stderr.write(
        `${JSON.stringify({
          ...(data === undefined ? {} : { data }),
          extensionId,
          level,
          message,
          scope: "coding-agent-extension",
        })}\n`
      );
    } catch {
      return;
    }
  };
  const logger: CodingAgentExtensionLogger = {
    debug: (message: string, data?: unknown) => write("debug", message, data),
    error: (message: string, data?: unknown) => write("error", message, data),
    info: (message: string, data?: unknown) => write("info", message, data),
    warn: (message: string, data?: unknown) => write("warn", message, data),
  };
  return Object.freeze(logger);
}

function createNoninteractiveExtensionUi(
  mode: CodingAgentExtensionMode,
  logger: CodingAgentExtensionLogger
): CodingAgentExtensionUi {
  const reject = <Value>(): Promise<Value> =>
    Promise.reject(
      new Error(`Interactive extension UI is unavailable in ${mode} mode`)
    );
  const ui: CodingAgentExtensionUi = {
    confirm: reject,
    input: reject,
    notify: (message: string) => logger.info(message, { ui: "notification" }),
    select: reject,
    status: (message: string) => {
      logger.info(message, { ui: "status" });
      return () => undefined;
    },
  };
  return Object.freeze(ui);
}
