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

  it("lets an installed extension shadow a bundled default with the same id", () => {
    const shadowLatex: CodingAgentExtensionInput = {
      configure() {
        return;
      },
      id: "@minpeter/pss-extension-latex",
    };
    const shadowMermaid: CodingAgentExtensionInput = {
      configure() {
        return;
      },
      id: "@minpeter/pss-extension-mermaid",
    };
    const shadowWeb: CodingAgentExtensionInput = {
      configure() {
        return;
      },
      id: "@minpeter/pss-extension-web",
    };

    const withShadows = withDefaultCodingAgentExtensions([
      shadowLatex,
      shadowMermaid,
      shadowWeb,
    ]);
    const byId = new Map(
      withShadows.map((extension) => [extension.id, extension])
    );

    expect(withShadows).toHaveLength(3);
    expect(byId.get("@minpeter/pss-extension-latex")).toBe(shadowLatex);
    expect(byId.get("@minpeter/pss-extension-mermaid")).toBe(shadowMermaid);
    expect(byId.get("@minpeter/pss-extension-web")).toBe(shadowWeb);
  });

  it("keeps every bundled default when no installed id collides", () => {
    const extra: CodingAgentExtensionInput = {
      configure() {
        return;
      },
      id: "extra-extension",
    };

    const ids = withDefaultCodingAgentExtensions([extra]).map(
      (extension) => extension.id
    );

    expect(ids).toStrictEqual([
      "@minpeter/pss-extension-latex",
      "@minpeter/pss-extension-mermaid",
      "@minpeter/pss-extension-web",
      "extra-extension",
    ]);
  });

  it("replaces a shadowed bundled default in its original slot", () => {
    const shadowLatex: CodingAgentExtensionInput = {
      configure() {
        return;
      },
      id: "@minpeter/pss-extension-latex",
    };

    const merged = withDefaultCodingAgentExtensions([shadowLatex]);

    expect(merged.map((extension) => extension.id)).toStrictEqual([
      "@minpeter/pss-extension-latex",
      "@minpeter/pss-extension-mermaid",
      "@minpeter/pss-extension-web",
    ]);
    expect(merged[0]).toBe(shadowLatex);
  });

  it("keeps the mermaid renderer owner when latex is shadowed", async () => {
    const shadowRenderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["shadow"];
      },
      setText() {
        return;
      },
    });
    const shadowLatex: CodingAgentExtensionInput = {
      configure(registry) {
        registry.tui.registerAssistantRenderer(shadowRenderer, {
          fallback: true,
        });
      },
      id: "@minpeter/pss-extension-latex",
    };

    const host = await createCodingAgentExtensionHostWithDefaults([
      shadowLatex,
    ]);

    expect(host.getAssistantRendererOwner()).toBe(
      "@minpeter/pss-extension-mermaid"
    );
    expect(host.getAssistantRendererChainOwners()).toEqual([
      "@minpeter/pss-extension-latex",
      "@minpeter/pss-extension-mermaid",
    ]);
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
      "@minpeter/pss-extension-mermaid"
    );
    expect(initialHost.getAssistantRendererChainOwners()).toEqual([
      "@minpeter/pss-extension-latex",
      "@minpeter/pss-extension-mermaid",
    ]);
    expect(replacementHost.assistantRenderer).toBe(overrideRenderer);
    expect(replacementHost.getAssistantRendererOwner()).toBe("reload-override");
    expect(replacementHost.getAssistantRendererChainOwners()).toEqual([]);
    expect(recoveredHost.getAssistantRendererOwner()).toBe(
      "@minpeter/pss-extension-mermaid"
    );

    await Promise.all([
      initialHost.dispose(),
      replacementHost.dispose(),
      recoveredHost.dispose(),
    ]);
  });
});
