import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { command, modelProvider } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type {
  CodingAgentExtensionModule,
  CodingAgentExtensionServices,
} from "./types";

const createModel = (name: string) => {
  const provider = createOpenAICompatible({
    apiKey: "test",
    baseURL: "https://example.com/v1",
    name,
  });
  return provider(`${name}-model`);
};

const createParentAgent = async () =>
  await createAgent({ model: createModel("parent") });

describe("extension runtime service contracts", () => {
  it("selects explicit provider adapters for managed child agents", async () => {
    const selected: string[] = [];
    let services: CodingAgentExtensionServices | undefined;
    const host = await createCodingAgentExtensionHost(
      [
        {
          default(pss) {
            pss.provide(
              modelProvider({
                create: (id) => {
                  selected.push(`first:${id}`);
                  return createModel("first");
                },
                id: "first",
                models: ["fast"],
              })
            );
            pss.provide(
              modelProvider({
                create: (id) => {
                  selected.push(`second:${id}`);
                  return createModel("second");
                },
                id: "second",
                models: ["deep"],
              })
            );
            pss.on("activate", (context) => {
              services = context.services;
            });
          },
          id: "agent-owner",
        },
      ],
      { model: createModel("default") }
    );
    const parent = await createParentAgent();

    try {
      await host.activate(parent, "exec");
      const first = await services?.agents.create({
        instructions: "first child",
        model: { id: "fast", provider: "first" },
      });
      const second = await services?.agents.create({
        instructions: "second child",
        model: { id: "deep", provider: "second" },
      });

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(selected).toEqual(["first:fast", "second:deep"]);
      await expect(
        services?.agents.create({
          instructions: "missing",
          model: { id: "missing", provider: "first" },
        })
      ).rejects.toThrow(
        'Unknown model "missing" for extension provider "first"'
      );
    } finally {
      await parent.dispose();
      await host.dispose();
    }
  });

  it("does not publish duplicate providers from a failed staged extension", async () => {
    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(
              modelProvider({
                create: () => createModel("one"),
                id: "shared",
                models: ["fast"],
              })
            );
          },
          id: "first-provider",
        },
        {
          default(pss) {
            pss.provide(
              modelProvider({
                create: () => createModel("two"),
                id: "shared",
                models: ["deep"],
              })
            );
          },
          id: "second-provider",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Model provider "shared" from extension "second-provider" conflicts with extension "first-provider"',
      },
    });
  });

  it("rejects unsafe provider data before it can publish", async () => {
    const provider = {
      create: () => createModel("unsafe"),
      id: "__proto__",
      models: ["fast"],
    };

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(modelProvider(provider));
          },
          id: "unsafe-provider",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message: 'Invalid extension model provider id "__proto__"',
      },
    });
  });

  it("keeps a single extension-scoped service bag in command execution", async () => {
    let observed: CodingAgentExtensionServices | undefined;
    const host = await createCodingAgentExtensionHost(
      [
        {
          default(pss) {
            pss.provide(
              command({
                description: "Observe command services",
                execute: (_input, context) => {
                  observed = context?.services;
                  return { success: true };
                },
                name: "observe-services",
              })
            );
          },
          id: "command-owner",
        },
      ],
      { model: createModel("command") }
    );
    const parent = await createParentAgent();

    try {
      await host.activate(parent, "exec");
      await host.commands[0]?.execute({ args: [] });

      expect(observed).toBeDefined();
      expect(observed?.state).toBeDefined();
      await expect(
        observed?.ui.input({ label: "not interactive" })
      ).rejects.toThrow("Interactive extension UI is unavailable in exec mode");
    } finally {
      await parent.dispose();
      await host.dispose();
    }
  });

  it("isolates immutable config, JSON state, and argv execution per extension", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "pss-extension-state-"));
    const workspace = process.cwd();
    let services: CodingAgentExtensionServices | undefined;
    const host = await createCodingAgentExtensionHost(
      [
        {
          config: { enabled: true, nested: { enabled: true } },
          default(pss) {
            pss.on("activate", (context) => {
              services = context.services;
            });
          },
          id: "state-owner",
        },
      ],
      {
        dataRoot,
        workspace,
      }
    );
    const parent = await createParentAgent();
    const previousSecret = process.env.EXTENSION_TEST_API_KEY;
    process.env.EXTENSION_TEST_API_KEY = "must-not-leak";

    try {
      await host.activate(parent, "exec");
      await services?.state.set({ count: 1 });

      expect(services?.config).toEqual({
        enabled: true,
        nested: { enabled: true },
      });
      expect(Object.isFrozen(services?.config)).toBe(true);
      expect(Object.isFrozen(services?.config.nested)).toBe(true);
      await expect(
        services?.state.set({ value: undefined } as never)
      ).rejects.toThrow("Extension state must contain only JSON data");
      expect(
        await services?.state.update((state) => ({
          count: Number((state as { count: number }).count) + 1,
        }))
      ).toEqual({ count: 2 });
      await expect(
        services?.exec.run({
          args: [
            "-e",
            "process.stdout.write(process.env.EXTENSION_TEST_API_KEY ?? 'missing')",
          ],
          command: process.execPath,
        })
      ).resolves.toMatchObject({ cwd: workspace, stdout: "missing" });
      await expect(
        services?.exec.run({
          args: ["-e", ""],
          command: process.execPath,
          cwd: "..",
        })
      ).rejects.toThrow("Extension exec cwd must stay inside the workspace");
      // The timeout must exceed child Node boot time on a loaded CI runner;
      // otherwise SIGTERM lands before the handler is registered and the
      // process exits on SIGTERM without exercising SIGKILL escalation.
      await expect(
        services?.exec.run({
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 10000)",
          ],
          command: process.execPath,
          timeoutMs: 750,
        })
      ).resolves.toMatchObject({ signal: "SIGKILL", timedOut: true });
    } finally {
      if (previousSecret === undefined) {
        delete process.env.EXTENSION_TEST_API_KEY;
      } else {
        process.env.EXTENSION_TEST_API_KEY = previousSecret;
      }
      await parent.dispose();
      await host.dispose();
      await rm(dataRoot, { force: true, recursive: true });
    }
  });

  it("keeps persistent state isolated by extension owner", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "pss-extension-state-"));
    const services = new Map<string, CodingAgentExtensionServices>();
    const extensions = ["first", "second"].map(
      (id): CodingAgentExtensionModule => ({
        default(pss) {
          pss.on("activate", (context) => {
            services.set(id, context.services);
          });
        },
        id,
      })
    );
    const host = await createCodingAgentExtensionHost(extensions, { dataRoot });
    const parent = await createParentAgent();

    try {
      await host.activate(parent, "exec");
      await services.get("first")?.state.set({ owner: "first" });
      await services.get("second")?.state.set({ owner: "second" });

      await expect(services.get("first")?.state.get()).resolves.toEqual({
        owner: "first",
      });
      await expect(services.get("second")?.state.get()).resolves.toEqual({
        owner: "second",
      });
    } finally {
      await parent.dispose();
      await host.dispose();
      await rm(dataRoot, { force: true, recursive: true });
    }
  });
});
