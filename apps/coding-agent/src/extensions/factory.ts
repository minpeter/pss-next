import type { AgentEvent } from "@minpeter/pss-runtime";
import type {
  CodingAgentExtension,
  CodingAgentExtensionActivationHandler,
  CodingAgentExtensionApi,
  CodingAgentExtensionCleanup,
  CodingAgentExtensionEventHandler,
  CodingAgentExtensionInput,
  CodingAgentExtensionModule,
  CodingAgentExtensionRegistry,
} from "./types";

export function normalizeCodingAgentExtension(
  input: CodingAgentExtensionInput
): CodingAgentExtension {
  if ("configure" in input) {
    return input;
  }
  if (typeof input.default !== "function") {
    throw new TypeError(
      `Coding agent extension "${input.id}" default export must be a function`
    );
  }
  return factoryModuleToExtension(input);
}

function factoryModuleToExtension(
  extensionModule: CodingAgentExtensionModule
): CodingAgentExtension {
  const activationHandlers: CodingAgentExtensionActivationHandler[] = [];
  return {
    id: extensionModule.id,
    async configure(registry, { signal }) {
      let open = true;
      try {
        const result = extensionModule.default(
          createFactoryApi(
            registry,
            activationHandlers,
            extensionModule.id,
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
              `Coding agent extension "${extensionModule.id}" activation handler must return a cleanup function`
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
  const on = ((
    type: AgentEvent["type"] | "activate",
    handler:
      | CodingAgentExtensionActivationHandler
      | CodingAgentExtensionEventHandler<AgentEvent["type"]>
  ) => {
    assertOpen();
    if (type === "activate") {
      if (typeof handler !== "function") {
        throw new TypeError(
          'Extension event "activate" handler must be a function'
        );
      }
      activationHandlers.push(handler as CodingAgentExtensionActivationHandler);
      return;
    }
    registry.on(type, handler as CodingAgentExtensionEventHandler<typeof type>);
  }) as CodingAgentExtensionApi["on"];
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
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Coding agent extension cleanup failed");
  }
}
