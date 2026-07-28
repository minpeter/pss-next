import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCodingAgentExtensionHost } from "./host";
import { defineCodingAgentExtension } from "./types";

describe("CodingAgentExtensionHost", () => {
  it("configures extensions in order and composes runtime hooks", async () => {
    const configured: string[] = [];
    const assistantRenderer = () => ({
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
    const host = await createCodingAgentExtensionHost([
      defineCodingAgentExtension({
        configure(registry) {
          configured.push("first");
          registry.commands.register({
            description: "Inspect extension state",
            execute: () => ({
              action: { type: "new-session" },
              success: true,
            }),
            name: "extension",
          });
          registry.instructions.append("First instruction");
          registry.runtime.use({
            acceptInput(event) {
              if (event.type !== "user-input" || !("text" in event)) {
                return;
              }
              return {
                action: "transform",
                value: {
                  ...event,
                  text: `first:${event.text}`,
                },
              };
            },
          });
          registry.tools.register(
            "extension_status",
            tool({
              description: "Return extension status",
              execute: () => ({ ready: true }),
              inputSchema: z.object({}),
            })
          );
          registry.tui.registerToolRenderer(
            "extension_status",
            () => undefined
          );
          registry.tui.registerAssistantRenderer(assistantRenderer);
        },
        id: "first",
      }),
      defineCodingAgentExtension({
        configure(registry) {
          configured.push("second");
          registry.instructions.append("Second instruction");
          registry.runtime.use({
            acceptInput(event) {
              if (event.type !== "user-input" || !("text" in event)) {
                return;
              }
              return {
                action: "transform",
                value: {
                  ...event,
                  text: `second:${event.text}`,
                },
              };
            },
          });
        },
        id: "second",
      }),
    ]);

    const decision = await host.hooks?.acceptInput?.(
      { text: "hello", type: "user-input" },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );

    expect(configured).toEqual(["first", "second"]);
    expect(host.instructionFragments).toEqual([
      "First instruction",
      "Second instruction",
    ]);
    expect(host.commands.map(({ name }) => name)).toEqual(["extension"]);
    expect(Object.keys(host.tools)).toEqual(["extension_status"]);
    expect(Object.keys(host.toolRenderers)).toEqual(["extension_status"]);
    expect(host.assistantRenderer).toBe(assistantRenderer);
    expect(decision).toEqual({
      action: "transform",
      value: { text: "second:first:hello", type: "user-input" },
    });
    await host.dispose();
  });

  it("activates in order and cleans up in reverse order", async () => {
    const lifecycle: string[] = [];
    const host = await createCodingAgentExtensionHost([
      defineCodingAgentExtension({
        activate() {
          lifecycle.push("activate:first");
          return () => {
            lifecycle.push("dispose:first");
          };
        },
        configure() {
          lifecycle.push("configure:first");
        },
        id: "first",
      }),
      defineCodingAgentExtension({
        activate() {
          lifecycle.push("activate:second");
          return () => {
            lifecycle.push("dispose:second");
          };
        },
        configure() {
          lifecycle.push("configure:second");
        },
        id: "second",
      }),
    ]);
    const provider = createOpenAICompatible({
      apiKey: "test",
      baseURL: "https://example.com/v1",
      name: "test",
    });
    const agent = await createAgent({ model: provider("model") });

    await host.activate(agent, "exec");
    await host.dispose();
    await agent.dispose();

    expect(lifecycle).toEqual([
      "configure:first",
      "configure:second",
      "activate:first",
      "activate:second",
      "dispose:second",
      "dispose:first",
    ]);
  });

  it("rejects a non-function activation cleanup", async () => {
    // Given
    const host = await createCodingAgentExtensionHost([
      defineCodingAgentExtension({
        activate() {
          return JSON.parse('{"cleanup":"invalid"}');
        },
        configure() {
          return;
        },
        id: "invalid-cleanup",
      }),
    ]);
    const provider = createOpenAICompatible({
      apiKey: "test",
      baseURL: "https://example.com/v1",
      name: "test",
    });
    const agent = await createAgent({ model: provider("model") });

    // When
    const activation = host.activate(agent, "exec");

    // Then
    await expect(activation).rejects.toMatchObject({
      cause: {
        message:
          'Coding agent extension "invalid-cleanup" activation handler must return a cleanup function',
      },
      extensionId: "invalid-cleanup",
      phase: "activate",
    });
    await agent.dispose();
  });

  it("rejects duplicate extension identities", async () => {
    const extension = defineCodingAgentExtension({
      configure() {
        return;
      },
      id: "duplicate",
    });

    await expect(
      createCodingAgentExtensionHost([extension, extension])
    ).rejects.toThrow('Duplicate coding agent extension "duplicate"');
  });

  it("rejects registrations after configure completes", async () => {
    let registerLate: (() => void) | undefined;
    const host = await createCodingAgentExtensionHost([
      defineCodingAgentExtension({
        configure(registry) {
          registerLate = () => {
            registry.instructions.append("late");
          };
        },
        id: "late",
      }),
    ]);

    expect(registerLate).toBeDefined();
    expect(registerLate).toThrow("registration is closed");
    await host.dispose();
  });
});
