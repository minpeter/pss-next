import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

const ARROW_GLYPH = /[►▶▼◀▲]/u;

import { describe, expect, it } from "vitest";
import {
  extractMermaidBlocks,
  MermaidMarkdown,
  renderDiagramArt,
} from "./mermaid-markdown";

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

describe("extractMermaidBlocks", () => {
  it("splits a complete mermaid fence from surrounding prose", () => {
    const text = "Before\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nAfter\n";
    const parts = extractMermaidBlocks(text);

    expect(parts.map((part) => part.type)).toEqual([
      "markdown",
      "mermaid",
      "markdown",
    ]);
    expect(parts[1]?.source).toBe("graph TD;\n  A-->B;");
    expect(parts[1]?.raw).toContain("```mermaid");
  });

  it("keeps an unclosed fence as markdown while streaming", () => {
    const text = "Intro\n\n```mermaid\ngraph TD;\n  A-->B;\n";

    expect(extractMermaidBlocks(text)).toEqual([
      { raw: text, type: "markdown" },
    ]);
  });

  it("ignores a mermaid fence nested inside a larger code fence", () => {
    const text = "````markdown\n```mermaid\ngraph TD;\n```\n````\n";

    expect(extractMermaidBlocks(text)).toEqual([
      { raw: text, type: "markdown" },
    ]);
  });

  it("accepts tilde fences and case-insensitive language tags", () => {
    const text = "~~~Mermaid\ngraph TD;\n~~~\n";
    const parts = extractMermaidBlocks(text);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("mermaid");
    expect(parts[0]?.source).toBe("graph TD;");
  });

  it("treats extra info text after the language tag as a plain fence", () => {
    const text = "```mermaid extra\ngraph TD;\n```\n";

    expect(extractMermaidBlocks(text)).toEqual([
      { raw: text, type: "markdown" },
    ]);
  });

  it("treats an empty diagram body as markdown", () => {
    const text = "```mermaid\n```\n";

    expect(extractMermaidBlocks(text)).toEqual([
      { raw: text, type: "markdown" },
    ]);
  });

  it("splits multiple diagrams independently", () => {
    const text =
      "```mermaid\ngraph TD; A-->B;\n```\nmiddle\n```mermaid\ngraph LR; C-->D;\n```\n";
    const parts = extractMermaidBlocks(text);

    expect(parts.map((part) => part.type)).toEqual([
      "mermaid",
      "markdown",
      "mermaid",
    ]);
    expect(parts[0]?.source).toBe("graph TD; A-->B;");
    expect(parts[2]?.source).toBe("graph LR; C-->D;");
  });
});

