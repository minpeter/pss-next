import type { LoadedConfiguredExtensions } from "../extensions";
import type { TuiCommand } from "./command";
import type { ToolRendererMap } from "./tool-call-view";

interface ReloadableAgent {
  dispose(): Promise<void>;
}

interface ReloadableHost {
  dispose(): Promise<void>;
}

export interface ExtensionRuntimeSwap<
  Agent extends ReloadableAgent,
  Host extends ReloadableHost,
> {
  readonly agent: Agent;
  readonly commands: readonly TuiCommand[];
  readonly host: Host;
  readonly loadedExtensions: LoadedConfiguredExtensions["extensions"];
  readonly notices: readonly string[];
  readonly toolRenderers: ToolRendererMap;
}

/** Reload result plus an optional module-cache rollback for failures. */
export type ReloadableExtensions = LoadedConfiguredExtensions & {
  readonly rollbackModuleCache?: () => void;
};

/**
 * Build and install a full replacement extension runtime for `/reload`.
 *
 * Phases and failure semantics:
 *
 * 1. Discovery, host configuration, TUI merges, validation, and agent
 *    construction all happen while the previous runtime keeps running; any
 *    failure here disposes the partial replacement, rolls back the module
 *    cache, and leaves the session untouched.
 * 2. The previous runtime is then disposed *before* the replacement
 *    activates so old cleanup can never write extension state behind the
 *    already-active replacement.
 * 3. If replacement activation fails after that point, the replacement is
 *    disposed, the module cache rolls back, and `recoverPrevious` rebuilds a
 *    runtime from the previous extension inputs so the session stays usable.
 */
export async function buildReloadedExtensionRuntime<
  Agent extends ReloadableAgent,
  Host extends ReloadableHost,
>(options: {
  readonly activateHost: (host: Host, agent: Agent) => Promise<void>;
  readonly createAgent: (host: Host) => Promise<Agent>;
  readonly createHost: (loaded: LoadedConfiguredExtensions) => Promise<Host>;
  /** Bounded cleanup of the previous runtime; returns cleanup notices. */
  readonly disposePrevious: () => Promise<readonly string[]>;
  readonly loadExtensions: () => Promise<ReloadableExtensions>;
  readonly mergeCommands: (host: Host) => readonly TuiCommand[];
  readonly mergeToolRenderers: (host: Host) => ToolRendererMap;
  /** Rebuild a runtime from the previous inputs after activation failure. */
  readonly recoverPrevious: () => Promise<void>;
  /** Pre-swap validation, e.g. committing migrations for the stored thread. */
  readonly validateHost?: (host: Host) => Promise<void>;
}): Promise<ExtensionRuntimeSwap<Agent, Host>> {
  const loaded = await options.loadExtensions();
  let host: Host | undefined;
  let agent: Agent | undefined;
  let commands: readonly TuiCommand[];
  let toolRenderers: ToolRendererMap;
  try {
    host = await options.createHost(loaded);
    // Validate TUI-facing merges before activation so conflicts abort early.
    commands = options.mergeCommands(host);
    toolRenderers = options.mergeToolRenderers(host);
    await options.validateHost?.(host);
    agent = await options.createAgent(host);
  } catch (error) {
    await disposeSettled(agent, host);
    // The live runtime keeps running, so hand it back the CommonJS modules
    // the failed reload evicted.
    loaded.rollbackModuleCache?.();
    throw error;
  }
  const cleanupNotices = await options.disposePrevious();
  try {
    await options.activateHost(host, agent);
  } catch (activationError) {
    await disposeSettled(agent, host);
    loaded.rollbackModuleCache?.();
    try {
      await options.recoverPrevious();
    } catch (recoveryError) {
      throw new AggregateError(
        [activationError, recoveryError],
        "Extension reload activation failed and the previous runtime could not be recovered; restart pss"
      );
    }
    throw activationError;
  }
  return {
    agent,
    commands,
    host,
    loadedExtensions: loaded.extensions,
    notices: [...loaded.notices, ...cleanupNotices],
    toolRenderers,
  };
}

async function disposeSettled(
  agent: ReloadableAgent | undefined,
  host: ReloadableHost | undefined
): Promise<void> {
  await Promise.allSettled([
    agent === undefined ? Promise.resolve() : agent.dispose(),
    host === undefined ? Promise.resolve() : host.dispose(),
  ]);
}

const DEFAULT_PREVIOUS_RUNTIME_CLEANUP_TIMEOUT_MS = 10_000;

export async function disposePreviousExtensionRuntime(options: {
  readonly agent: ReloadableAgent;
  readonly disposeThread: () => Promise<void>;
  readonly host: { dispose(): Promise<void> };
  /** Bounds extension-controlled cleanup so `/reload` cannot hang on it. */
  readonly timeoutMs?: number;
}): Promise<readonly string[]> {
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_PREVIOUS_RUNTIME_CLEANUP_TIMEOUT_MS;
  const notices: string[] = [];
  const results = await Promise.allSettled([
    bounded(options.disposeThread(), timeoutMs),
    bounded(options.agent.dispose(), timeoutMs),
    bounded(options.host.dispose(), timeoutMs),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      notices.push(
        `Previous extension runtime cleanup failed: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`
      );
    }
  }
  return notices;
}

function bounded(task: Promise<void>, timeoutMs: number): Promise<void> {
  // Late settlement is intentionally detached; the replacement runtime is
  // already live and must not wait on abandoned cleanup.
  task.catch(() => undefined);
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new Error(`cleanup did not settle within ${timeoutMs}ms; detached`)
      );
    }, timeoutMs);
    task.then(
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    );
  });
}
