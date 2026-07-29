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
  type ContextResources,
  loadContextResources,
  mergePromptTemplateCommands,
} from "../context";
import {
  formatModelEnvSetupHelp,
  isModelEnvValidationError,
  readOpenAICompatibleModelEnv,
} from "../env";
import type {
  CodingAgentExtensionHost,
  CodingAgentExtensionInput,
  CodingAgentExtensionUi,
} from "../extensions";
import { createCodingAgentExtensionHostWithDefaults } from "../extensions/defaults";
import { snapshotExtensionState } from "../extensions/state-snapshot";
import { composeCodingAgentInstructions } from "../instructions";
import { type CodingModelSession, createCodingModelSession } from "../model";
import {
  createProviderObservationFetch,
  type ProviderObservationEmitter,
} from "../provider-observation";
import {
  approveSessionChange,
  type SessionChangeEvent,
} from "../sessions/session-guards";
import type { SessionIndexEntry } from "../sessions/session-index";
import {
  createSessionManager,
  type SessionLifecycleReason,
} from "../sessions/session-manager";
import { resolveCodingAgentThreadConfig } from "../thread-config";
import { planAutoUpdate, runAutoUpdate } from "../update/auto-update";
import { UPDATE_CHECK_CACHE_FILENAME } from "../update/check";
import { cliVersion } from "../update/cli-version";
import { emitUpdateNotice } from "../update/notifier";
import { type AgentTUIConfig, createAgentTUI } from "./agent";
import type { TuiCommand } from "./command";
import { createClearCommand, createReloadCommand } from "./command-set";
import { createModelCommand } from "./model-command";
import {
  boundedReloadOperation,
  buildReloadedExtensionRuntime,
  disposePreviousExtensionRuntime,
  type ReloadableExtensions,
} from "./reload";
import { createToolRenderers } from "./renderers/tool-renderers";
import { createSessionCommands } from "./session-commands";
import { TokenUsageTracker } from "./usage-footer";

export interface StartTuiOptions {
  readonly extensions?: readonly CodingAgentExtensionInput[];
  /** Overrides the language model (tests and scripted QA). */
  readonly model?: AgentOptions["model"];
  /** Re-runs extension discovery for `/reload`; absent means unavailable. */
  readonly reloadExtensions?: () => Promise<ReloadableExtensions>;
  /** Display name recorded for the startup session (`--name`). */
  readonly sessionName?: string;
  /** Replaces the TUI's default optional OpenSearch tools. */
  readonly tools?: ToolSet;
}

interface StartTuiDependencies {
  readonly createTui: typeof createAgentTUI;
}

const RECOVERY_ACTIVATION_TIMEOUT_MS = 60_000;

/**
 * Resolve (and record) the session this startup drives. The session index
 * must never block startup: on failure the legacy per-directory key is
 * used without recording metadata, and a notice is surfaced.
 */
