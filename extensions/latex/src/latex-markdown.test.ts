import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  getCapabilities,
  getCellDimensions,
  type MarkdownTheme,
  setCapabilities,
  setCellDimensions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractDisplayMath,
  highlightInlineMath,
  kittyPlaceholderLines,
  LatexMarkdown,
  latexColor,
  normalizeLatexFormula,
  postProcessPngArgs,
} from "./latex-markdown";

const originalCellDimensions = getCellDimensions();
const originalCapabilities = getCapabilities();
const originalCacheDirectory = process.env.PSS_LATEX_CACHE_DIR;
const originalLatexColor = process.env.PSS_LATEX_COLOR;
const originalLatexSetting = process.env.PSS_LATEX;
const originalLatexAspect = process.env.PSS_LATEX_ASPECT;
const originalLatexScale = process.env.PSS_LATEX_SCALE;
const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];
const hasExecutable = (name: string): boolean =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => existsSync(join(directory, name)));
const canRenderUnicode =
  process.platform === "linux" &&
  hasExecutable("bwrap") &&
  hasExecutable("prlimit") &&
  (hasExecutable("magick") || hasExecutable("convert"));
const relativeLuminance = (color: string): number => {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    (channels[0] ?? 0) * 0.2126 +
    (channels[1] ?? 0) * 0.7152 +
    (channels[2] ?? 0) * 0.0722
  );
};

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

beforeEach(() => {
  process.env.PSS_LATEX_ASPECT = "1";
  process.env.PSS_LATEX_SCALE = "1";
});

