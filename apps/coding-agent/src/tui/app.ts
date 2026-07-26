import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentOptions,
  commitThreadStateMigrations,
  threadStoreKey,
} from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import type { ToolSet } from "ai";
import { createCodingAgent } from "../coding-agent";
import {
  formatModelEnvSetupHelp,
  isModelEnvValidationError,
  readOpenAICompatibleModelEnv,
} from "../env";
import {
  type CodingAgentExtensionHost,
  type CodingAgentExtensionInput,
  type CodingAgentExtensionUi,
  createCodingAgentExtensionHost,
} from "../extensions";
import { snapshotExtensionState } from "../extensions/state-snapshot";
import { createCodingLanguageModel } from "../model";
import {
  createProviderObservationFetch,
  type ProviderObservationEmitter,
} from "../provider-observation";
import { resolveCodingAgentThreadConfig } from "../thread-config";
import { planAutoUpdate, runAutoUpdate } from "../update/auto-update";
import { UPDATE_CHECK_CACHE_FILENAME } from "../update/check";
import { cliVersion } from "../update/cli-version";
import { emitUpdateNotice } from "../update/notifier";
import { type AgentTUIConfig, createAgentTUI } from "./agent";
import type { TuiCommand } from "./command";
import { createClearCommand, createReloadCommand } from "./command-set";
import {
  boundedReloadOperation,
  buildReloadedExtensionRuntime,
  disposePreviousExtensionRuntime,
  type ReloadableExtensions,
} from "./reload";
import { createToolRenderers } from "./renderers/tool-renderers";

export interface StartTuiOptions {
  readonly extensions?: readonly CodingAgentExtensionInput[];
  /** Overrides the language model (tests and scripted QA). */
  readonly model?: AgentOptions["model"];
  /** Re-runs extension discovery for `/reload`; absent means unavailable. */
  readonly reloadExtensions?: () => Promise<ReloadableExtensions>;
  /** Replaces the TUI's default optional OpenSearch tools. */
  readonly tools?: ToolSet;
}

const RECOVERY_ACTIVATION_TIMEOUT_MS = 60_000;

const formatTokens = (n: number): string => {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
};

const resolveModelSubtitle = (): string | undefined => {
  try {
    return readOpenAICompatibleModelEnv({ runtimeEnv: process.env }).AI_MODEL;
  } catch {
    return;
  }
};

