import { decode } from "fast-png";
import { describe, expect, it } from "vitest";
import {
  formulaCjkLocale,
  formulaSupported,
  renderMathJaxPng,
} from "./mathjax-renderer";

const visibleBounds = (png: Buffer) => {
  const image = decode(png);
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  const alpha = image.channels - 1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      if ((image.data[offset + alpha] ?? 0) === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { height: maxY - minY + 1, image, width: maxX - minX + 1 };
};

describe("MathJax and resvg WASM renderer", () => {
  it.each([
    ["ASCII", "x^2+y^2=z^2"],
    ["multiline AMS", String.raw`\begin{aligned}a&=b+c\\d&=e-f\end{aligned}`],
    ["Korean/CJK", String.raw`\text{타원곡선 椭圆曲线}`],
    ["Arabic/Hebrew", String.raw`\text{مرحبا שלום}`],
    ["Devanagari", String.raw`\text{नमस्ते दुनिया}`],
    ["Thai", String.raw`\text{สวัสดีชาวโลก}`],
  ])(
    "renders %s formulas from bundled assets",
    async (_name, formula) => {
      const png = await renderMathJaxPng(formula, "#2468ac");
      const bounds = visibleBounds(png);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
    },
    30_000
  );

  it("produces bounded dimensions, transparency, and requested glyph color", async () => {
    const { image, width, height } = visibleBounds(
      await renderMathJaxPng(String.raw`\frac{x}{y}`, "#123456")
    );
    expect(image.width).toBeGreaterThan(width);
    expect(image.height).toBeGreaterThan(height);
    expect(image.channels).toBe(4);
    expect(image.data[3]).toBe(0);
    let colored = false;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if ((image.data[offset + 3] ?? 0) > 200) {
        colored ||=
          image.data[offset] === 0x12 &&
          image.data[offset + 1] === 0x34 &&
          image.data[offset + 2] === 0x56;
      }
    }
    expect(colored).toBe(true);
    expect(image.width * image.height).toBeLessThan(16 * 1024 * 1024);
  });

  it("rejects malformed TeX, emoji, and unsafe macros for source fallback", async () => {
    await expect(
      renderMathJaxPng(String.raw`\text{broken`, "#000000")
    ).rejects.toThrow();
    for (const formula of [
      String.raw`\text{proof ✅}`,
      String.raw`\href{x}{y}`,
      String.raw`\style{x}{y}`,
    ]) {
      expect(formulaSupported(formula)).toBe(false);
      await expect(renderMathJaxPng(formula, "#000000")).rejects.toThrow();
    }
  });

  it("rejects undefined, require, and resource-bearing macros", async () => {
    for (const formula of [
      String.raw`\undefinedMacro{x}`,
      String.raw`\require{autoload}`,
      String.raw`\href{https://example.test}{x}`,
      String.raw`\includegraphics{file.png}`,
    ]) {
      await expect(renderMathJaxPng(formula, "#000000")).rejects.toThrow();
    }
  });

  it("rejects formulas that exceed the MathJax template limit", async () => {
    const formula = String.raw`\newcommand{\x}{x}${String.raw`\x`.repeat(1001)}`;

    await expect(renderMathJaxPng(formula, "#000000")).rejects.toThrow();
  });

  it("resolves CJK locale for locale-sensitive cache keys", () => {
    const original = process.env.PSS_LATEX_CJK_LOCALE;
    try {
      process.env.PSS_LATEX_CJK_LOCALE = "ja";
      expect(formulaCjkLocale(String.raw`\text{漢字}`)).toBe("ja");
      process.env.PSS_LATEX_CJK_LOCALE = "zh-Hant";
      expect(formulaCjkLocale(String.raw`\text{漢字}`)).toBe("zh-Hant");
      expect(formulaCjkLocale("x^2")).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.PSS_LATEX_CJK_LOCALE;
      } else {
        process.env.PSS_LATEX_CJK_LOCALE = original;
      }
    }
  });

  it("restarts successfully after an aborted worker render", async () => {
    const controller = new AbortController();
    const rendering = renderMathJaxPng(
      String.raw`\text{한글 日本語 中文} ${"x+".repeat(2000)}x`,
      "#000000",
      controller.signal
    );
    setTimeout(() => controller.abort(), 1);
    await expect(rendering).rejects.toThrow();
    await expect(renderMathJaxPng("x+1", "#000000")).resolves.toBeInstanceOf(
      Buffer
    );
  });
});
