import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOptions } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import type { CodingAgentExtensionInput } from "../extensions";
import { createCodingAgentExtensionHostWithBuiltIns } from "../extensions/built-in";
import type { AgentTUIConfig } from "./agent";
import {
  installAssistantRendererRuntime,
  mergeToolRenderers,
  startTui,
} from "./app";
import { buildReloadedExtensionRuntime } from "./reload";

const model = {
  doGenerate: () => Promise.reject(new Error("Unexpected model generation")),
  doStream: () => Promise.reject(new Error("Unexpected model stream")),
  modelId: "test-model",
  provider: "test",
  specificationVersion: "v4",
  supportedUrls: {},
} as AgentOptions["model"];

const withIsolatedTuiEnvironment = async (
  run: () => Promise<void>
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "pss-app-renderers-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousThreadDirectory = process.env.PSS_THREAD_DIR;
  const previousThreadKey = process.env.PSS_THREAD_KEY;
  process.chdir(directory);
  process.env.HOME = directory;
  process.env.PSS_THREAD_DIR = join(directory, "threads");
  process.env.PSS_THREAD_KEY = "app-renderers-test";
  try {
    await run();
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousThreadDirectory === undefined) {
      delete process.env.PSS_THREAD_DIR;
    } else {
      process.env.PSS_THREAD_DIR = previousThreadDirectory;
    }
    if (previousThreadKey === undefined) {
      delete process.env.PSS_THREAD_KEY;
    } else {
      process.env.PSS_THREAD_KEY = previousThreadKey;
    }
    await rm(directory, { force: true, recursive: true });
  }
};

