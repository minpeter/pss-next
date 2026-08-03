import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCapabilities,
  getCellDimensions,
  type MarkdownTheme,
  setCapabilities,
  setCellDimensions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractDisplayMath,
  highlightInlineMath,
  kittyPlaceholderLines,
  LatexMarkdown,
  normalizeLatexFormula,
} from "./latex-markdown";

const originalCapabilities = getCapabilities();
const originalCells = getCellDimensions();
const originalPath = process.env.PATH;
const originalCache = process.env.PSS_LATEX_CACHE_DIR;
const originalLatexSetting = process.env.PSS_LATEX;
const temporaryDirectories: string[] = [];
const theme: MarkdownTheme = Object.fromEntries(
  [
    "bold",
    "code",
    "codeBlock",
    "codeBlockBorder",
    "heading",
    "hr",
    "italic",
    "link",
    "linkUrl",
    "listBullet",
    "quote",
    "quoteBorder",
    "strikethrough",
    "underline",
  ].map((key) => [key, (text: string) => text])
) as unknown as MarkdownTheme;

afterEach(async () => {
  setCapabilities(originalCapabilities);
  setCellDimensions(originalCells);
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalCache === undefined) {
    delete process.env.PSS_LATEX_CACHE_DIR;
  } else {
    process.env.PSS_LATEX_CACHE_DIR = originalCache;
  }
  if (originalLatexSetting === undefined) {
    delete process.env.PSS_LATEX;
  } else {
    process.env.PSS_LATEX = originalLatexSetting;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const renderFormula = async (
  formula: string,
  cache: string
): Promise<string[]> => {
  process.env.PSS_LATEX_CACHE_DIR = cache;
  process.env.PSS_LATEX = "1";
  setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
  setCellDimensions({ heightPx: 18, widthPx: 9 });
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const view = new LatexMarkdown(
    `before\n\n$$\n${formula}\n$$\n\nafter`,
    1,
    0,
    theme,
    { requestRender: resolve }
  );
  view.render(100);
  await ready;
  const lines = view.render(100);
  view.dispose();
  return lines;
};

describe("Markdown math parsing", () => {
  it("preserves parsing and inline highlighting behavior", () => {
    expect(extractDisplayMath("a $$x$$ b \\[y\\] c")).toEqual([
      { raw: "a ", type: "markdown" },
      { formula: "x", raw: "$$x$$", type: "math" },
      { raw: " b ", type: "markdown" },
      { formula: "y", raw: "\\[y\\]", type: "math" },
      { raw: " c", type: "markdown" },
    ]);
    expect(extractDisplayMath("`$$x$$`\n```tex\n$$y$$\n```")).toHaveLength(1);
    expect(highlightInlineMath("For $x$, use `$y$`.")).toBe(
      "For `x`, use `$y$`."
    );
  });

  it("repairs a single row terminator", () => {
    expect(normalizeLatexFormula("a & b \\\nc & d")).toBe("a & b \\\\\nc & d");
  });
});

describe("LatexMarkdown WASM rendering", () => {
  it("renders and caches with an empty PATH, then emits Kitty output", async () => {
    const cache = await mkdtemp(join(tmpdir(), "pss-latex-wasm-"));
    temporaryDirectories.push(cache);
    process.env.PATH = "";
    const first = await renderFormula("x^2+y^2=z^2", cache);
    const entries = await readdir(cache);
    expect(entries).toHaveLength(1);
    expect(first.join("\n")).toContain("\x1b_Ga=T,f=100,q=2,C=1");
    const second = await renderFormula("x^2+y^2=z^2", cache);
    expect(await readdir(cache)).toEqual(entries);
    expect(second.join("\n")).toContain("\x1b_Ga=T");
  }, 30_000);

  it.each([
    String.raw`\text{broken`,
    String.raw`\text{proof ✅}`,
    String.raw`\href{x}{y}`,
  ])("keeps unsupported formula source as fallback: %s", async (formula) => {
    const cache = await mkdtemp(join(tmpdir(), "pss-latex-fallback-"));
    temporaryDirectories.push(cache);
    const output = (await renderFormula(formula, cache)).join("\n");
    expect(output).toContain(formula);
    expect(output).not.toContain("\x1b_Ga=T");
  });
});

describe("Kitty layout", () => {
  it("transmits directly and reserves rows", () => {
    setCellDimensions({ heightPx: 18, widthPx: 9 });
    const lines = kittyPlaceholderLines(
      { base64: "eA==", heightPx: 36, imageId: 7, widthPx: 36 },
      20,
      1
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("c=4,r=2,i=7;");
    expect(visibleWidth(lines[0] ?? "")).toBe(1);
    expect(lines[1]).toBe("");
  });
});