afterEach(async () => {
  setCellDimensions(originalCellDimensions);
  setCapabilities(originalCapabilities);
  const restoreEnvironment = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restoreEnvironment("PSS_LATEX_CACHE_DIR", originalCacheDirectory);
  restoreEnvironment("PSS_LATEX_COLOR", originalLatexColor);
  restoreEnvironment("PSS_LATEX", originalLatexSetting);
  restoreEnvironment("PSS_LATEX_ASPECT", originalLatexAspect);
  restoreEnvironment("PSS_LATEX_SCALE", originalLatexScale);
  restoreEnvironment("PATH", originalPath);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("extractDisplayMath", () => {
  it("extracts dollar and bracket display blocks in order", () => {
    const parts = extractDisplayMath(
      "Before\n\n$$\\sum_{i=1}^n i$$\n\nmiddle\n\n\\[x^2 + y^2\\]\n\nafter"
    );

    expect(parts).toEqual([
      { raw: "Before\n\n", type: "markdown" },
      {
        formula: "\\sum_{i=1}^n i",
        raw: "$$\\sum_{i=1}^n i$$",
        type: "math",
      },
      { raw: "\n\nmiddle\n\n", type: "markdown" },
      {
        formula: "x^2 + y^2",
        raw: "\\[x^2 + y^2\\]",
        type: "math",
      },
      { raw: "\n\nafter", type: "markdown" },
    ]);
  });

  it("does not interpret math delimiters in Markdown code", () => {
    const markdown = [
      "`$$inline$$`",
      "",
      "```tex",
      "$$fenced$$",
      "```",
      "",
      "    $$indented$$",
    ].join("\n");

    expect(extractDisplayMath(markdown)).toEqual([
      { raw: markdown, type: "markdown" },
    ]);
  });

  it("leaves escaped and incomplete delimiters as Markdown", () => {
    const markdown = String.raw`\$\$escaped\$\$ then $$unfinished`;

    expect(extractDisplayMath(markdown)).toEqual([
      { raw: markdown, type: "markdown" },
    ]);
  });

  it("preserves invalid empty math before a later valid block", () => {
    expect(extractDisplayMath("a $$$$ b $$x$$ c")).toEqual([
      { raw: "a $$$$ b ", type: "markdown" },
      { formula: "x", raw: "$$x$$", type: "math" },
      { raw: " c", type: "markdown" },
    ]);
  });
});

describe("highlightInlineMath", () => {
  it("converts compact inline math to highlighted Markdown code spans", () => {
    expect(highlightInlineMath("For $n > 2$, use $x^n + y^n$.")).toBe(
      "For `n > 2`, use `x^n + y^n`."
    );
  });

  it("leaves display math, escaped dollars, prices, and code untouched", () => {
    const markdown = [
      String.raw`Price: \$10`,
      "`$code$`",
      "$$",
      "x^2 + y^2 = z^2",
      "$$",
    ].join("\n");

    expect(highlightInlineMath(markdown)).toBe(markdown);
  });
});

describe("render appearance", () => {
  it("uses a default glyph color with readable light and dark contrast", () => {
    delete process.env.PSS_LATEX_COLOR;

    const luminance = relativeLuminance(latexColor());

    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect((luminance + 0.05) / 0.05).toBeGreaterThanOrEqual(4.5);
  });

  it("forces a transparent canvas before reading an SVG", () => {
    const args = postProcessPngArgs("formula.svg", "formula.png");
    const inputIndex = args.indexOf("formula.svg");
    const backgroundIndex = args.indexOf("-background");

    expect(backgroundIndex).toBeGreaterThanOrEqual(0);
    expect(backgroundIndex).toBeLessThan(inputIndex);
    expect(args[backgroundIndex + 1]).toBe("none");
  });
});

describe("normalizeLatexFormula", () => {
  it("repairs single row terminators emitted by models", () => {
    const formula = [
      String.raw`\begin{cases}`,
      "x + y = 1 \\",
      "x - y = 0 \\",
      String.raw`\end{cases}`,
    ].join("\n");

    expect(normalizeLatexFormula(formula)).toBe(
      [
        String.raw`\begin{cases}`,
        "x + y = 1 \\\\",
        "x - y = 0 \\\\",
        String.raw`\end{cases}`,
      ].join("\n")
    );
  });

  it("preserves already-correct double row terminators", () => {
    const formula = ["a & b \\\\", "c & d"].join("\n");

    expect(normalizeLatexFormula(formula)).toBe(formula);
  });
});

describe("LatexMarkdown", () => {
  it.runIf(canRenderUnicode)(
    "renders CJK text embedded in display math",
    async () => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
      temporaryDirectories.push(cacheRoot);
      process.env.PSS_LATEX_CACHE_DIR = cacheRoot;
      process.env.PSS_LATEX = "1";
      setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
      const formula = String.raw`\text{반례 존재} \implies \text{弗赖 곡선 생성}`;
      let resolveRender: (() => void) | undefined;
      const rendered = new Promise<void>((resolve) => {
        resolveRender = resolve;
      });
      const view = new LatexMarkdown(
        `$$\n${formula}\n$$`,
        1,
        0,
        markdownTheme,
        {
          requestRender: () => resolveRender?.(),
        }
      );

      view.render(100);
      await rendered;

      const output = view.render(100).join("\n");
      expect(output).toContain("\x1b_Ga=T");
      expect(output).not.toContain(`$$\n${formula}\n$$`);
      const payloads = output
        .split("\x1b_G")
        .slice(1)
        .map((command) => {
          const separator = command.indexOf(";");
          const terminator = command.indexOf("\x1b\\");
          return command.slice(separator + 1, terminator);
        });
      const png = Buffer.from(payloads.join(""), "base64");
      expect(png.readUInt32BE(16)).toBeGreaterThan(500);
      expect(png.readUInt32BE(20)).toBeGreaterThan(20);
    }
  );

  it("refuses native TeX when the OS sandbox is unavailable", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
    const binaryRoot = await mkdtemp(join(tmpdir(), "pss-latex-bin-"));
    temporaryDirectories.push(cacheRoot, binaryRoot);
    process.env.PATH = binaryRoot;
    process.env.PSS_LATEX_CACHE_DIR = cacheRoot;
    process.env.PSS_LATEX = "1";
    await writeFile(join(binaryRoot, "latex"), "#!/bin/sh\nexit 99\n", {
      mode: 0o755,
    });
    setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
    let missingTool: string | undefined;
    let resolveRender: (() => void) | undefined;
    const rendered = new Promise<void>((resolve) => {
      resolveRender = resolve;
    });
    const formula = "x = 404";
    const view = new LatexMarkdown(`$$\n${formula}\n$$`, 1, 0, markdownTheme, {
      onMissingTool: (executable) => {
        missingTool = executable;
      },
      requestRender: () => resolveRender?.(),
    });

    view.render(80);
    await rendered;

    expect(missingTool).toBe("bwrap");
    expect(view.render(80).join("\n")).toContain(formula);
  });

  it.runIf(process.platform === "linux")(
    "refuses native TeX when the resource limiter is unavailable",
    async () => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
      const binaryRoot = await mkdtemp(join(tmpdir(), "pss-latex-bin-"));
      temporaryDirectories.push(cacheRoot, binaryRoot);
      process.env.PATH = binaryRoot;
      process.env.PSS_LATEX_CACHE_DIR = cacheRoot;
      process.env.PSS_LATEX = "1";
      await Promise.all([
        writeFile(join(binaryRoot, "latex"), "#!/bin/sh\nexit 99\n", {
          mode: 0o755,
        }),
        writeFile(join(binaryRoot, "bwrap"), "#!/bin/sh\nexit 99\n", {
          mode: 0o755,
        }),
      ]);
      setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
      let missingTool: string | undefined;
      let resolveRender: (() => void) | undefined;
      const rendered = new Promise<void>((resolve) => {
        resolveRender = resolve;
      });
      const view = new LatexMarkdown("$$\nx = 405\n$$", 1, 0, markdownTheme, {
        onMissingTool: (executable) => {
          missingTool = executable;
        },
        requestRender: () => resolveRender?.(),
      });

      view.render(80);
      await rendered;

      expect(missingTool).toBe("prlimit");
    }
  );

  it("upgrades a cached display block asynchronously without invoking TeX", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
    temporaryDirectories.push(cacheRoot);
    process.env.PSS_LATEX_CACHE_DIR = cacheRoot;
    process.env.PSS_LATEX_COLOR = "#e8e8e8";
    process.env.PSS_LATEX = "1";
    setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
    const formula = "x^2 + y^2 = z^2";
    const key = createHash("sha256")
      .update("latex-dvi-dvipng-lcd-v7")
      .update("\0")
      .update("#e8e8e8")
      .update("\0")
      .update(formula)
      .digest("hex");
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(
      join(cacheRoot, `${key}.png`),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      )
    );
    let resolveRender: (() => void) | undefined;
    const rendered = new Promise<void>((resolve) => {
      resolveRender = resolve;
    });
    const view = new LatexMarkdown(
      `before\n\n$$${formula}$$\n\nafter`,
      1,
      0,
      markdownTheme,
      {
        requestRender: () => resolveRender?.(),
      }
    );

    expect(view.render(80).join("\n")).toContain(`$$${formula}$$`);
    await rendered;

    const outputLines = view.render(80);
    const output = outputLines.join("\n");
    const imageLine = outputLines.findIndex((line) =>
      line.includes("\x1b_Ga=T")
    );
    expect(output).toContain("\x1b_Ga=T,f=100,q=2,C=1");
    expect(output).not.toContain("\u{10eeee}");
    expect(output).not.toContain(`$$${formula}$$`);
    expect(outputLines[imageLine - 1]?.trim()).toBe("");
    expect(outputLines[imageLine + 1]?.trim()).toBe("");
  });
});

