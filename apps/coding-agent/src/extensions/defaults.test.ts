import { describe, expect, it } from "vitest";
import {
  createCodingAgentExtensionHostWithDefaults,
  withDefaultCodingAgentExtensions,
} from "./defaults";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionInput } from "./types";

describe("default coding-agent extensions", () => {
  it("registers web tools and renderers unless explicitly disabled", async () => {
    const enabled = await createCodingAgentExtensionHostWithDefaults([]);
    const disabled = await createCodingAgentExtensionHostWithDefaults([], {
      web: false,
    });

    expect(Object.keys(enabled.tools)).toStrictEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(Object.keys(enabled.toolRenderers)).toStrictEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(disabled.tools).toStrictEqual({});
    expect(disabled.toolRenderers).toStrictEqual({});

    await Promise.all([enabled.dispose(), disabled.dispose()]);
  });

  it("lets an explicit assistant renderer override default LaTeX", async () => {
    const preferredRenderer = () => ({
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
    const preferredExtension: CodingAgentExtensionInput = {
      configure(registry) {
        registry.tui.registerAssistantRenderer(preferredRenderer, {
          override: true,
        });
      },
      id: "preferred-renderer",
    };
    const host = await createCodingAgentExtensionHost(
      withDefaultCodingAgentExtensions([preferredExtension])
    );

    expect(host.assistantRenderer).toBe(preferredRenderer);
    expect(host.getAssistantRendererOwner()).toBe("preferred-renderer");
    await host.dispose();
  });

  it("restores the default fallback after an override is removed", async () => {
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
      id: "reload-override",
    };

    const initialHost = await createCodingAgentExtensionHostWithDefaults([]);
    const replacementHost = await createCodingAgentExtensionHostWithDefaults([
      overrideExtension,
    ]);
    const recoveredHost = await createCodingAgentExtensionHostWithDefaults([]);

    expect(initialHost.getAssistantRendererOwner()).toBe(
      "@minpeter/pss-extension-latex"
    );
    expect(replacementHost.assistantRenderer).toBe(overrideRenderer);
    expect(replacementHost.getAssistantRendererOwner()).toBe("reload-override");
    expect(recoveredHost.getAssistantRendererOwner()).toBe(
      "@minpeter/pss-extension-latex"
    );

    await Promise.all([
      initialHost.dispose(),
      replacementHost.dispose(),
      recoveredHost.dispose(),
    ]);
  });
});
