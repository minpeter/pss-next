import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCapability,
  ExtensionFactory,
} from "@minpeter/pss-extension-api";
import { describe, expect, it } from "vitest";
import latexExtension, {
  createLatexExtension,
  LATEX_OUTPUT_INSTRUCTIONS,
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
  factory: ExtensionFactory
): Promise<readonly ExtensionCapability[]> => {
  const capabilities: ExtensionCapability[] = [];
  const api: ExtensionAPI = {
    provide(capability) {
      capabilities.push(capability);
    },
  };
  await factory(api);
  return capabilities;
};

describe("LaTeX extension factory", () => {
  it.each([
    ["default", latexExtension],
    ["named", createLatexExtension],
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
        fragments: [LATEX_OUTPUT_INSTRUCTIONS],
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

  it("documents complete display math output", () => {
    expect(LATEX_OUTPUT_INSTRUCTIONS).toContain(
      "using $$ delimiters on their own lines"
    );
    expect(LATEX_OUTPUT_INSTRUCTIONS).toContain(
      "terminate each row with two literal backslash characters (\\\\)"
    );
    expect(LATEX_OUTPUT_INSTRUCTIONS).toContain(
      "close every display block before continuing"
    );
    expect(LATEX_OUTPUT_INSTRUCTIONS).toContain(
      "Use $...$ only for short inline variables and compact expressions"
    );
  });
});
