import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { assistantRenderer, instructions } from "@minpeter/pss-extension-api";
import { createAgent } from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { command, threadMigration, toolRenderer, tools } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

const qaTool = tool({
  description: "Capability QA tool",
  inputSchema: jsonSchema({
    additionalProperties: false,
    type: "object",
  }),
});

describe("coding-agent extension capabilities", () => {
  it("registers one assistant renderer through the capability API", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["assistant renderer"];
      },
      setText() {
        return;
      },
    });
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(assistantRenderer(renderer));
        },
        id: "assistant-renderer",
      },
    ]);

    expect(host.assistantRenderer).toBe(renderer);
    expect(host.getAssistantRendererOwner()).toBe("assistant-renderer");
    await host.dispose();
  });

  it("rejects conflicting assistant renderers", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return [];
      },
      setText() {
        return;
      },
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer));
          },
          id: "first-renderer",
        },
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer));
          },
          id: "second-renderer",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Assistant renderer from extension "second-renderer" conflicts with extension "first-renderer"',
      },
    });
  });

  it("lets a default assistant renderer replace a bundled fallback", async () => {
    const fallback = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["fallback"];
      },
      setText() {
        return;
      },
    });
    const preferred = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["preferred"];
      },
      setText() {
        return;
      },
    });
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(assistantRenderer(fallback, { fallback: true }));
        },
        id: "bundled-fallback",
      },
      {
        default(pss) {
          pss.provide(assistantRenderer(preferred, { override: true }));
        },
        id: "preferred-renderer",
      },
    ]);

    expect(host.assistantRenderer).toBe(preferred);
    expect(host.getAssistantRendererOwner()).toBe("preferred-renderer");
    await host.dispose();
  });

  it("requires explicit intent to replace a bundled fallback", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return [];
      },
      setText() {
        return;
      },
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer, { fallback: true }));
          },
          id: "bundled-fallback",
        },
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer));
          },
          id: "implicit-replacement",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Assistant renderer from extension "implicit-replacement" conflicts with extension "bundled-fallback"; register with { override: true } to replace the fallback',
      },
    });
  });

  it("exposes only the three factory composition methods", async () => {
    let keys: string[] = [];
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          keys = Object.keys(pss).sort();
        },
        id: "minimal-surface",
      },
    ]);

    try {
      expect(keys).toEqual(["on", "provide", "use"]);
    } finally {
      await host.dispose();
    }
  });

  it("publishes every capability kind through provide", async () => {
    const renderer = () => undefined;
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(instructions("Capability instruction"));
          pss.provide(tools({ capability_tool: qaTool }));
          pss.provide(
            command({
              aliases: ["cap"],
              description: "Inspect capabilities",
              execute: () => ({ success: true }),
              name: "capability",
            })
          );
          pss.provide(
            threadMigration({
              id: "sanitize",
              migrate: (snapshot) => snapshot,
              version: 1,
            })
          );
          pss.provide(toolRenderer("capability_tool", renderer));
        },
        id: "capability-provider",
      },
    ]);

    try {
      expect(host.instructionFragments).toEqual(["Capability instruction"]);
      expect(Object.keys(host.tools)).toEqual(["capability_tool"]);
      expect(host.commands.map(({ name }) => name)).toEqual(["capability"]);
      expect(host.threadMigrations.map(({ id }) => id)).toEqual([
        "capability-provider/sanitize",
      ]);
      expect(host.toolRenderers.capability_tool).toBe(renderer);
    } finally {
      await host.dispose();
    }
  });

  it("registers activation and reverse cleanup through on", async () => {
    const lifecycle: string[] = [];
    const extensionModule: CodingAgentExtensionModule = {
      default(pss) {
        const on = pss.on as (
          type: "activate",
          handler: (context: { readonly mode: string }) => () => void
        ) => void;
        on("activate", ({ mode }) => {
          lifecycle.push(`first:${mode}`);
          return () => lifecycle.push("cleanup:first");
        });
        on("activate", () => {
          lifecycle.push("second");
          return () => lifecycle.push("cleanup:second");
        });
      },
      id: "activation-provider",
    };
    const host = await createCodingAgentExtensionHost([extensionModule]);
    const agent = await createAgent({
      model: createOpenAICompatible({
        apiKey: "test-key",
        baseURL: "https://example.invalid/v1",
        name: "capability-test",
      })("test-model"),
    });

    try {
      await host.activate(agent, "exec");
    } finally {
      await host.dispose();
      await agent.dispose();
    }

    expect(lifecycle).toEqual([
      "first:exec",
      "second",
      "cleanup:second",
      "cleanup:first",
    ]);
  });

  it("snapshots commands instead of retaining extension containers", async () => {
    const aliases = ["before-alias"];
    const command = {
      aliases,
      description: "Before",
      execute: () => ({ success: true }),
      name: "before",
    };
    const host = await createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register(command);
        },
        id: "snapshot-provider",
      },
    ]);

    command.name = "after";
    command.description = "After";
    aliases[0] = "after-alias";

    try {
      expect(host.commands[0]).toMatchObject({
        aliases: ["before-alias"],
        description: "Before",
        name: "before",
      });
    } finally {
      await host.dispose();
    }
  });

  it("rejects duplicate command aliases before publication", async () => {
    const creation = createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register({
            aliases: ["shared"],
            description: "First",
            execute: () => ({ success: true }),
            name: "first",
          });
          registry.commands.register({
            aliases: ["shared"],
            description: "Second",
            execute: () => ({ success: true }),
            name: "second",
          });
        },
        id: "alias-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });

    await expect(creation).rejects.toMatchObject({
      cause: {
        message:
          'Command name or alias "shared" from extension "alias-provider" conflicts with extension "alias-provider"',
      },
    });
  });

  it("rejects extension commands that shadow built-ins", async () => {
    const creation = createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register({
            description: "Override clear",
            execute: () => ({ success: true }),
            name: "clear",
          });
        },
        id: "builtin-shadow-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });

    await expect(creation).rejects.toMatchObject({
      cause: {
        message: 'Reserved coding agent command name or alias "clear"',
      },
    });
  });
});
