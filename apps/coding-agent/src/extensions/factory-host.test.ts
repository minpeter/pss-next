import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { instructions } from "@minpeter/pss-extension-api";
import { createAgent } from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { tools } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type {
  CodingAgentExtensionApi,
  CodingAgentExtensionInput,
  CodingAgentExtensionModule,
} from "./types";

describe("default-export coding agent extensions", () => {
  it("configures and activates a default-export factory", async () => {
    // Given
    const lifecycle: string[] = [];
    const extensionModule: CodingAgentExtensionModule = {
      default(pss) {
        pss.provide(instructions("Factory instruction"));
        pss.on("activate", ({ mode }) => {
          lifecycle.push(`activate:${mode}`);
          return () => {
            lifecycle.push("dispose");
          };
        });
      },
      id: "factory-extension",
    };

    // When
    const host = await createCodingAgentExtensionHost([extensionModule]);
    const provider = createOpenAICompatible({
      apiKey: "test",
      baseURL: "https://example.com/v1",
      name: "test",
    });
    const agent = await createAgent({ model: provider("model") });
    await host.activate(agent, "exec");
    await host.dispose();
    await agent.dispose();

    // Then
    expect(host.instructionFragments).toEqual(["Factory instruction"]);
    expect(lifecycle).toEqual(["activate:exec", "dispose"]);
  });

  it("registers hooks through the top-level use alias", async () => {
    let aliasesMatch = false;
    const staticExtension: CodingAgentExtensionInput = {
      configure(registry) {
        aliasesMatch = registry.use === registry.runtime.use;
      },
      id: "static-alias",
    };
    const host = await createCodingAgentExtensionHost([
      staticExtension,
      {
        default(pss) {
          pss.use({
            acceptInput(event) {
              if (event.type !== "user-input" || !("text" in event)) {
                return;
              }
              return {
                action: "transform",
                value: { ...event, text: `concise:${event.text}` },
              };
            },
          });
        },
        id: "concise-hooks",
      },
    ]);

    const decision = await host.hooks?.acceptInput?.(
      { text: "hello", type: "user-input" },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "default",
      }
    );

    expect(aliasesMatch).toBe(true);
    expect(decision).toEqual({
      action: "transform",
      value: { text: "concise:hello", type: "user-input" },
    });
  });

  it("provides declarative tool contributions", async () => {
    const providedTool = tool({
      description: "Provided by an extension",
      inputSchema: jsonSchema({ additionalProperties: false, type: "object" }),
    });
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(
            tools({
              provided_tool: providedTool,
            })
          );
        },
        id: "tool-provider",
      },
    ]);

    expect(host.tools).toEqual({ provided_tool: providedTool });
  });

  it("rejects duplicate declarative tool contributions", async () => {
    const duplicateTool = tool({
      description: "Duplicate tool",
      inputSchema: jsonSchema({ additionalProperties: false, type: "object" }),
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(tools({ duplicate_tool: duplicateTool }));
            pss.provide(tools({ duplicate_tool: duplicateTool }));
          },
          id: "duplicate-provider",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Tool "duplicate_tool" from extension "duplicate-provider" conflicts with extension "duplicate-provider"',
      },
    });
  });

  it("rejects prototype-mutating tool names", async () => {
    const dangerousTool = tool({
      description: "Dangerous tool",
      inputSchema: jsonSchema({ additionalProperties: false, type: "object" }),
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(tools({ ["__proto__"]: dangerousTool }));
          },
          id: "dangerous-provider",
        },
      ])
    ).rejects.toMatchObject({
      cause: { message: 'Unsafe tool name "__proto__"' },
    });
  });

  it("rejects unknown capability kinds", async () => {
    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide({ kind: "hooks" } as never);
          },
          id: "invalid-provider",
        },
      ])
    ).rejects.toMatchObject({
      cause: { message: 'Unknown extension capability kind "hooks"' },
    });
  });

  it("rejects unknown event names from JavaScript extensions", async () => {
    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.on("turn-eror" as never, () => undefined);
          },
          id: "invalid-event",
        },
      ])
    ).rejects.toMatchObject({
      cause: { message: 'Unknown extension event "turn-eror"' },
    });
  });

  it("rejects retained concise registration methods after configure", async () => {
    let lateOn: CodingAgentExtensionApi["on"] | undefined;
    let lateProvide: CodingAgentExtensionApi["provide"] | undefined;
    let lateUse: CodingAgentExtensionApi["use"] | undefined;
    await createCodingAgentExtensionHost([
      {
        default(pss) {
          lateOn = pss.on;
          lateProvide = pss.provide;
          lateUse = pss.use;
        },
        id: "late-registration",
      },
    ]);

    expect(() => lateOn?.("turn-error", () => undefined)).toThrow(
      'Coding agent extension "late-registration" registration is closed'
    );
    expect(() => lateProvide?.(tools({}))).toThrow(
      'Coding agent extension "late-registration" registration is closed'
    );
    expect(() => lateUse?.({})).toThrow(
      'Coding agent extension "late-registration" registration is closed'
    );
  });
});
