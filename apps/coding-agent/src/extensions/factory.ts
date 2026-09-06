import type { AgentEvent } from "@minpeter/pss-runtime";
import type { ValidatedCodingAgentExtensionInput } from "./host-validation";
import type {
  CodingAgentExtension,
  CodingAgentExtensionActivationHandler,
  CodingAgentExtensionApi,
  CodingAgentExtensionCleanup,
  CodingAgentExtensionEventHandler,
  CodingAgentExtensionModule,
  CodingAgentExtensionRegistry,
} from "./types";

type CodingAgentExtensionRegistration =
  | {
      readonly [Type in AgentEvent["type"]]: readonly [
        type: Type,
        handler: CodingAgentExtensionEventHandler<Type>,
      ];
    }[AgentEvent["type"]]
  | readonly [type: "activate", handler: CodingAgentExtensionActivationHandler];

export function normalizeCodingAgentExtension({
  id,
  input,
}: ValidatedCodingAgentExtensionInput): CodingAgentExtension {
  if ("configure" in input) {
    return {
      ...(input.activate === undefined ? {} : { activate: input.activate }),
      ...(input.config === undefined ? {} : { config: input.config }),
      configure: input.configure,
      id,
    };
  }
  if (typeof input.default !== "function") {
    throw new TypeError(
      `Coding agent extension "${id}" default export must be a function`
    );
  }
  return factoryModuleToExtension(input, id);
}

function factoryModuleToExtension(
  extensionModule: CodingAgentExtensionModule,
  extensionId: string
): CodingAgentExtension {
  const activationHandlers: CodingAgentExtensionActivationHandler[] = [];
  return {
    ...(extensionModule.config === undefined
      ? {}
      : { config: extensionModule.config }),
    id: extensionId,
    async configure(registry, { signal }) {
      let open = true;
      try {
        const result = extensionModule.default(
          createFactoryApi(
            registry,
            activationHandlers,
            extensionId,
            () => open && !signal.aborted
          )
        );
        if (isPromiseLike(result)) {
          await result;
        }
      } finally {
        open = false;
      }
    },
    async activate(context) {
      const cleanups: CodingAgentExtensionCleanup[] = [];
      try {
        for (const handler of activationHandlers) {
          const cleanup = await handler(context);
          if (cleanup !== undefined && typeof cleanup !== "function") {
            throw new TypeError(
              `Coding agent extension "${extensionId}" activation handler must return a cleanup function`
            );
          }
          if (cleanup !== undefined) {
            cleanups.push(cleanup);
          }
        }
      } catch (error) {
        await disposeCleanups(cleanups);
        throw error;
      }
      return async () => {
        await disposeCleanups(cleanups);
      };
    },
  };
}

function createFactoryApi(
  registry: CodingAgentExtensionRegistry,
  activationHandlers: CodingAgentExtensionActivationHandler[],
  extensionId: string,
  isOpen: () => boolean
): CodingAgentExtensionApi {
  const assertOpen = () => {
    if (!isOpen()) {
      throw new Error(
        `Coding agent extension "${extensionId}" registration is closed`
      );
    }
  };
  function on<Type extends AgentEvent["type"]>(
    type: Type,
    handler: CodingAgentExtensionEventHandler<Type>
  ): void;
  function on(
    type: "activate",
    handler: CodingAgentExtensionActivationHandler
  ): void;
  function on(...[type, handler]: CodingAgentExtensionRegistration): void {
    assertOpen();
    if (type === "activate") {
      if (typeof handler !== "function") {
        throw new TypeError(
          'Extension event "activate" handler must be a function'
        );
      }
      activationHandlers.push(handler);
      return;
    }
    switch (type) {
      case "assistant-output":
        registry.on(type, handler);
        return;
      case "assistant-output-delta":
        registry.on(type, handler);
        return;
      case "assistant-reasoning":
        registry.on(type, handler);
        return;
      case "assistant-reasoning-delta":
        registry.on(type, handler);
        return;
      case "context-usage":
        registry.on(type, handler);
        return;
      case "model-attempt":
        registry.on(type, handler);
        return;
      case "model-retry":
        registry.on(type, handler);
        return;
      case "model-usage":
        registry.on(type, handler);
        return;
      case "runtime-input":
        registry.on(type, handler);
        return;
      case "step-end":
        registry.on(type, handler);
        return;
      case "step-start":
        registry.on(type, handler);
        return;
      case "tool-call":
        registry.on(type, handler);
        return;
      case "tool-call-input-delta":
        registry.on(type, handler);
        return;
      case "tool-call-input-end":
        registry.on(type, handler);
        return;
      case "tool-call-input-start":
        registry.on(type, handler);
        return;
      case "tool-result":
        registry.on(type, handler);
        return;
      case "turn-abort":
        registry.on(type, handler);
        return;
      case "turn-end":
        registry.on(type, handler);
        return;
      case "turn-error":
        registry.on(type, handler);
        return;
      case "turn-start":
        registry.on(type, handler);
        return;
      case "user-input":
        registry.on(type, handler);
        return;
      default:
        throw new TypeError(`Unknown extension event "${type}"`);
    }
  }
  const provide: CodingAgentExtensionApi["provide"] = (capability) => {
    assertOpen();
    registry.provide(capability);
  };
  const use: CodingAgentExtensionApi["use"] = (hooks) => {
    assertOpen();
    registry.use(hooks);
  };

  return Object.freeze({
    on,
    provide,
    use,
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

async function disposeCleanups(
  cleanups: readonly CodingAgentExtensionCleanup[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    const outcome = await Promise.resolve()
      .then(cleanup)
      .then(
        () => ({ kind: "success" as const }),
        (error: unknown) => ({ error, kind: "failure" as const })
      );
    if (outcome.kind === "failure") {
      failures.push(outcome.error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Coding agent extension cleanup failed");
  }
}
