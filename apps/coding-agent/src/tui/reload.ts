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
  /**
   * Snapshot the replacement extensions' state files right before
   * activation so a failed activation cannot leave partially upgraded
   * state for the recovered runtime. Returns restore/discard handles.
   */
  readonly snapshotState?: (extensionIds: readonly string[]) => Promise<{
    discard(): Promise<void>;
    restore(): Promise<void>;
  }>;
  /** Bounds replacement activation and failed-replacement disposal. */
  readonly timeoutMs?: number;
  /**
   * Pre-swap validation, e.g. committing migrations for the stored thread.
   * May return a revert callback invoked when a later phase fails so
   * durable side effects do not outlive a failed reload.
   */
  readonly validateHost?: (
    host: Host
  ) => Promise<(() => Promise<void>) | undefined>;
}): Promise<ExtensionRuntimeSwap<Agent, Host>> {
  const loaded = await options.loadExtensions();
  let host: Host | undefined;
  let agent: Agent | undefined;
  let commands: readonly TuiCommand[];
  let toolRenderers: ToolRendererMap;
  let revertValidation: (() => Promise<void>) | undefined;
  const revertSideEffects = async (): Promise<unknown | undefined> => {
    // The live runtime keeps running (or is being recovered), so hand back
    // the CommonJS modules and durable state the failed reload changed.
    loaded.rollbackModuleCache?.();
    if (revertValidation === undefined) {
      return;
    }
    try {
      await revertValidation();
      return;
    } catch (revertError) {
      return revertError;
    }
  };
  try {
    host = await options.createHost(loaded);
    // Validate TUI-facing merges before activation so conflicts abort early.
    commands = options.mergeCommands(host);
    toolRenderers = options.mergeToolRenderers(host);
    revertValidation = await options.validateHost?.(host);
    agent = await options.createAgent(host);
  } catch (error) {
    await disposeSettled(agent, host);
    const revertFailure = await revertSideEffects();
    if (revertFailure !== undefined) {
      throw new AggregateError(
        [error, revertFailure],
        "Extension reload failed and its committed migrations could not be reverted; manual inspection required"
      );
    }
    throw error;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RELOAD_PHASE_TIMEOUT_MS;
  const cleanupNotices = await options.disposePrevious();
  let stateSnapshot:
    | Awaited<ReturnType<NonNullable<typeof options.snapshotState>>>
    | undefined;
  try {
    // Snapshot after old cleanup finished writing and before the
    // replacement can touch the shared per-extension state files. Snapshot
    // failures use the same recovery path as activation failures because
    // the previous runtime is already gone.
    stateSnapshot = await options.snapshotState?.(
      loaded.extensions.map((extension) => extension.id)
    );
    // Per-extension activation is bounded by the host, but a replacement
    // cleanup that never settles would otherwise hang the failure path
    // inside the host's own dispose; bound the whole phase.
    await boundedReloadOperation(
      options.activateHost(host, agent),
      timeoutMs,
      "Replacement extension activation"
    );
  } catch (activationError) {
    await disposeSettled(agent, host, timeoutMs);
    // Recovery must run even when the reverts conflict (for example when
    // replacement activation already advanced the stored thread version);
    // the session otherwise stays backed by the disposed old runtime.
    const failures: unknown[] = [activationError];
    const revertFailure = await revertSideEffects();
    if (revertFailure !== undefined) {
      failures.push(revertFailure);
    }
    if (stateSnapshot !== undefined) {
      try {
        await stateSnapshot.restore();
      } catch (stateRestoreError) {
        failures.push(stateRestoreError);
      }
    }
    try {
      await options.recoverPrevious();
    } catch (recoveryError) {
      throw new AggregateError(
        [...failures, recoveryError],
        "Extension reload activation failed and the previous runtime could not be recovered; restart pss"
      );
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Extension reload failed and some of its side effects could not be reverted; inspect the thread and extension state"
      );
    }
    throw activationError;
  }
  await stateSnapshot?.discard().catch(() => undefined);
  return {
    agent,
    commands,
    host,
    loadedExtensions: loaded.extensions,
    notices: [...loaded.notices, ...cleanupNotices],
    toolRenderers,
  };
}

const DEFAULT_RELOAD_PHASE_TIMEOUT_MS = 60_000;

async function disposeSettled(
  agent: ReloadableAgent | undefined,
  host: ReloadableHost | undefined,
  timeoutMs = DEFAULT_RELOAD_PHASE_TIMEOUT_MS
): Promise<void> {
  await Promise.allSettled([
    bounded(
      agent === undefined ? Promise.resolve() : agent.dispose(),
      timeoutMs
    ),
    bounded(host === undefined ? Promise.resolve() : host.dispose(), timeoutMs),
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

/**
 * Bound an extension-controlled operation (for example a reloaded thread
 * migration) so a never-settling callback fails the reload instead of
 * hanging the session.
 */
export function boundedReloadOperation<Value>(
  task: Promise<Value>,
  timeoutMs: number,
  label: string
): Promise<Value> {
  task.catch(() => undefined);
  return new Promise<Value>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
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
