import {
  getCapabilities,
  type MarkdownTheme,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createCodingAgentExtensionHostWithDefaults } from "./defaults";

const KITTY_SEQUENCE = "_G";
const BOX_ART = "┌";

const markdownTheme: MarkdownTheme = {
  bold: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  heading: (text) => text,
  hr: (text) => text,
  italic: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  listBullet: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

describe("default assistant renderer composition", () => {
  it("renders display math and mermaid diagrams through one fallback chain", async () => {
    const originalCapabilities = getCapabilities();
    setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
    try {
      const host = await createCodingAgentExtensionHostWithDefaults([], {
        web: false,
      });
      expect(host.getAssistantRendererChainOwners()).toEqual([
        "@minpeter/pss-extension-latex",
        "@minpeter/pss-extension-mermaid",
      ]);

      let resolveReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const view = host.assistantRenderer?.({
        markdownTheme,
        notify: () => undefined,
        notifyOnce: () => undefined,
        requestRender: () => {
          const output = view?.render(80).join("\n") ?? "";
          if (output.includes(KITTY_SEQUENCE) && !output.includes("x = 1")) {
            resolveReady?.();
          }
        },
        signal: host.signal,
      });
      view?.setText(
        "Before\n\n$$\nx = 1\n$$\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n"
      );
      view?.render(80);
      await ready;

      const output = view?.render(80).join("\n") ?? "";
      expect(output).toContain("Before");
      expect(output).toContain(KITTY_SEQUENCE);
      expect(output).toContain("```mermaid");
      expect(output).toContain("graph TD");
      expect(output).toContain(BOX_ART);
      expect(output).not.toContain("x = 1");
      view?.dispose?.();
      await host.dispose();
    } finally {
      setCapabilities(originalCapabilities);
    }
  }, 60_000);
});