async function resolveStartupSessionEntry(
  sessionManager: ReturnType<typeof createSessionManager>,
  threadConfig: ReturnType<typeof resolveCodingAgentThreadConfig>,
  sessionName: string | undefined
): Promise<{ entry: SessionIndexEntry; notice?: string }> {
  try {
    return {
      entry: await sessionManager.resolveStartupSession({
        ...(sessionName === undefined ? {} : { name: sessionName }),
        ...(threadConfig.keyFromEnv ? { overrideKey: threadConfig.key } : {}),
      }),
    };
  } catch (error) {
    const at = new Date().toISOString();
    return {
      entry: {
        createdAt: at,
        cwd: process.cwd(),
        key: threadConfig.key,
        updatedAt: at,
      },
      notice: `Session index unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

const resolveModelSubtitle = (): string | undefined => {
  try {
    return readOpenAICompatibleModelEnv({ runtimeEnv: process.env }).AI_MODEL;
  } catch {
    return;
  }
};

const resolveTuiModel = (
  override: AgentOptions["model"] | undefined,
  providerEmitter: ProviderObservationEmitter
): { model: AgentOptions["model"]; modelSession?: CodingModelSession } => {
  if (override !== undefined) {
    return { model: override };
  }
  const modelSession = createCodingModelSession({
    fetch: createProviderObservationFetch(providerEmitter),
  });
  return { model: modelSession.model, modelSession };
};

const modelSubtitleLabel = (
  modelSession: CodingModelSession | undefined
): string => {
  if (modelSession === undefined) {
    return resolveModelSubtitle() ?? "unknown model";
  }
  return `${modelSession.currentModelId()}${modelSession.isFreeTier ? " (free tier)" : ""}`;
};

const foregroundThemeConfig = (): Pick<AgentTUIConfig, "theme"> => {
  const foregroundColor = process.env.PSS_TUI_FOREGROUND;
  return foregroundColor === undefined ? {} : { theme: { foregroundColor } };
};

export async function startTui(
  options: StartTuiOptions = {},
  dependencies: StartTuiDependencies = { createTui: createAgentTUI }
): Promise<number> {
  const threadConfig = resolveCodingAgentThreadConfig();
  const providerEmitter: ProviderObservationEmitter = {};
  let model: AgentOptions["model"];
  let modelSession: CodingModelSession | undefined;
  let extensionHost = await createCodingAgentExtensionHostWithDefaults(
    options.extensions ?? []
  );
  providerEmitter.current = (type, payload) => {
    extensionHost.emitHostEvent(type, payload);
  };
  let agent: Awaited<ReturnType<typeof createCodingAgent>>;
  let contextResources: ContextResources;
  try {
    contextResources = await loadContextResources({
      cwd: process.cwd(),
      home: homedir(),
      resourceRoots: extensionHost.resourceRoots,
    });
    ({ model, modelSession } = resolveTuiModel(options.model, providerEmitter));
    agent = await createCodingAgent({
      autoCompaction: threadConfig.autoCompaction,
      extensionHost,
      host: createFileHost({ directory: threadConfig.directory }),
      instructions: composeCodingAgentInstructions(
        contextResources.instructionFragments
      ),
      model,
      tools: options.tools,
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
    const sessionManager = createSessionManager({
      cwd: process.cwd(),
      directory: threadConfig.directory,
      threads: createFileHost({ directory: threadConfig.directory }).store
        .threads,
    });
    const startupSession = await resolveStartupSessionEntry(
      sessionManager,
      threadConfig,
      options.sessionName
    );
    let currentSession = startupSession.entry;
    const sessionIndexNotice = startupSession.notice;
    let thread = agent.thread(currentSession.key);
    let createExtensionUiForHost:
      | ((hostSignal?: AbortSignal) => CodingAgentExtensionUi)
      | undefined;
    let extensionUi: CodingAgentExtensionUi | undefined;
    let extensionUiAbort: AbortController | undefined;

    const noticeLines: string[] = [...contextResources.notices];
    if (sessionIndexNotice !== undefined) {
      noticeLines.push(sessionIndexNotice);
    }
    if (modelSession?.isFreeTier) {
      noticeLines.push(
        `No AI_API_KEY configured — using the OpenCode Zen free tier (model ${modelSession.currentModelId()}). Free models are rate-limited and may change; set AI_API_KEY to use your own provider.`
      );
    }
    // `/reload` is only offered when the entrypoint provided a rediscovery
    // loader; embedded starts without one would advertise a dead command.
    // `/model` needs the switchable session; a caller-provided model is
    // opaque, so the selector is not offered then.
    const activeModelSession = modelSession;
    const builtInCommands = [
      createClearCommand(),
      // Session commands close over helpers defined below; the wrappers
      // defer evaluation to call time.
      ...createSessionCommands({
        currentSession: () => currentSession,
        ensureApproved: (kind, event) =>
          ensureSessionChangeApproved(kind, event),
        manager: sessionManager,
        onRenamed: (entry) => {
          currentSession = entry;
          header.subtitle = buildSubtitle();
        },
        switchThread: (entry, reason) => switchThread(entry, reason),
        ui: () => extensionUi,
      }),
      ...(activeModelSession === undefined
        ? []
        : [
            createModelCommand({
              currentModelId: () => activeModelSession.currentModelId(),
              listModelIds: () => activeModelSession.listModelIds(),
              switchModel: (modelId) => {
                activeModelSession.switchModel(modelId);
                header.subtitle = buildSubtitle();
              },
            }),
          ]),
      ...(options.reloadExtensions === undefined
        ? []
        : [createReloadCommand()]),
    ];
    // Prompt-template commands sit below built-in and extension commands:
    // shadowed templates are skipped with a notice instead of failing.
    const composeCommands = (
      host: CodingAgentExtensionHost
    ): { commands: TuiCommand[]; notices: readonly string[] } =>
      mergePromptTemplateCommands(
        guardExtensionCommands(builtInCommands, host.commands),
        contextResources.promptTemplates
      );
    const initialCommandMerge = composeCommands(extensionHost);
    noticeLines.push(...initialCommandMerge.notices);
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
    const usageTracker = new TokenUsageTracker();

    const renderUsageFooter = (): void => {
      footer.text = usageTracker.footerText();
    };

    const resetUsageTotals = (): void => {
      usageTracker.reset();
      renderUsageFooter();
    };

    const buildSubtitle = (): string => {
      const base = `${modelSubtitleLabel(modelSession)}\n${process.cwd()}`;
      return currentSession.name === undefined
        ? base
        : `${base}\nsession: ${currentSession.name}`;
    };
    const header = { title: "pss", subtitle: buildSubtitle() };

    const emitSessionEvent = (
      type: string,
      payload: Parameters<CodingAgentExtensionHost["emitHostEvent"]>[1]
    ): void => {
      extensionHost.emitHostEvent(type, payload);
    };

    // Cancelable pre-switch/pre-fork decision points (#258): any
    // registered extension session guard can cancel the change; guard
    // failures fail closed.
    const ensureSessionChangeApproved = async (
      kind: "fork" | "switch",
      event: SessionChangeEvent
    ): Promise<void> => {
      const approval = await approveSessionChange({
        event,
        guards: extensionHost.sessionGuards,
        kind,
        signal: extensionHost.signal,
        timeoutMs: extensionHost.timeoutMs,
      });
      if (!approval.approved) {
        throw new Error(
          `Session change cancelled by extension "${approval.extensionId}": ${approval.reason}`
        );
      }
    };

    const switchThread = async (
      entry: SessionIndexEntry,
      reason: SessionLifecycleReason
    ): Promise<void> => {
      const fromKey = currentSession.key;
      const previous = thread;
      previous.interrupt();
      // Best-effort: a failing disposal of the outgoing handle must not
      // strand the switch half-way (disposal evicts it from the agent).
      await previous.dispose().catch(() => undefined);
      thread = agent.thread(entry.key);
      currentSession = entry;
      resetUsageTotals();
      header.subtitle = buildSubtitle();
      emitSessionEvent("host:session-switch", {
        fromKey,
        reason,
        toKey: entry.key,
      });
      emitSessionEvent("host:session-start", {
        key: entry.key,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        reason,
      });
    };

    const tuiConfig: AgentTUIConfig = {
      ...assistantRendererRuntime(extensionHost),
      ...foregroundThemeConfig(),
      thread: {
        interrupt: () => thread.interrupt(),
        send: (input) => thread.send(input),
        steer: (input) => thread.steer(input),
      },
      commands: initialCommandMerge.commands,
      header,
      footer,
      ...(activeModelSession === undefined
        ? {}
        : {
            modelSelector: {
              currentModelId: () => activeModelSession.currentModelId(),
              listModelIds: () => activeModelSession.listModelIds(),
              switchModel: (modelId: string) => {
                activeModelSession.switchModel(modelId);
                header.subtitle = buildSubtitle();
              },
            },
          }),
      onModelUsage: (usage) => {
        usageTracker.addUsage(usage);
        renderUsageFooter();
      },
      onOutputDelta: (text) => {
        usageTracker.addOutputDelta(text);
        renderUsageFooter();
      },
      onStreamStart: () => {
        usageTracker.beginTurn();
        renderUsageFooter();
      },
      onTurnComplete: () => {
        // Keep /resume recency meaningful: every completed turn bumps the
        // session's updatedAt (best-effort; never surfaces to the user).
        sessionManager.touchSession(currentSession.key).catch(() => undefined);
      },
      onExtensionUiReady: async (createUi) => {
        createExtensionUiForHost = createUi;
        extensionUiAbort = new AbortController();
        extensionUi = createUi(extensionUiAbort.signal);
        extensionHost.bindUi(extensionUi);
        await extensionHost.activate(agent, "tui");
        emitSessionEvent("host:session-start", {
          key: currentSession.key,
          ...(currentSession.name === undefined
            ? {}
            : { name: currentSession.name }),
          reason: "startup",
        });
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
            thread = agent.thread(currentSession.key);
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
        thread = agent.thread(currentSession.key);
        resetUsageTotals();
        sessionManager.touchSession(currentSession.key).catch(() => undefined);
        emitSessionEvent("host:session-start", {
          key: currentSession.key,
          reason: "clear",
        });
      },
      setupMessages: noticeLines,
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
      let installedUiAbort: AbortController | undefined;
      try {
        if (createExtensionUiForHost !== undefined) {
          installedUiAbort = new AbortController();
          extensionUiAbort = installedUiAbort;
          installedUi = createExtensionUiForHost(installedUiAbort.signal);
          extensionUi = installedUi;
          host.bindUi(installedUi);
        }
        await host.activate(nextAgent, "tui");
      } catch (error) {
        // Cancel any prompt the failed attempt left on screen, then only
        // roll back bindings this attempt still owns (a detached activation
        // can reject long after recovery installed a new runtime).
        installedUiAbort?.abort();
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
        instructions: composeCodingAgentInstructions(
          contextResources.instructionFragments
        ),
        model,
        tools: options.tools,
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
      thread = agent.thread(currentSession.key);
      installAssistantRendererRuntime(tuiConfig, host);
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
        context: contextResources,
        host: extensionHost,
        thread,
        uiAbort: extensionUiAbort,
      };
      let reloadCommandNotices: readonly string[] = [];
      let swap: Awaited<
        ReturnType<
          typeof buildReloadedExtensionRuntime<
            Awaited<ReturnType<typeof createCodingAgent>>,
            CodingAgentExtensionHost
          >
        >
      >;
      const buildSwap = () =>
        buildReloadedExtensionRuntime<
          Awaited<ReturnType<typeof createCodingAgent>>,
          CodingAgentExtensionHost
        >({
          activateHost: activateReplacementHost,
          createAgent: (host) => Promise.resolve(createReplacementAgent(host)),
          createHost: async (loaded) => {
            const host = await createCodingAgentExtensionHostWithDefaults(
              loaded.extensions
            );
            // Re-discover context resources against the replacement host so
            // edited AGENTS.md files, templates, skills, and freshly
            // contributed resource roots apply without a restart. A failing
            // reload restores the previous resources with the previous
            // runtime.
            contextResources = await loadContextResources({
              cwd: process.cwd(),
              home: homedir(),
              resourceRoots: host.resourceRoots,
            });
            return host;
          },
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
          installRuntime: ({ agent, commands, host, toolRenderers }) => {
            installRuntime(host, agent, commands, toolRenderers);
          },
          mergeCommands: (host) => {
            const merged = composeCommands(host);
            reloadCommandNotices = merged.notices;
            return merged.commands;
          },
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
            // The recovered runtime must run with the resources it was built
            // with, not the replacement's half-adopted ones.
            contextResources = previous.context;
            const recoveredHost =
              await createCodingAgentExtensionHostWithDefaults(
                currentExtensionInputs
              );
            let recoveredAgent:
              | Awaited<ReturnType<typeof createCodingAgent>>
              | undefined;
            try {
              recoveredAgent = await createReplacementAgent(recoveredHost);
              const commands = composeCommands(recoveredHost).commands;
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
              return {
                agent: recoveredAgent,
                commands,
                host: recoveredHost,
                toolRenderers,
              };
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
              threadKey: threadStoreKey(currentSession.key),
              timeoutMs: host.timeoutMs,
            });
            return committed === undefined
              ? undefined
              : () => committed.revert();
          },
        });
      try {
        swap = await buildSwap();
      } catch (error) {
        // Failures before recovery leave the previous runtime installed;
        // it must keep the resources it was built with (recovery restores
        // them itself, so this is idempotent).
        contextResources = previous.context;
        throw error;
      }
      currentExtensionInputs = swap.loadedExtensions;
      for (const notice of [
        ...swap.notices,
        ...contextResources.notices,
        ...reloadCommandNotices,
      ]) {
        extensionUi?.notify(notice);
      }
    };

    try {
      await dependencies.createTui(tuiConfig);
    } finally {
      emitSessionEvent("host:session-shutdown", { key: currentSession.key });
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

type AssistantRendererRuntimeConfig = Pick<
  AgentTUIConfig,
  "assistantRenderer" | "assistantRendererSignal"
>;

type AssistantRendererRuntimeHost = Pick<
  CodingAgentExtensionHost,
  "assistantRenderer" | "signal"
>;

const assistantRendererRuntime = (
  host: AssistantRendererRuntimeHost
): AssistantRendererRuntimeConfig => ({
  assistantRenderer: host.assistantRenderer,
  assistantRendererSignal: host.signal,
});

export function installAssistantRendererRuntime(
  config: AssistantRendererRuntimeConfig,
  host: AssistantRendererRuntimeHost
): void {
  Object.assign(config, assistantRendererRuntime(host));
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
