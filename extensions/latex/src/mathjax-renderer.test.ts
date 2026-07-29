import { describe, expect, it } from "vitest";
import { renderMathJaxSvg } from "./mathjax-renderer";

const SVG_WIDTH_PATTERN = /\bwidth="([0-9]+)px"/;
const SVG_HEIGHT_PATTERN = /\bheight="([0-9]+)px"/;

describe("renderMathJaxSvg", () => {
  it("normalizes CJK display math into a portable SVG", async () => {
    const formula = String.raw`\text{타원곡선} \implies \text{弗赖 곡선}`;

    const svg = await renderMathJaxSvg(formula, "#e8e8e8");

    expect(svg).toContain("타원곡선");
    expect(svg).toContain("弗赖 곡선");
    expect(svg.match(SVG_WIDTH_PATTERN)?.[1]).toBeDefined();
    expect(svg.match(SVG_HEIGHT_PATTERN)?.[1]).toBeDefined();
    expect(svg).not.toContain("currentColor");
    expect(svg).toContain('fill="#e8e8e8"');
    expect(svg).toContain(
      'font-family="Noto Sans CJK KR, Noto Sans CJK JP, NanumGothic, sans-serif"'
    );
  });
});
