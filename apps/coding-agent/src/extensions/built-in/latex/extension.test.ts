import {
  getCapabilities,
  type MarkdownTheme,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createAssistantRendererNotifications } from "../../../tui/assistant-renderer";
import { createCodingAgentExtensionHost } from "../../host";
import defaultLatexExtension, {
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

describe("built-in LaTeX extension", () => {
  it("exports its factory as the package default", () => {
    expect(defaultLatexExtension().id).toBe(createLatexExtension().id);
  });

  it("contributes the renderer and output instructions", async () => {
    const host = await createCodingAgentExtensionHost([createLatexExtension()]);
    const renderer = host.assistantRenderer;

    expect(host.instructionFragments).toEqual([LATEX_OUTPUT_INSTRUCTIONS]);
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
    expect(renderer).toBeTypeOf("function");

    const view = renderer?.({
      markdownTheme,
      notify: () => undefined,
      notifyOnce: () => undefined,
      requestRender: () => undefined,
      signal: new AbortController().signal,
    });
    view?.setText("plain assistant text");

    expect(view?.render(80).join("\n")).toContain("plain assistant text");
    await host.dispose();
  });

  it("deduplicates missing dependencies across extension reloads", async () => {
    const originalCapabilities = getCapabilities();
    const originalLatex = process.env.PSS_LATEX;
    const originalPath = process.env.PATH;
    const messages: string[] = [];
    const notifications = createAssistantRendererNotifications((message) => {
      messages.push(message);
    });
    const renderMissingDependency = async (
      host: Awaited<ReturnType<typeof createCodingAgentExtensionHost>>,
      formula: string
    ): Promise<void> => {
      let resolveRedraw: (() => void) | undefined;
      const redraw = new Promise<void>((resolve) => {
        resolveRedraw = resolve;
      });
      const view = host.assistantRenderer?.({
        markdownTheme,
        ...notifications,
        requestRender: () => resolveRedraw?.(),
        signal: host.signal,
      });
      view?.setText(`$$\n${formula}\n$$`);
      view?.render(80);
      await redraw;
      view?.dispose?.();
    };

    try {
      process.env.PATH = "";
      process.env.PSS_LATEX = "1";
      setCapabilities({
        hyperlinks: true,
        images: "kitty",
        trueColor: true,
      });
      const initialHost = await createCodingAgentExtensionHost([
        createLatexExtension(),
      ]);
      await renderMissingDependency(initialHost, "x = 101");
      await initialHost.dispose();

      const reloadedHost = await createCodingAgentExtensionHost([
        createLatexExtension(),
      ]);
      await renderMissingDependency(reloadedHost, "x = 102");
      await reloadedHost.dispose();

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("`latex` was not found");
    } finally {
      setCapabilities(originalCapabilities);
      if (originalLatex === undefined) {
        delete process.env.PSS_LATEX;
      } else {
        process.env.PSS_LATEX = originalLatex;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});
