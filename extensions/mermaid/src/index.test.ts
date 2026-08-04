import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type {
  CodingAgentExtensionFactory,
  ExtensionAPI,
  ExtensionCapability,
} from "@minpeter/pss-coding-agent/extension";
import { describe, expect, it } from "vitest";
import mermaidExtension, {
  createMermaidExtension,
  MERMAID_OUTPUT_INSTRUCTIONS,
} from "./index";

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

const recordCapabilities = async (
  factory: CodingAgentExtensionFactory
): Promise<readonly ExtensionCapability[]> => {
  const capabilities: ExtensionCapability[] = [];
  const api: ExtensionAPI = {
    on() {
      return;
    },
    provide(capability) {
      capabilities.push(capability);
    },
    use() {
      return;
    },
  };
  await factory(api);
  return capabilities;
};

describe("Mermaid extension factory", () => {
  it.each([
    ["default", mermaidExtension],
    ["named", createMermaidExtension],
  ])(
    "contributes instructions and a fallback renderer through %s",
    async (_, factory) => {
      const capabilities = await recordCapabilities(factory);
      const instructionCapability = capabilities.find(
        (capability) => capability.kind === "instructions"
      );
      const rendererCapability = capabilities.find(
        (capability) => capability.kind === "assistant-renderer"
      );

      expect(instructionCapability).toMatchObject({
        fragments: [MERMAID_OUTPUT_INSTRUCTIONS],
        kind: "instructions",
      });
      expect(rendererCapability).toMatchObject({
        fallback: true,
        kind: "assistant-renderer",
        override: false,
      });
      if (rendererCapability?.kind !== "assistant-renderer") {
        throw new Error("Expected the assistant renderer capability");
      }
      const view = rendererCapability.renderer({
        markdownTheme,
        notify: () => undefined,
        notifyOnce: () => undefined,
        requestRender: () => undefined,
        signal: new AbortController().signal,
      });
      view.setText("plain assistant text");

      expect(view.render(80).join("\n")).toContain("plain assistant text");
      view.dispose?.();
    }
  );

  it("documents complete mermaid fence output", () => {
    expect(MERMAID_OUTPUT_INSTRUCTIONS).toContain("```mermaid");
    expect(MERMAID_OUTPUT_INSTRUCTIONS).toContain(
      "close the fence before continuing"
    );
    expect(MERMAID_OUTPUT_INSTRUCTIONS).toContain("one diagram per fence");
    expect(MERMAID_OUTPUT_INSTRUCTIONS).toContain("valid Mermaid source");
  });
});
