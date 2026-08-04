import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

const ARROW_GLYPH = /[►▶▼◀▲]/u;

import { describe, expect, it } from "vitest";
import { renderDiagramArt } from "./mermaid-art-worker";
import { extractMermaidBlocks, MermaidMarkdown } from "./mermaid-markdown";

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

  it("renders class and ER operators without mangling them", () => {
    expect(renderDiagramArt("classDiagram\n  Animal <|-- Dog")).toBeDefined();
    expect(
      renderDiagramArt("erDiagram\n  CUSTOMER ||--o{ ORDER : places")
    ).toBeDefined();
    expect(
      renderDiagramArt("erDiagram\n  CUSTOMER ||--|| ORDER : places")
    ).toBeDefined();
  });

  it("leaves arrow-like text inside bracket labels untouched", () => {
    const art = renderDiagramArt('graph LR\n  A["x-->y"] --> B');

    expect(art).toBeDefined();
    expect(art?.join("\n")).toContain("x-->y");
  });

  it("rejects single-line chains and arrowless node floods", () => {
    const chain = `graph LR\n${Array.from(
      { length: 300 },
      (_, i) => `N${i}-->N${i + 1}`
    ).join(" ")}`;
    const nodes = `graph TD\n${Array.from(
      { length: 250 },
      (_, i) => `N${i}[node ${i}]`
    ).join("\n")}`;

    expect(renderDiagramArt(chain)).toBeUndefined();
    expect(renderDiagramArt(nodes)).toBeUndefined();
  });

  it("counts bare and curly nodes and adjacent cartesian groups", () => {
    const bare = `graph TD\n${Array.from(
      { length: 250 },
      (_, i) => `N${i}`
    ).join("\n")}`;
    const curly = `graph TD\n${Array.from(
      { length: 250 },
      (_, i) => `N${i}{node ${i}}`
    ).join("\n")}`;
    const left = Array.from({ length: 30 }, (_, i) => `L${i}`).join(" & ");
    const mid = Array.from({ length: 30 }, (_, i) => `M${i}`).join(" & ");

    expect(renderDiagramArt(bare)).toBeUndefined();
    expect(renderDiagramArt(curly)).toBeUndefined();
    expect(
      renderDiagramArt(`graph LR\n  A ==> ${left} ==> ${mid} ==> D`)
    ).toBeUndefined();
  });

  it("renders sequence diagrams", () => {
    const art = renderDiagramArt(
      "sequenceDiagram\n  participant U as 사용자\n  U->>U: ping"
    );

    expect(art?.join("\n")).toContain("사용자");
  });

  it("renders sequence diagrams with textual brackets", () => {
    expect(renderDiagramArt("sequenceDiagram\nA->>B: array[0")).toBeDefined();
  });

  it("does not mistake a participant named graph for a flowchart", () => {
    const art = renderDiagramArt(
      "sequenceDiagram\n  participant graph\n  graph->>B: x-->y"
    );

    expect(art).toBeDefined();
    expect(art?.join("\n")).toContain("x-->y");
  });

  it("aligns ZWJ emoji and combining-accent labels", () => {
    const emoji = renderDiagramArt(
      "graph LR\nA[\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}]-->B"
    );
    const accent = renderDiagramArt("graph LR\nA[cafe\u0301]-->B");
    const combining = renderDiagramArt("graph LR\nA[q\u0301]-->B");
    const zeroWidth = renderDiagramArt("graph LR\nA[ab\u200Bcd]-->B");

    for (const art of [emoji, accent, combining, zeroWidth]) {
      expect(art).toBeDefined();
      expect(new Set((art ?? []).map((line) => visibleWidth(line))).size).toBe(
        1
      );
    }
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

  it("renders tight bare links as plain links", () => {
    const art = renderDiagramArt("graph TD\n  A--B");

    expect(art).toBeDefined();
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
  const withMermaidEnv = async (
    value: string | undefined,
    run: () => Promise<void> | void
  ): Promise<void> => {
    const original = process.env.PSS_MERMAID;
    if (value === undefined) {
      delete process.env.PSS_MERMAID;
    } else {
      process.env.PSS_MERMAID = value;
    }
    try {
      await run();
    } finally {
      if (original === undefined) {
        delete process.env.PSS_MERMAID;
      } else {
        process.env.PSS_MERMAID = original;
      }
    }
  };

  it("appends box art below the preserved source fence", async () => {
    await withMermaidEnv(undefined, async () => {
      let notifyReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        notifyReady = resolve;
      });
      const view = new MermaidMarkdown("", 1, 0, markdownTheme, {
        requestRender: () => notifyReady?.(),
      });
      view.setText("before\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nafter\n");
      await ready;
      const output = view.render(80).join("\n");

      expect(output).toContain("```mermaid");
      expect(output).toContain("A-->B");
      expect(output).toContain("┌");
      expect(output).toContain("after");
      expect(output.indexOf("A-->B")).toBeLessThan(output.indexOf("┌"));
      view.dispose();
    });
  });

  it("falls back to the source fence when the diagram is invalid", async () => {
    await withMermaidEnv(undefined, async () => {
      let notifyReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        notifyReady = resolve;
      });
      const view = new MermaidMarkdown("", 1, 0, markdownTheme, {
        requestRender: () => notifyReady?.(),
      });
      view.setText("```mermaid\nthis is not a diagram\n```\n");
      await ready;
      const output = view.render(80).join("\n");

      expect(output).toContain("this is not a diagram");
      expect(output).not.toContain("┌");
      view.dispose();
    });
  });

  it("renders no art when PSS_MERMAID is 0", async () => {
    await withMermaidEnv("0", () => {
      const view = new MermaidMarkdown("", 1, 0, markdownTheme);
      view.setText("```mermaid\ngraph TD;\n  A-->B;\n```\n");
      const output = view.render(80).join("\n");

      expect(output).toContain("A-->B");
      expect(output).not.toContain("┌");
      view.dispose();
    });
  });

  it("passes non-mermaid markdown through to the delegate", async () => {
    await withMermaidEnv(undefined, () => {
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

  it("saturates instead of re-enqueueing evicted diagram jobs", async () => {
    await withMermaidEnv(undefined, () => {
      const fences = Array.from(
        { length: 130 },
        (_, i) => `\`\`\`mermaid\ngraph LR\nA${i}-->B${i}\n\`\`\`\n`
      );
      const view = new MermaidMarkdown("", 1, 0, markdownTheme);
      view.setText(fences.join("\n"));
      view.setText(`${fences.join("\n")}\ntail\n`);
      const output = view.render(200).join("\n");

      expect(output).toContain("A0-->B0");
      expect(output).toContain("A129-->B129");
      const states = (view as unknown as { renderStates: Map<string, unknown> })
        .renderStates;
      expect(states.size).toBeLessThanOrEqual(128);
      view.dispose();
    });
  });
});
