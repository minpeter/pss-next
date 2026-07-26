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
  readonly notices: readonly string[];
  readonly toolRenderers: ToolRendererMap;
}

/**
 * Build a full replacement extension runtime for `/reload`.
 *
 * Ordering is fail-safe: the replacement host, agent, command set, and
 * renderer set are fully constructed and activated before the caller swaps
 * anything, so a failing reload leaves the current session untouched. On
 * failure every partially created resource is disposed and the original
 * error is rethrown.
 */
export async function buildReloadedExtensionRuntime<
  Agent extends ReloadableAgent,
  Host extends ReloadableHost,
>(options: {
  readonly activateHost: (host: Host, agent: Agent) => Promise<void>;
  readonly createAgent: (host: Host) => Promise<Agent>;
  readonly createHost: (loaded: LoadedConfiguredExtensions) => Promise<Host>;
  readonly loadExtensions: () => Promise<LoadedConfiguredExtensions>;
  readonly mergeCommands: (host: Host) => readonly TuiCommand[];
  readonly mergeToolRenderers: (host: Host) => ToolRendererMap;
}): Promise<ExtensionRuntimeSwap<Agent, Host>> {
  const loaded = await options.loadExtensions();
  const host = await options.createHost(loaded);
  let agent: Agent | undefined;
  try {
    // Validate TUI-facing merges before activation so conflicts abort early.
    const commands = options.mergeCommands(host);
    const toolRenderers = options.mergeToolRenderers(host);
    agent = await options.createAgent(host);
    await options.activateHost(host, agent);
    return {
      agent,
      commands,
      host,
      notices: loaded.notices,
      toolRenderers,
    };
  } catch (error) {
    const cleanups = await Promise.allSettled([
      agent === undefined ? Promise.resolve() : agent.dispose(),
      host.dispose(),
    ]);
    const cleanupFailures = cleanups.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Extension reload and cleanup failed"
      );
    }
    throw error;
  }
}

/**
 * Dispose the previous extension runtime after a successful swap. Failures
 * are reported as notices instead of failing the reload because the
 * replacement runtime is already live.
 */
export async function disposePreviousExtensionRuntime(options: {
  readonly agent: ReloadableAgent;
  readonly disposeThread: () => Promise<void>;
  readonly host: { dispose(): Promise<void> };
}): Promise<readonly string[]> {
  const notices: string[] = [];
  const results = await Promise.allSettled([
    options.disposeThread(),
    options.agent.dispose(),
    options.host.dispose(),
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
