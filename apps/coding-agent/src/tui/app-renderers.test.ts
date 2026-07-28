import { describe, expect, it } from "vitest";
import type { CodingAgentExtensionInput } from "../extensions";
import { createCodingAgentExtensionHostWithBuiltIns } from "../extensions/built-in";
import type { AgentTUIConfig } from "./agent";
import { installAssistantRendererRuntime, mergeToolRenderers } from "./app";

describe("TUI extension renderer merging", () => {
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
    const replacement = await createCodingAgentExtensionHostWithBuiltIns([
      overrideExtension,
    ]);
    const recovered = await createCodingAgentExtensionHostWithBuiltIns([]);
    const runtime: Pick<
      AgentTUIConfig,
      "assistantRenderer" | "assistantRendererSignal"
    > = {};

    installAssistantRendererRuntime(runtime, startup);
    expect(runtime.assistantRenderer).toBe(startup.assistantRenderer);
    expect(runtime.assistantRendererSignal).toBe(startup.signal);

    await startup.dispose();
    expect(runtime.assistantRendererSignal?.aborted).toBe(true);
    installAssistantRendererRuntime(runtime, replacement);
    expect(runtime.assistantRenderer).toBe(overrideRenderer);
    expect(runtime.assistantRendererSignal).toBe(replacement.signal);

    await replacement.dispose();
    expect(runtime.assistantRendererSignal?.aborted).toBe(true);
    installAssistantRendererRuntime(runtime, recovered);
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
