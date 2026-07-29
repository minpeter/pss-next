import { describe, expect, it } from "vitest";
import { createCodingAgent } from "../coding-agent";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

describe("coding-agent extension capability security", () => {
  it("rejects malformed assistant renderer capabilities", async () => {
    const invalidRenderer: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide({
          fallback: false,
          kind: "assistant-renderer",
          override: false,
          renderer: "not-a-function",
        } as never);
      },
      id: "invalid-assistant-renderer",
    };
    const extraProperty: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide({
          extra: true,
          fallback: false,
          kind: "assistant-renderer",
          override: false,
          renderer: () => undefined,
        } as never);
      },
      id: "extra-assistant-renderer-property",
    };

    await expect(
      createCodingAgentExtensionHost([invalidRenderer])
    ).rejects.toMatchObject({
      cause: { message: "Assistant renderer must be a function" },
    });
    await expect(
      createCodingAgentExtensionHost([extraProperty])
    ).rejects.toMatchObject({
      cause: {
        message: 'Extension capability contains unsupported property "extra"',
      },
    });
  });

  it("rejects contradictory assistant renderer registration intent", async () => {
    const contradictory: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide({
          fallback: true,
          kind: "assistant-renderer",
          override: true,
          renderer: () => undefined,
        } as never);
      },
      id: "contradictory-assistant-renderer",
    };

    await expect(
      createCodingAgentExtensionHost([contradictory])
    ).rejects.toMatchObject({
      cause: {
        message: "Assistant renderer cannot be both a fallback and an override",
      },
    });
  });

  it("rejects accessor capability envelopes", async () => {
    const capability = {};
    Object.defineProperty(capability, "kind", {
      enumerable: true,
      get: () => "tools",
    });
    const extension: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide(capability as never);
      },
      id: "accessor-provider",
    };

    await expect(
      createCodingAgentExtensionHost([extension])
    ).rejects.toMatchObject({
      cause: {
        message: "Extension capability must contain only data properties",
      },
    });
  });

  it("rejects symbol properties on capability envelopes", async () => {
    const capability = {
      fragments: ["instruction"],
      kind: "instructions",
      [Symbol("forged")]: true,
    };
    const creation = createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(capability as never);
        },
        id: "symbol-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });

    await expect(creation).rejects.toMatchObject({
      cause: {
        message: "Extension capability contains unsupported symbol property",
      },
    });
  });

  it("rejects malformed extension and contribution names", async () => {
    const invalidId = createCodingAgentExtensionHost([
      {
        default: () => undefined,
        id: "bad id",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });
    await expect(invalidId).rejects.toThrow('Invalid extension id "bad id"');

    const invalidTool = createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide({
            kind: "tools",
            tools: { "bad name": {} },
          } as never);
        },
        id: "bad-tool-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });
    await expect(invalidTool).rejects.toMatchObject({
      cause: { message: 'Invalid tool name "bad name"' },
    });

    const invalidCommand = createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register({
            aliases: ["bad alias"],
            description: "Invalid alias",
            execute: () => ({ success: true }),
            name: "valid-command",
          });
        },
        id: "bad-command-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });
    await expect(invalidCommand).rejects.toMatchObject({
      cause: { message: 'Invalid coding agent command name "bad alias"' },
    });
  });

  it("attributes cross-extension and built-in tool collisions", async () => {
    const duplicate = createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide({
            kind: "tools",
            tools: { shared_tool: {} },
          } as never);
        },
        id: "first-provider",
      },
      {
        default(pss) {
          pss.provide({
            kind: "tools",
            tools: { shared_tool: {} },
          } as never);
        },
        id: "second-provider",
      },
    ]);
    await expect(duplicate).rejects.toMatchObject({
      cause: {
        message:
          'Tool "shared_tool" from extension "second-provider" conflicts with extension "first-provider"',
      },
    });

    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide({
            kind: "tools",
            tools: { shell_execute: {} },
          } as never);
        },
        id: "builtin-tool-provider",
      },
    ]);
    try {
      expect(() =>
        createCodingAgent({
          extensionHost: host,
          model: {} as never,
          webTools: { webToolsAvailability: "disabled" },
          workspace: "/workspace",
        })
      ).toThrow(
        'Extension "builtin-tool-provider" tool "shell_execute" conflicts with built-in tool'
      );
    } finally {
      await host.dispose();
    }
  });
});
