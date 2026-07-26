import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentOptions } from "@minpeter/pss-runtime";
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
  type LoadedConfiguredExtensions,
} from "../extensions";
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
  buildReloadedExtensionRuntime,
  disposePreviousExtensionRuntime,
} from "./reload";
import { createToolRenderers } from "./renderers/tool-renderers";

export interface StartTuiOptions {
  readonly extensions?: readonly CodingAgentExtensionInput[];
  /** Overrides the language model (tests and scripted QA). */
  readonly model?: AgentOptions["model"];
  /** Re-runs extension discovery for `/reload`; absent means unavailable. */
  readonly reloadExtensions?: () => Promise<LoadedConfiguredExtensions>;
  /** Replaces the TUI's default optional OpenSearch tools. */
  readonly tools?: ToolSet;
}

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
    let extensionUi: CodingAgentExtensionUi | undefined;

    const noticeLines: string[] = [];
    const builtInCommands = [createClearCommand(), createReloadCommand()];
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
      onExtensionUiReady: async (ui) => {
        extensionUi = ui;
        extensionHost.bindUi(ui);
        await extensionHost.activate(agent, "tui");
      },
      onSetup: () => {
        for (const refresh of deferredRefreshes) {
          refresh().catch(() => undefined);
        }
      },
      onCommandAction: async (action) => {
        if (action.type === "reload") {
          await reloadExtensionRuntime();
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

    const reloadExtensionRuntime = async (): Promise<void> => {
      const reloadExtensions = options.reloadExtensions;
      if (reloadExtensions === undefined) {
        throw new Error("Extension reload is unavailable in this session.");
      }
      const swap = await buildReloadedExtensionRuntime<
        Awaited<ReturnType<typeof createCodingAgent>>,
        CodingAgentExtensionHost
      >({
        activateHost: async (host, nextAgent) => {
          // Bind provider observations to the replacement host before its
          // extensions activate so they observe their own model traffic.
          const previousEmit = providerEmitter.current;
          providerEmitter.current = (type, payload) => {
            host.emitHostEvent(type, payload);
          };
          try {
            if (extensionUi !== undefined) {
              host.bindUi(extensionUi);
            }
            await host.activate(nextAgent, "tui");
          } catch (error) {
            providerEmitter.current = previousEmit;
            throw error;
          }
        },
        createAgent: (host) =>
          Promise.resolve(
            createCodingAgent({
              autoCompaction: threadConfig.autoCompaction,
              extensionHost: host,
              host: createFileHost({ directory: threadConfig.directory }),
              model,
              tools: options.tools,
              webTools: { onWebToolsDisabled: () => undefined },
              workspace: process.cwd(),
            })
          ),
        createHost: (loaded) =>
          createCodingAgentExtensionHost(loaded.extensions),
        loadExtensions: reloadExtensions,
        mergeCommands: (host) =>
          guardExtensionCommands(builtInCommands, host.commands),
        mergeToolRenderers: (host) =>
          mergeToolRenderers(
            createToolRenderers(),
            host.toolRenderers,
            (name) => host.getToolRendererOwner(name)
          ),
      });
      const previous = { agent, host: extensionHost, thread };
      agent = swap.agent;
      extensionHost = swap.host;
      thread = agent.thread(threadConfig.key);
      tuiConfig.commands = [...swap.commands];
      tuiConfig.toolRenderers = swap.toolRenderers;
      previous.thread.interrupt();
      const cleanupNotices = await disposePreviousExtensionRuntime({
        agent: previous.agent,
        disposeThread: () => previous.thread.dispose(),
        host: previous.host,
      });
      for (const notice of [...swap.notices, ...cleanupNotices]) {
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
