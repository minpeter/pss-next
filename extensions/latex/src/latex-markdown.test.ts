import { spawnSync } from "node:child_process";
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
import { encode } from "fast-png";
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
const KITTY_COLUMNS_PATTERN = /(?:^|,)c=([0-9]+)/;
const KITTY_ROWS_PATTERN = /(?:^|,)r=([0-9]+)/;
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
const containsNonAscii = (value: string): boolean =>
  Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
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
const fakePng = (width: number, height: number): Buffer => {
  const data = new Uint8Array(width * height * 4);
  data[0] = 118;
  data[1] = 118;
  data[2] = 118;
  data[3] = 255;
  return Buffer.from(encode({ channels: 4, data, depth: 8, height, width }));
};
const cacheFormulaPng = async (
  cacheRoot: string,
  formula: string,
  width: number,
  height: number
): Promise<void> => {
  const key = createHash("sha256")
    .update("latex-dvi-dvipng-lcd-v10")
    .update("\0")
    .update("#e8e8e8")
    .update("\0")
    .update(containsNonAscii(formula) ? "zh-Hans" : "ascii")
    .update("\0")
    .update(formula)
    .digest("hex");
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(join(cacheRoot, `${key}.png`), fakePng(width, height));
};
const kittyGrid = (
  lines: readonly string[]
): { columns: number; imageLine: number; rows: number } => {
  const imageLine = lines.findIndex((line) => line.includes("\x1b_Ga=T"));
  const header = lines[imageLine]?.split("\x1b_G")[1]?.split(";")[0] ?? "";
  return {
    columns: Number(header.match(KITTY_COLUMNS_PATTERN)?.[1] ?? 0),
    imageLine,
    rows: Number(header.match(KITTY_ROWS_PATTERN)?.[1] ?? 0),
  };
};
const kittyPng = (lines: readonly string[]): Buffer => {
  const line = lines.find((candidate) => candidate.includes("\x1b_Ga=T")) ?? "";
  const payload = line
    .split("\x1b_G")
    .slice(1)
    .map((command) =>
      command.slice(command.indexOf(";") + 1, command.indexOf("\x1b\\"))
    )
    .join("");
  return Buffer.from(payload, "base64");
};
const visiblePngBounds = (
  png: Buffer
): { height: number; width: number } | undefined => {
  const result = spawnSync(
    "magick",
    ["png:-", "-trim", "-format", "%w %h", "info:"],
    { input: png }
  );
  if (result.status !== 0) {
    return;
  }
  const [width, height] = result.stdout
    .toString("utf8")
    .trim()
    .split(" ")
    .map(Number);
  if (!(width && height)) {
    return;
  }
  return { height, width };
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
const renderCachedDisplay = async (
  cacheRoot: string,
  formula: string,
  width: number,
  height: number,
  markdown = `before\n\n$$${formula}$$\n\nafter`
): Promise<string[]> => {
  process.env.PSS_LATEX_CACHE_DIR = cacheRoot;
  process.env.PSS_LATEX_COLOR = "#e8e8e8";
  process.env.PSS_LATEX = "1";
  setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
  setCellDimensions({ heightPx: 18, widthPx: 9 });
  await cacheFormulaPng(cacheRoot, formula, width, height);
  let resolveRender: (() => void) | undefined;
  const rendered = new Promise<void>((resolve) => {
    resolveRender = resolve;
  });
  const view = new LatexMarkdown(markdown, 1, 0, markdownTheme, {
    requestRender: () => resolveRender?.(),
  });

  view.render(80);
  await rendered;

  const lines = view.render(80);
  view.dispose();
  return lines;
};
const renderLiveDisplay = async (
  cacheRoot: string,
  formula: string
): Promise<string[]> => {
  process.env.PSS_LATEX_CACHE_DIR = cacheRoot;
  process.env.PSS_LATEX_COLOR = "#767676";
  process.env.PSS_LATEX = "1";
  setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
  setCellDimensions({ heightPx: 18, widthPx: 9 });
  let resolveRender: (() => void) | undefined;
  const rendered = new Promise<void>((resolve) => {
    resolveRender = resolve;
  });
  const view = new LatexMarkdown(`$$\n${formula}\n$$`, 1, 0, markdownTheme, {
    requestRender: () => resolveRender?.(),
  });

  view.render(100);
  await rendered;

  const lines = view.render(100);
  view.dispose();
  return lines;
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
  it("derives formula color from terminal theme foreground", () => {
    delete process.env.PSS_LATEX_COLOR;

    expect(latexColor("#e6edf3")).toBe("#e6edf3");

    process.env.PSS_LATEX_COLOR = "#123456";
    expect(latexColor("#e6edf3")).toBe("#123456");
  });

  it("meets contrast on common light and dark themes", () => {
    delete process.env.PSS_LATEX_COLOR;
    const themes = [
      { backgrounds: ["#ffffff", "#f5f5f5"], foreground: "#202020" },
      {
        backgrounds: ["#0d1117", "#1e1e1e", "#282a36"],
        foreground: "#e6edf3",
      },
    ] as const;

    for (const theme of themes) {
      const foreground = latexColor(theme.foreground);
      const foregroundLuminance = relativeLuminance(foreground);
      for (const background of theme.backgrounds) {
        const backgroundLuminance = relativeLuminance(background);
        const ratio =
          (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
          (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
        expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(
          4.5
        );
      }
    }
  });

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
  it("keeps cached one-line native display math compact", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
    temporaryDirectories.push(cacheRoot);
    const formula = String.raw`\text{abc}`;
    const lines = await renderCachedDisplay(cacheRoot, formula, 89, 45);

    expect(kittyGrid(lines)).toMatchObject({
      columns: 4,
      rows: 1,
    });
  });

  it("normalizes one-line Unicode size to the native grid", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
    temporaryDirectories.push(cacheRoot);
    const native = await renderCachedDisplay(
      cacheRoot,
      String.raw`\text{abc}`,
      89,
      45
    );
    const unicode = await renderCachedDisplay(
      cacheRoot,
      String.raw`\text{한글}`,
      136,
      70
    );

    expect(kittyGrid(unicode)).toMatchObject(kittyGrid(native));
  });

  it("keeps a real margin after multi-row images", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
    temporaryDirectories.push(cacheRoot);
    const lines = await renderCachedDisplay(
      cacheRoot,
      String.raw`\frac{\text{한글}}{x}`,
      180,
      161
    );
    const grid = kittyGrid(lines);

    expect(grid.rows).toBeGreaterThan(1);
    expect(lines[grid.imageLine + grid.rows]?.trim()).toBe("");
  });

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
      expect(png.readUInt32BE(16)).toBeGreaterThan(100);
      expect(png.readUInt32BE(20)).toBeGreaterThan(20);
    }
  );

  it.runIf(canRenderUnicode)(
    "renders multilingual text without blank or missing glyph output",
    { timeout: 30_000 },
    async () => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
      temporaryDirectories.push(cacheRoot);
      const cases = [
        ["korean", String.raw`\text{타원곡선}`, 100],
        ["japanese", String.raw`\text{楕円曲線かな}`, 180],
        ["simplified", String.raw`\text{椭圆曲线}`, 120],
        ["traditional", String.raw`\text{橢圓曲線}`, 120],
        ["accented-latin", String.raw`\text{résumé}`, 120],
        ["cyrillic", String.raw`\text{контрпример}`, 180],
        ["greek", String.raw`\text{παράδειγμα}`, 160],
        ["arabic", String.raw`\text{مرحبا بالعالم}`, 180],
        ["hebrew", String.raw`\text{שלום עולם}`, 140],
        ["devanagari", String.raw`\text{नमस्ते दुनिया}`, 180],
        ["thai", String.raw`\text{สวัสดีชาวโลก}`, 180],
        ["combining", String.raw`\text{é ä ñ}`, 100],
      ] as const;

      for (const [name, formula, minimumWidth] of cases) {
        const lines = await renderLiveDisplay(cacheRoot, formula);
        const bounds = visiblePngBounds(kittyPng(lines));
        expect(bounds, name).toBeDefined();
        expect(bounds?.width, name).toBeGreaterThanOrEqual(minimumWidth);
      }
    }
  );

  it.runIf(canRenderUnicode)(
    "renders multilingual text without silently dropping emoji",
    async () => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "pss-latex-test-"));
      temporaryDirectories.push(cacheRoot);
      const formula = String.raw`\text{proof ✅}`;
      const lines = await renderLiveDisplay(cacheRoot, formula);
      const output = lines.join("\n");

      expect(output).toContain(formula);
      expect(output).not.toContain("\x1b_Ga=T");
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