describe("TUI extension renderer merging", () => {
  it("updates the captured startTui config after a successful reload", async () => {
    const overrideRenderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["start-tui-override"];
      },
      setText() {
        return;
      },
    });
    const overrideExtension: CodingAgentExtensionInput = {
      configure(registry) {
        registry.tui.registerAssistantRenderer(overrideRenderer, {
          override: true,
        });
      },
      id: "start-tui-override",
    };

    await withIsolatedTuiEnvironment(async () => {
      const exitCode = await startTui(
        {
          model,
          reloadExtensions: () =>
            Promise.resolve({
              extensions: [overrideExtension],
              notices: [],
            }),
        },
        {
          createTui: async (config) => {
            const startupSignal = config.assistantRendererSignal;
            await config.onCommandAction?.({ type: "reload" });
            expect(startupSignal?.aborted).toBe(true);
            expect(config.assistantRenderer).toBe(overrideRenderer);
            expect(config.assistantRendererSignal?.aborted).toBe(false);
          },
        }
      );

      expect(exitCode).toBe(0);
    });
  });

  it("updates the captured startTui config after reload recovery", async () => {
    const failedRenderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["failed-renderer"];
      },
      setText() {
        return;
      },
    });
    const failingExtension: CodingAgentExtensionInput = {
      activate() {
        throw new Error("replacement activation failed");
      },
      configure(registry) {
        registry.tui.registerAssistantRenderer(failedRenderer, {
          override: true,
        });
      },
      id: "failing-start-tui-override",
    };

    await withIsolatedTuiEnvironment(async () => {
      const exitCode = await startTui(
        {
          model,
          reloadExtensions: () =>
            Promise.resolve({
              extensions: [failingExtension],
              notices: [],
            }),
        },
        {
          createTui: async (config) => {
            const startupRenderer = config.assistantRenderer;
            const startupSignal = config.assistantRendererSignal;
            await expect(
              config.onCommandAction?.({ type: "reload" })
            ).rejects.toThrow("failed during activate");
            expect(startupSignal?.aborted).toBe(true);
            expect(config.assistantRenderer).not.toBe(startupRenderer);
            expect(config.assistantRenderer).not.toBe(failedRenderer);
            expect(config.assistantRendererSignal).not.toBe(startupSignal);
            expect(config.assistantRendererSignal?.aborted).toBe(false);
          },
        }
      );

      expect(exitCode).toBe(0);
    });
  });

  it("installs startup reload and recovery assistant renderers", async () => {
    const overrideRenderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["override"];
      },
      setText() {
        return;
      },
    });
    const overrideExtension: CodingAgentExtensionInput = {
      configure(registry) {
        registry.tui.registerAssistantRenderer(overrideRenderer, {
          override: true,
        });
      },
      id: "app-reload-override",
    };
    const startup = await createCodingAgentExtensionHostWithBuiltIns([]);
    const runtime: Pick<
      AgentTUIConfig,
      "assistantRenderer" | "assistantRendererSignal"
    > = {};
    const agent = {
      dispose: () => Promise.resolve(),
    };
    const installRuntime = ({
      host,
    }: {
      host: Awaited<
        ReturnType<typeof createCodingAgentExtensionHostWithBuiltIns>
      >;
    }): void => {
      installAssistantRendererRuntime(runtime, host);
    };

    installAssistantRendererRuntime(runtime, startup);
    expect(runtime.assistantRenderer).toBe(startup.assistantRenderer);
    expect(runtime.assistantRendererSignal).toBe(startup.signal);
    const startupSignal = runtime.assistantRendererSignal;

    const replacement = await buildReloadedExtensionRuntime({
      activateHost: () => Promise.resolve(),
      createAgent: () => Promise.resolve(agent),
      createHost: (loaded) =>
        createCodingAgentExtensionHostWithBuiltIns(loaded.extensions),
      disposePrevious: async () => {
        await startup.dispose();
        return [];
      },
      installRuntime,
      loadExtensions: () =>
        Promise.resolve({
          extensions: [overrideExtension],
          notices: [],
        }),
      mergeCommands: () => [],
      mergeToolRenderers: () => ({}),
      recoverPrevious: async () => ({
        agent,
        commands: [],
        host: await createCodingAgentExtensionHostWithBuiltIns([]),
        toolRenderers: {},
      }),
    });
    expect(startupSignal?.aborted).toBe(true);
    expect(runtime.assistantRenderer).toBe(overrideRenderer);
    expect(runtime.assistantRendererSignal).toBe(replacement.host.signal);
    const replacementSignal = runtime.assistantRendererSignal;

    let recovered:
      | Awaited<ReturnType<typeof createCodingAgentExtensionHostWithBuiltIns>>
      | undefined;
    await expect(
      buildReloadedExtensionRuntime({
        activateHost: () => Promise.reject(new Error("activation failed")),
        createAgent: () => Promise.resolve(agent),
        createHost: (loaded) =>
          createCodingAgentExtensionHostWithBuiltIns(loaded.extensions),
        disposePrevious: async () => {
          await replacement.host.dispose();
          return [];
        },
        installRuntime,
        loadExtensions: () =>
          Promise.resolve({
            extensions: [overrideExtension],
            notices: [],
          }),
        mergeCommands: () => [],
        mergeToolRenderers: () => ({}),
        recoverPrevious: async () => {
          recovered = await createCodingAgentExtensionHostWithBuiltIns([]);
          return {
            agent,
            commands: [],
            host: recovered,
            toolRenderers: {},
          };
        },
      })
    ).rejects.toThrow("activation failed");
    expect(replacementSignal?.aborted).toBe(true);
    expect(recovered).toBeDefined();
    if (recovered === undefined) {
      throw new Error("Expected a recovered extension host");
    }
    expect(recovered.getAssistantRendererOwner()).toBe(
      "@minpeter/pss-coding-agent/latex"
    );
    expect(runtime.assistantRenderer).toBe(recovered.assistantRenderer);
    expect(runtime.assistantRendererSignal).toBe(recovered.signal);

    await recovered.dispose();
  });

  it("attributes built-in renderer collisions to the extension", () => {
    const builtIn = { shell_execute: () => undefined };
    const contributed = { shell_execute: () => undefined };

    expect(() =>
      mergeToolRenderers(builtIn, contributed, () => "renderer-provider")
    ).toThrow(
      'Extension "renderer-provider" tool renderer "shell_execute" conflicts with built-in renderer'
    );
  });
});