describe("renderDiagramArt", () => {
  it("renders a Korean flowchart as box art", () => {
    const art = renderDiagramArt("graph TD\n  A[사용자 입력] --> B[pss TUI]");

    expect(art).toBeDefined();
    expect(art?.join("\n")).toContain("사용자 입력");
    expect(art?.join("\n")).toContain("┌");
  });

  it("keeps every art line at the same visible width with CJK labels", () => {
    const art = renderDiagramArt("graph LR\nA[사용자 입력]-->B[게이트웨이]");

    expect(art).toBeDefined();
    const widths = new Set((art ?? []).map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
  });

  it("normalizes single-line and semicolon-terminated headers", () => {
    expect(renderDiagramArt("graph LR; A-->B;")).toBeDefined();
    expect(renderDiagramArt("graph LR;\nA-->B;")).toBeDefined();
  });

  it("renders unspaced arrows with both endpoints and the edge", () => {
    const art = renderDiagramArt("graph LR\nA-->B");
    const joined = art?.join("\n") ?? "";

    expect(art).toBeDefined();
    expect(joined).toContain("A");
    expect(joined).toContain("B");
    expect(joined).toMatch(ARROW_GLYPH);
  });

  it("renders unspaced edge labels", () => {
    const art = renderDiagramArt("graph LR\nA-->|yes|B");

    expect(art).toBeDefined();
    expect(art?.join("\n")).toContain("yes");
  });

  it("renders sequence diagrams", () => {
    const art = renderDiagramArt(
      "sequenceDiagram\n  participant U as 사용자\n  U->>U: ping"
    );

    expect(art?.join("\n")).toContain("사용자");
  });

  it("renders subgraph clusters without a stray end node", () => {
    const art = renderDiagramArt(`graph TD;
  subgraph client[클라이언트]
    A[input] --> B[tui];
  end;
  B --> C[agent];`);

    expect(art).toBeDefined();
    const joined = art?.join("\n") ?? "";
    expect(joined).not.toContain("│ end │");
    expect(joined).not.toContain(" end ");
  });

  it("returns undefined for invalid or unsupported sources", () => {
    expect(renderDiagramArt("not a diagram")).toBeUndefined();
    expect(renderDiagramArt("gitGraph\n  commit")).toBeUndefined();
    expect(renderDiagramArt('pie\n  "a": 1')).toBeUndefined();
  });

  it("rejects malformed bodies that render as partial diagrams", () => {
    expect(renderDiagramArt("graph TD\n  A -->")).toBeUndefined();
    expect(renderDiagramArt("graph TD\n  A[unterminated")).toBeUndefined();
  });

  it("rejects bare links the engine cannot render", () => {
    expect(renderDiagramArt("graph TD\n  A--B")).toBeUndefined();
  });

  it("rejects cartesian expansions beyond the edge budget", () => {
    const left = Array.from({ length: 50 }, (_, i) => `A${i}`).join(" & ");
    const right = Array.from({ length: 50 }, (_, i) => `B${i}`).join(" & ");
    const source = `graph TD\n  ${left} --> ${right}`;

    expect(renderDiagramArt(source)).toBeUndefined();
  });

  it("rejects sources that already use the reserved placeholder range", () => {
    expect(
      renderDiagramArt("graph TD\n  A[\uE000\uE001] --> B[ok]")
    ).toBeUndefined();
  });
});

describe("MermaidMarkdown", () => {
  const withMermaidEnv = (value: string | undefined, run: () => void): void => {
    const original = process.env.PSS_MERMAID;
    if (value === undefined) {
      delete process.env.PSS_MERMAID;
    } else {
      process.env.PSS_MERMAID = value;
    }
    try {
      run();
    } finally {
      if (original === undefined) {
        delete process.env.PSS_MERMAID;
      } else {
        process.env.PSS_MERMAID = original;
      }
    }
  };

  it("appends box art below the preserved source fence", () => {
    withMermaidEnv(undefined, () => {
      const view = new MermaidMarkdown("", 1, 0, markdownTheme);
      view.setText("before\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nafter\n");
      const output = view.render(80).join("\n");

      expect(output).toContain("```mermaid");
      expect(output).toContain("A-->B");
      expect(output).toContain("┌");
      expect(output).toContain("after");
      expect(output.indexOf("A-->B")).toBeLessThan(output.indexOf("┌"));
      view.dispose();
    });
  });

  it("falls back to the source fence when the diagram is invalid", () => {
    withMermaidEnv(undefined, () => {
      const view = new MermaidMarkdown("", 1, 0, markdownTheme);
      view.setText("```mermaid\nthis is not a diagram\n```\n");
      const output = view.render(80).join("\n");

      expect(output).toContain("this is not a diagram");
      expect(output).not.toContain("┌");
      view.dispose();
    });
  });

  it("renders no art when PSS_MERMAID is 0", () => {
    withMermaidEnv("0", () => {
      const view = new MermaidMarkdown("", 1, 0, markdownTheme);
      view.setText("```mermaid\ngraph TD;\n  A-->B;\n```\n");
      const output = view.render(80).join("\n");

      expect(output).toContain("A-->B");
      expect(output).not.toContain("┌");
      view.dispose();
    });
  });

  it("passes non-mermaid markdown through to the delegate", () => {
    withMermaidEnv(undefined, () => {
      const delegated: string[] = [];
      const view = new MermaidMarkdown("", 1, 0, markdownTheme, {
        delegate: (text) => {
          delegated.push(text);
          return { render: () => [`D:${text}`] };
        },
      });
      view.setText("just prose");
      expect(view.render(80)).toEqual(["D:just prose"]);
      expect(delegated).toEqual(["just prose"]);
      view.dispose();
    });
  });
});
