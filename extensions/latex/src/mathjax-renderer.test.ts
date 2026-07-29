import { describe, expect, it } from "vitest";
import { renderMathJaxChtml } from "./mathjax-renderer";
import { renderUnicodeFormula } from "./unicode-browser-renderer";

describe("renderMathJaxChtml", () => {
  it("preserves Unicode text in browser-layout math", async () => {
    const formula = String.raw`\text{타원곡선} \implies \text{椭圆曲线}`;

    const result = await renderMathJaxChtml(formula);

    expect(result.html).toContain("타원곡선");
    expect(result.html).toContain("椭圆曲线");
    expect(result.html).toContain("mjx-mtext");
    expect(result.css).toContain("@font-face");
  });

  it("renders AMS negated-existence symbols without truncation", async () => {
    const formula = String.raw`\boxed{\forall n > 2,\ \nexists x,y,z \in \mathbb{Z}_{>0} \text{ such that } x^n+y^n=z^n}
\quad \text{(양의 정수해 없음)}`;
    const result = await renderMathJaxChtml(formula);
    const rendered = await renderUnicodeFormula(formula, "#e8e8e8");

    expect(result.html).not.toContain("data-mjx-error");
    expect(result.html).toContain('data-latex="\\nexists"');
    expect(rendered.png.readUInt32BE(16)).toBeGreaterThan(500);
  });

  it("renders multiline boxed Unicode formulas without truncation", async () => {
    const result = await renderUnicodeFormula(
      String.raw`\boxed{
\forall n>2,\quad
x^n+y^n=z^n
\text{은 양의 정수해를 갖지 않는다}
}`,
      "#e8e8e8"
    );

    expect(result.png.readUInt32BE(16)).toBeGreaterThan(500);
    expect(result.probe.containerWidth).toBeGreaterThanOrEqual(
      result.probe.runs[0]?.width ?? Number.POSITIVE_INFINITY
    );
    expect(result.probe.runs).toContainEqual(
      expect.objectContaining({
        text: "은 양의 정수해를 갖지 않는다",
        visible: true,
      })
    );
  });

  it("preserves RTL text order in Unicode runs", async () => {
    const result = await renderUnicodeFormula(
      String.raw`\text{שלום עולם}`,
      "#e8e8e8"
    );

    expect(result.png.length).toBeGreaterThan(500);
    const run = result.probe.runs[0];
    expect(run).toMatchObject({
      direction: "rtl",
      fontAvailable: true,
      text: "שלום עולם",
      visible: true,
    });
    expect(run?.clusterLefts[0]).toBeGreaterThan(
      run?.clusterLefts.at(-1) ?? Number.POSITIVE_INFINITY
    );
  });
});