export async function startTui(options: StartTuiOptions = {}): Promise<number> {
  const startupNotices: string[] = [];
  const threadConfig = resolveCodingAgentThreadConfig();
  const providerEmitter: ProviderObservationEmitter = {};
  let model: AgentOptions["model"];
  let extensionHost = await createCodingAgentExtensionHost(
    options.extensions ?? []
  );
  providerEmitter.current = (type, payload) => {
    extensionHost.emitHostEvent(type, payload);
  };
  let agent: Awaited<ReturnType<typeof createCodingAgent>>;
  try {
    model =
      options.model ??
      createCodingLanguageModel({
        fetch: createProviderObservationFetch(providerEmitter),
      });
    agent = await createCodingAgent({
      autoCompaction: threadConfig.autoCompaction,
      extensionHost,
      host: createFileHost({ directory: threadConfig.directory }),
      model,
      tools: options.tools,
      webTools: {
        onWebToolsDisabled: (message) => startupNotices.push(message),
      },
      workspace: process.cwd(),
    });
  } catch (error) {
    await extensionHost.dispose();
    if (isModelEnvValidationError(error)) {
      process.stderr.write(formatModelEnvSetupHelp(error));
      return 1;
    }
    throw error;
  }
  let exitCode = 0;
  try {
    let thread = agent.thread(threadConfig.key);
    let createExtensionUiForHost:
      | ((hostSignal?: AbortSignal) => CodingAgentExtensionUi)
      | undefined;
    let extensionUi: CodingAgentExtensionUi | undefined;
    let extensionUiAbort: AbortController | undefined;

    const noticeLines: string[] = [];
    // `/reload` is only offered when the entrypoint provided a rediscovery
    // loader; embedded starts without one would advertise a dead command.
    const builtInCommands = [
      createClearCommand(),
      ...(options.reloadExtensions === undefined
        ? []
        : [createReloadCommand()]),
    ];
    let currentExtensionInputs: readonly CodingAgentExtensionInput[] =
      options.extensions ?? [];
    const deferredRefreshes: (() => Promise<void>)[] = [];
    const updateNotice = await emitUpdateNotice({
      write: (line) => noticeLines.push(line),
      env: process.env,
      version: cliVersion,
      cachePath: join(homedir(), ".pss", UPDATE_CHECK_CACHE_FILENAME),
      schedule: (task) => deferredRefreshes.push(task),
    });
    const autoUpdate =
      cliVersion === undefined
        ? undefined
        : planAutoUpdate({
            notice: updateNotice,
            version: cliVersion,
            env: process.env,
            binPath: process.argv[1] ?? "",
          });
    if (autoUpdate !== undefined) {
      noticeLines.push(
        `auto-update enabled: pss ${autoUpdate.target} will be installed on exit`
      );
    }

    const footer: { text?: string } = {};
    const usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const resetUsageTotals = (): void => {
      usageTotals.inputTokens = 0;
      usageTotals.outputTokens = 0;
      usageTotals.totalTokens = 0;
      footer.text = undefined;
    };

    const modelId = resolveModelSubtitle();
    const compactionText = threadConfig.autoCompaction
      ? `compaction min=${threadConfig.autoCompaction.minMessages} retain=${threadConfig.autoCompaction.retainMessages}`
      : "compaction off";

    const tuiConfig: AgentTUIConfig = {
      thread: {
        interrupt: () => thread.interrupt(),
        send: (input) => thread.send(input),
        steer: (input) => thread.steer(input),
      },
      commands: guardExtensionCommands(builtInCommands, extensionHost.commands),
      header: {
        title: "pss",
        subtitle: `${modelId ?? "unknown model"}\n${process.cwd()} · thread ${threadConfig.key} · ${compactionText}`,
      },
      footer,
      onModelUsage: (usage) => {
        usageTotals.inputTokens += usage.inputTokens ?? 0;
        usageTotals.outputTokens += usage.outputTokens ?? 0;
        usageTotals.totalTokens +=
          usage.totalTokens ??
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        footer.text = `${formatTokens(usageTotals.totalTokens)} tokens (${formatTokens(usageTotals.inputTokens)} in / ${formatTokens(usageTotals.outputTokens)} out)`;
      },
      onExtensionUiReady: async (createUi) => {
        createExtensionUiForHost = createUi;
        extensionUiAbort = new AbortController();
        extensionUi = createUi(extensionUiAbort.signal);
        extensionHost.bindUi(extensionUi);
        await extensionHost.activate(agent, "tui");
      },
      onSetup: () => {
        for (const refresh of deferredRefreshes) {
          refresh().catch(() => undefined);
        }
      },
      onCommandAction: async (action) => {
        if (action.type === "reload") {
          try {
            await reloadExtensionRuntime();
          } catch (error) {
            // A failed reload may have touched the durable thread; dispose
            // the cached handle first (disposal evicts it from the agent),
            // then request a fresh one that re-reads the store instead of
            // committing on a stale revision.
            const stale = thread;
            stale.interrupt();
            await stale.dispose().catch(() => undefined);
            thread = agent.thread(threadConfig.key);
            throw error;
          }
          return;
        }
        if (action.type !== "new-session") {
          return;
        }

        const previous = thread;
        previous.interrupt();
        await previous.delete();
        await previous.dispose();
        thread = agent.thread(threadConfig.key);
        resetUsageTotals();
      },
      setupMessages: [...startupNotices, ...noticeLines],
      toolRenderers: mergeToolRenderers(
        createToolRenderers(),
        extensionHost.toolRenderers,
        (toolName) => extensionHost.getToolRendererOwner(toolName)
      ),
    };

    const activateReplacementHost = async (
      host: CodingAgentExtensionHost,
      nextAgent: Awaited<ReturnType<typeof createCodingAgent>>
    ): Promise<void> => {
      // Bind provider observations to the replacement host before its
      // extensions activate so they observe their own model traffic, and
      // give the replacement its own host-scoped UI so detached prompts
      // from a previous runtime can be cancelled independently.
      const previousEmit = providerEmitter.current;
      const previousUi = extensionUi;
      const previousUiAbort = extensionUiAbort;
      const installedEmit = (
        type: string,
        payload: Parameters<
          NonNullable<ProviderObservationEmitter["current"]>
        >[1]
      ) => {
        host.emitHostEvent(type, payload);
      };
      providerEmitter.current = installedEmit;
      let installedUi: CodingAgentExtensionUi | undefined;
      try {
        if (createExtensionUiForHost !== undefined) {
          extensionUiAbort = new AbortController();
          installedUi = createExtensionUiForHost(extensionUiAbort.signal);
          extensionUi = installedUi;
          host.bindUi(installedUi);
        }
        await host.activate(nextAgent, "tui");
      } catch (error) {
        // A detached activation can reject long after recovery installed a
        // new runtime; only roll back bindings this attempt still owns.
        if (providerEmitter.current === installedEmit) {
          providerEmitter.current = previousEmit;
        }
        if (installedUi !== undefined && extensionUi === installedUi) {
          extensionUi = previousUi;
          extensionUiAbort = previousUiAbort;
        }
        throw error;
      }
    };

    const createReplacementAgent = (host: CodingAgentExtensionHost) =>
      createCodingAgent({
        autoCompaction: threadConfig.autoCompaction,
        extensionHost: host,
        host: createFileHost({ directory: threadConfig.directory }),
        model,
        tools: options.tools,
        webTools: { onWebToolsDisabled: () => undefined },
        workspace: process.cwd(),
      });

    const installRuntime = (
      host: CodingAgentExtensionHost,
      nextAgent: Awaited<ReturnType<typeof createCodingAgent>>,
      commands: readonly TuiCommand[],
      toolRenderers: NonNullable<AgentTUIConfig["toolRenderers"]>
    ): void => {
      agent = nextAgent;
      extensionHost = host;
      thread = agent.thread(threadConfig.key);
      tuiConfig.commands = [...commands];
      tuiConfig.toolRenderers = toolRenderers;
    };

    const reloadExtensionRuntime = async (): Promise<void> => {
      const reloadExtensions = options.reloadExtensions;
      if (reloadExtensions === undefined) {
        throw new Error("Extension reload is unavailable in this session.");
      }
      const reloadFileHost = createFileHost({
        directory: threadConfig.directory,
      });
      const previous = {
        agent,
        host: extensionHost,
        thread,
        uiAbort: extensionUiAbort,
      };
      const swap = await buildReloadedExtensionRuntime<
        Awaited<ReturnType<typeof createCodingAgent>>,
        CodingAgentExtensionHost
      >({
        activateHost: activateReplacementHost,
        createAgent: (host) => Promise.resolve(createReplacementAgent(host)),
        createHost: (loaded) =>
          createCodingAgentExtensionHost(loaded.extensions),
        disposePrevious: async () => {
          previous.thread.interrupt();
          try {
            return await disposePreviousExtensionRuntime({
              agent: previous.agent,
              disposeThread: () => previous.thread.dispose(),
              host: previous.host,
            });
          } finally {
            // Even when cleanup was detached by the timeout, late writes
            // must not touch state the replacement runtime now owns, and
            // stale prompts must release the terminal.
            previous.uiAbort?.abort();
            await previous.host.revokeExtensionState();
          }
        },
        loadExtensions: reloadExtensions,
        mergeCommands: (host) =>
          guardExtensionCommands(builtInCommands, host.commands),
        mergeToolRenderers: (host) =>
          mergeToolRenderers(
            createToolRenderers(),
            host.toolRenderers,
            (name) => host.getToolRendererOwner(name)
          ),
        // Snapshot the replacement extensions' state files so a failed
        // activation cannot leave partially upgraded state for the
        // recovered runtime.
        snapshotState: (extensionIds) => snapshotExtensionState(extensionIds),
        // Rebuild a runtime from the previous inputs so the session stays
        // usable when replacement activation fails after old cleanup ran.
        recoverPrevious: async () => {
          const recoveredHost = await createCodingAgentExtensionHost(
            currentExtensionInputs
          );
          let recoveredAgent:
            | Awaited<ReturnType<typeof createCodingAgent>>
            | undefined;
          try {
            recoveredAgent = await createReplacementAgent(recoveredHost);
            const commands = guardExtensionCommands(
              builtInCommands,
              recoveredHost.commands
            );
            const toolRenderers = mergeToolRenderers(
              createToolRenderers(),
              recoveredHost.toolRenderers,
              (name) => recoveredHost.getToolRendererOwner(name)
            );
            // Recovery activation needs the same boundary as replacement
            // activation; a hanging recovered cleanup must fail recovery
            // instead of freezing the session.
            await boundedReloadOperation(
              activateReplacementHost(recoveredHost, recoveredAgent),
              RECOVERY_ACTIVATION_TIMEOUT_MS,
              "Recovered extension activation"
            );
            installRuntime(
              recoveredHost,
              recoveredAgent,
              commands,
              toolRenderers
            );
          } catch (error) {
            await recoveredHost.revokeExtensionState().catch(() => undefined);
            await Promise.allSettled([
              recoveredAgent === undefined
                ? Promise.resolve()
                : boundedReloadOperation(
                    recoveredAgent.dispose(),
                    RECOVERY_ACTIVATION_TIMEOUT_MS,
                    "Recovered agent disposal"
                  ),
              boundedReloadOperation(
                recoveredHost.dispose(),
                RECOVERY_ACTIVATION_TIMEOUT_MS,
                "Recovered host disposal"
              ),
            ]);
            throw error;
          }
        },
        // Commit reloaded migrations for the stored thread before swapping so
        // a rejecting migration cannot strand the next prompt and stateful
        // migrations never re-run on the next load. The returned revert
        // restores the snapshot if a later reload phase fails.
        validateHost: async (host) => {
          // Migration callbacks are extension-controlled and bounded by the
          // host timeout; the durable commit itself is awaited to
          // completion so the reported reload outcome always matches the
          // stored thread state.
          const committed = await commitThreadStateMigrations({
            migrations: host.threadMigrations,
            store: reloadFileHost.store.threads,
            threadKey: threadStoreKey(threadConfig.key),
            timeoutMs: host.timeoutMs,
          });
          return committed === undefined ? undefined : () => committed.revert();
        },
      });
      installRuntime(swap.host, swap.agent, swap.commands, swap.toolRenderers);
      currentExtensionInputs = swap.loadedExtensions;
      for (const notice of swap.notices) {
        extensionUi?.notify(notice);
      }
    };

    try {
      await createAgentTUI(tuiConfig);
    } finally {
      thread.interrupt();
      await thread.dispose().catch(() => undefined);
    }

    if (autoUpdate !== undefined) {
      exitCode = await runAutoUpdate(autoUpdate, {
        platform: process.platform,
        stdout: process.stdout,
      });
    }
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const cleanup of [
      () => agent.dispose(),
      () => extensionHost.dispose(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      exitCode = 1;
    }
  }
  return exitCode;
}

export function mergeToolRenderers(
  builtIn: NonNullable<AgentTUIConfig["toolRenderers"]>,
  contributed: NonNullable<AgentTUIConfig["toolRenderers"]>,
  getOwner: (toolName: string) => string | undefined
): NonNullable<AgentTUIConfig["toolRenderers"]> {
  const merged = { ...builtIn };
  for (const [toolName, renderer] of Object.entries(contributed)) {
    if (Object.hasOwn(merged, toolName)) {
      const owner = getOwner(toolName) ?? "unknown";
      throw new Error(
        `Extension "${owner}" tool renderer "${toolName}" conflicts with built-in renderer`
      );
    }
    merged[toolName] = renderer;
  }
  return merged;
}

function guardExtensionCommands(
  builtInCommands: readonly TuiCommand[],
  extensionCommands: readonly TuiCommand[]
): TuiCommand[] {
  const builtInNames = new Set(builtInCommands.map((command) => command.name));
  for (const command of extensionCommands) {
    if (builtInNames.has(command.name)) {
      throw new Error(
        `Extension command "${command.name}" conflicts with a built-in command`
      );
    }
  }
  return [...builtInCommands, ...extensionCommands];
}

function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

if (isMainModule(import.meta.url)) {
  const exitCode = await startTui();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
