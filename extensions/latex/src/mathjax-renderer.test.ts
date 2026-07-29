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
