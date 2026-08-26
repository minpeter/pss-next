import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createCodingAgent } from "../coding-agent";
import { assistantRenderer, instructions, tools } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

const validTool = tool({
  description: "Valid fixture tool",
  inputSchema: jsonSchema({ additionalProperties: false, type: "object" }),
});
const validModel = createOpenAICompatible({
  apiKey: "test-key",
  baseURL: "https://example.invalid/v1",
  name: "capability-security-test",
})("test-model");
const validRenderer = () => ({
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

describe("coding-agent extension capability security", () => {
  it("rejects malformed assistant renderer capabilities", async () => {
    const malformedRenderer = { ...assistantRenderer(validRenderer) };
    Object.defineProperty(malformedRenderer, "renderer", {
      value: "not-a-function",
    });
    const invalidRenderer: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide(malformedRenderer);
      },
      id: "invalid-assistant-renderer",
    };
    const unexpectedProperty = {
      ...assistantRenderer(validRenderer),
      extra: true,
    };
    const extraProperty: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide(unexpectedProperty);
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
    const contradictoryCapability = { ...assistantRenderer(validRenderer) };
    Object.defineProperties(contradictoryCapability, {
      fallback: { value: true },
      override: { value: true },
    });
    const contradictory: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide(contradictoryCapability);
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
    const capability = { ...instructions("instruction") };
    Object.defineProperty(capability, "kind", {
      enumerable: true,
      get: () => "tools",
    });
    const extension: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide(capability);
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
      ...instructions("instruction"),
      [Symbol("forged")]: true,
    };
    const creation = createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(capability);
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
    await expect(invalidId).rejects.toThrow("Invalid extension id.");

    const malformedTools = { valid_tool: validTool };
    Object.defineProperty(malformedTools, "bad name", { value: {} });
    const invalidTool = createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(tools(malformedTools));
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
          pss.provide(tools({ shared_tool: validTool }));
        },
        id: "first-provider",
      },
      {
        default(pss) {
          pss.provide(tools({ shared_tool: validTool }));
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
          pss.provide(tools({ shell_execute: validTool }));
        },
        id: "builtin-tool-provider",
      },
    ]);
    try {
      expect(() =>
        createCodingAgent({
          extensionHost: host,
          model: validModel,
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
