import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { modelProvider } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionUi } from "./types";

interface FutureServices {
  readonly agents: {
    create(options: {
      readonly instructions: string;
      readonly model?: { readonly id: string; readonly provider: string };
    }): Promise<unknown>;
  };
  readonly config: Readonly<Record<string, unknown>>;
  readonly exec: {
    run(options: {
      readonly args: readonly string[];
      readonly command: string;
    }): Promise<unknown>;
  };
  readonly logger: {
    info(message: string, data?: unknown): void;
  };
  readonly state: {
    get(): Promise<unknown>;
    set(value: unknown): Promise<void>;
  };
  readonly ui: {
    confirm(message: string): Promise<boolean>;
    input(options: { readonly label: string }): Promise<string | undefined>;
  };
}

interface FutureActivationContext {
  readonly services: FutureServices;
}

const createTestAgent = async () => {
  const provider = createOpenAICompatible({
    apiKey: "test",
    baseURL: "https://example.com/v1",
    name: "test",
  });
  return await createAgent({ model: provider("model") });
};

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("extension runtime services", () => {
  it("provides every host-owned service through activation without expanding the factory", async () => {
    let factoryKeys: string[] = [];
    let activation: FutureActivationContext | undefined;
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          factoryKeys = Object.keys(pss).sort();
          pss.on("activate", (context) => {
            activation = context as unknown as FutureActivationContext;
          });
        },
        id: "service-consumer",
      },
    ]);
    const agent = await createTestAgent();

    try {
      await host.activate(agent, "exec");

      expect(factoryKeys).toEqual(["on", "provide", "use"]);
      expect(activation?.services).toMatchObject({
        agents: { create: expect.any(Function) },
        config: {},
        exec: { run: expect.any(Function) },
        logger: { info: expect.any(Function) },
        state: {
          get: expect.any(Function),
          set: expect.any(Function),
        },
        ui: {
          confirm: expect.any(Function),
          input: expect.any(Function),
        },
      });
    } finally {
      await agent.dispose();
      await host.dispose();
    }
  });

  it("rejects interactive UI explicitly in exec mode", async () => {
    let activation: FutureActivationContext | undefined;
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.on("activate", (context) => {
            activation = context as unknown as FutureActivationContext;
          });
        },
        id: "exec-ui-boundary",
      },
    ]);
    const agent = await createTestAgent();

    try {
      await host.activate(agent, "exec");

      await expect(
        activation?.services.ui.input({ label: "Interactive input" })
      ).rejects.toThrow("Interactive extension UI is unavailable in exec mode");
    } finally {
      await agent.dispose();
      await host.dispose();
    }
  });

  it("keeps extension process execution inside the workspace", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "pss-runtime-core-hooks-extension-")
    );
    cleanupRoots.push(workspace);
    let activation: FutureActivationContext | undefined;
    const host = await createCodingAgentExtensionHost(
      [
        {
          default(pss) {
            pss.on("activate", (context) => {
              activation = context as unknown as FutureActivationContext;
            });
          },
          id: "exec-workspace-boundary",
        },
      ],
      { workspace }
    );
    const agent = await createTestAgent();

    try {
      await host.activate(agent, "exec");

      await expect(
        activation?.services.exec.run({
          args: ["-e", "process.stdout.write(process.cwd())"],
          command: process.execPath,
        })
      ).resolves.toMatchObject({
        cwd: expect.stringContaining("pss-runtime-core-hooks-extension"),
      });
    } finally {
      await agent.dispose();
      await host.dispose();
    }
  });

  it("does not time out activation while a real TUI dialog is pending", async () => {
    const input = deferred<string | undefined>();
    const started = deferred<void>();
    const ui: CodingAgentExtensionUi = {
      confirm: async () => false,
      input: async () => {
        started.resolve();
        return await input.promise;
      },
      notify: () => undefined,
      select: async () => undefined,
      status: () => () => undefined,
    };
    const host = await createCodingAgentExtensionHost(
      [
        {
          default(pss) {
            pss.on("activate", async ({ services }) => {
              await services.ui.input({ label: "Extension dialog" });
            });
          },
          id: "interactive-activation",
        },
      ],
      { timeoutMs: 5 }
    );
    host.bindUi(ui);
    const agent = await createTestAgent();

    try {
      const activation = host.activate(agent, "tui");
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.resolve("approved");

      await expect(activation).resolves.toBeUndefined();
    } finally {
      input.resolve(undefined);
      await agent.dispose();
      await host.dispose();
    }
  });

  it("times out activation work that is not waiting for interactive UI", async () => {
    const host = await createCodingAgentExtensionHost(
      [
        {
          default(pss) {
            pss.on("activate", async () => {
              await new Promise<never>(() => undefined);
            });
          },
          id: "stuck-activation",
        },
      ],
      { timeoutMs: 5 }
    );
    const agent = await createTestAgent();

    try {
      await expect(host.activate(agent, "exec")).rejects.toMatchObject({
        cause: {
          message: "Coding agent extension timed out after 5ms",
        },
      });
    } finally {
      await agent.dispose();
      await host.dispose();
    }
  });

  it("stages an explicit model provider before it becomes selectable by child agents", async () => {
    const providerCapability = {
      create: () => {
        const provider = createOpenAICompatible({
          apiKey: "test",
          baseURL: "https://example.com/v1",
          name: "fixture",
        });
        return provider("fixture-model");
      },
      id: "fixture",
      models: ["fast"],
    };

    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(modelProvider(providerCapability));
        },
        id: "provider-owner",
      },
    ]);

    try {
      expect(host.getModelProviderOwner("fixture")).toBe("provider-owner");
      expect("modelProviders" in host).toBe(false);
    } finally {
      await host.dispose();
    }
  });
});