describe("kittyPlaceholderLines", () => {
  it("does not expose Kitty Unicode placeholder code points", () => {
    setCellDimensions({ heightPx: 18, widthPx: 9 });

    const lines = kittyPlaceholderLines(
      {
        base64: Buffer.from("png bytes").toString("base64"),
        heightPx: 36,
        imageId: 0x12_34_56,
        widthPx: 36,
      },
      20,
      1
    );

    expect(lines.join("")).not.toContain("\u{10eeee}");
  });

  it("transmits a direct image and reserves its terminal rows", () => {
    setCellDimensions({ heightPx: 18, widthPx: 9 });

    const lines = kittyPlaceholderLines(
      {
        base64: Buffer.from("png bytes").toString("base64"),
        heightPx: 36,
        imageId: 0x12_34_56,
        widthPx: 36,
      },
      20,
      1
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=2,i=1193046;");
    expect(lines[0]).not.toContain("\u{10eeee}");
    expect(lines[1]).toBe("");
    expect(visibleWidth(lines[0] ?? "")).toBe(1);
    expect(visibleWidth(lines[1] ?? "")).toBe(0);
  });

  it("matches the placeholder grid to the PNG aspect ratio", () => {
    setCellDimensions({ heightPx: 18, widthPx: 9 });

    const lines = kittyPlaceholderLines(
      {
        base64: "eA==",
        displayHeightPx: 48,
        displayWidthPx: 107,
        heightPx: 114,
        imageId: 9,
        widthPx: 255,
      },
      80,
      1
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("c=13,r=3");
  });

  it("uses logical display dimensions while retaining a high-resolution PNG", () => {
    setCellDimensions({ heightPx: 18, widthPx: 9 });

    const lines = kittyPlaceholderLines(
      {
        base64: "eA==",
        displayHeightPx: 36,
        displayWidthPx: 36,
        heightPx: 360,
        imageId: 8,
        widthPx: 360,
      },
      20,
      1
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("c=4,r=2");
  });

  it("scales wide images to the available terminal columns", () => {
    setCellDimensions({ heightPx: 20, widthPx: 10 });

    const lines = kittyPlaceholderLines(
      {
        base64: "eA==",
        heightPx: 100,
        imageId: 7,
        widthPx: 1000,
      },
      12,
      1
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("c=10,r=1");
    expect(visibleWidth(lines[0] ?? "")).toBe(1);
  });
});
