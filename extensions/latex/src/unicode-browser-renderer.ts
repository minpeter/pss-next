import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { renderMathJaxChtml } from "./mathjax-renderer";

const require = createRequire(import.meta.url);
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_PATTERN = /\p{Regional_Indicator}/u;
const UNSAFE_TEX_MACRO_PATTERN =
  /\\(?:class|cssId|href|htmlClass|htmlId|htmlStyle|style)\b/u;
const RTL_PATTERN = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const KOREAN_LANGUAGE_PATTERN = /^ko/i;
const JAPANESE_LANGUAGE_PATTERN = /^ja/i;
const TRADITIONAL_CHINESE_LANGUAGE_PATTERN = /^zh[_-](?:TW|HK|MO)|Hant/i;
const SCRIPT_PATTERNS = {
  devanagari: "\\p{Script=Devanagari}",
  han: "\\p{Script=Han}",
  hangul: "\\p{Script=Hangul}",
  japanese: "[\\p{Script=Hiragana}\\p{Script=Katakana}]",
  thai: "\\p{Script=Thai}",
} as const;
const CJK_LOCALES = ["ko", "ja", "zh-Hans", "zh-Hant"] as const;
const MAX_BROWSER_DIMENSION = 8192;
const MAX_BROWSER_PIXELS = 16 * 1024 * 1024;
const BROWSER_SCREENSHOT_TIMEOUT_MS = 10_000;
const KEYCAP_COMBINER = 0x20_e3;
const ZERO_WIDTH_JOINER = 0x20_0d;
const EMOJI_VARIATION_SELECTOR = 0xfe_0f;
const TAG_CHARACTER_START = 0xe_00_20;
const TAG_CHARACTER_END = 0xe_00_7f;

type CjkLocale = (typeof CJK_LOCALES)[number];

interface BrowserProbe {
  readonly containerHeight: number;
  readonly containerWidth: number;
  readonly fontsReady: boolean;
  readonly runs: readonly {
    readonly clusterLefts: readonly number[];
    readonly direction: "ltr" | "rtl";
    readonly fontAvailable: boolean;
    readonly font: string;
    readonly text: string;
    readonly visible: boolean;
    readonly width: number;
  }[];
}

export interface UnicodeBrowserRender {
  readonly png: Buffer;
  readonly probe: BrowserProbe;
}

export class UnicodeRenderUnsupportedError extends Error {
  override readonly name = "UnicodeRenderUnsupportedError";
}

export const unicodeFormulaSupported = (formula: string): boolean =>
  !(
    EMOJI_PATTERN.test(formula) ||
    REGIONAL_INDICATOR_PATTERN.test(formula) ||
    UNSAFE_TEX_MACRO_PATTERN.test(formula) ||
    Array.from(formula).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === KEYCAP_COMBINER ||
        codePoint === ZERO_WIDTH_JOINER ||
        codePoint === EMOJI_VARIATION_SELECTOR ||
        (codePoint >= TAG_CHARACTER_START && codePoint <= TAG_CHARACTER_END)
      );
    })
  );

export const unicodeBrowserLaunchOptions = (
  executablePath: string
): NonNullable<Parameters<typeof chromium.launch>[0]> => ({
  args: ["--disable-breakpad", "--disable-crash-reporter"],
  chromiumSandbox: true,
  executablePath,
  headless: true,
});

export const browserGeometryWithinLimits = (
  width: number,
  height: number
): boolean =>
  Number.isFinite(width) &&
  Number.isFinite(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_BROWSER_DIMENSION &&
  height <= MAX_BROWSER_DIMENSION &&
  width * height <= MAX_BROWSER_PIXELS;

const browserExecutable = async (): Promise<string> => {
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const executable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false
    );
    if (executable) {
      return candidate;
    }
  }
  throw new UnicodeRenderUnsupportedError("Unicode browser is unavailable");
};

export const resolveCjkLocale = (): CjkLocale => {
  const configured = process.env.PSS_LATEX_CJK_LOCALE;
  if (CJK_LOCALES.includes(configured as CjkLocale)) {
    return configured as CjkLocale;
  }
  const language = process.env.LC_ALL ?? process.env.LANG ?? "";
  if (KOREAN_LANGUAGE_PATTERN.test(language)) {
    return "ko";
  }
  if (JAPANESE_LANGUAGE_PATTERN.test(language)) {
    return "ja";
  }
  if (TRADITIONAL_CHINESE_LANGUAGE_PATTERN.test(language)) {
    return "zh-Hant";
  }
  return "zh-Hans";
};

const mathFontRoot = (): string => {
  const mathJaxPackage = require.resolve("mathjax/package.json");
  return resolve(
    dirname(mathJaxPackage),
    "../@mathjax/mathjax-newcm-font/chtml/woff2"
  );
};

const assertBrowserProbe = (probe: BrowserProbe): void => {
  if (
    !browserGeometryWithinLimits(probe.containerWidth, probe.containerHeight)
  ) {
    throw new UnicodeRenderUnsupportedError(
      "Unicode browser geometry exceeds limits"
    );
  }
  if (
    !probe.fontsReady ||
    probe.runs.some((run) => !(run.fontAvailable && run.visible))
  ) {
    throw new UnicodeRenderUnsupportedError(
      "Unicode browser text probe failed"
    );
  }
  for (const run of probe.runs) {
    if (!RTL_PATTERN.test(run.text)) {
      continue;
    }
    const first = run.clusterLefts[0];
    const last = run.clusterLefts.at(-1);
    if (
      run.direction !== "rtl" ||
      first === undefined ||
      last === undefined ||
      first <= last
    ) {
      throw new UnicodeRenderUnsupportedError("RTL text order probe failed");
    }
  }
};

export const renderUnicodeFormula = async (
  formula: string,
  color: string,
  signal?: AbortSignal
): Promise<UnicodeBrowserRender> => {
  if (!unicodeFormulaSupported(formula)) {
    throw new UnicodeRenderUnsupportedError(
      "Emoji formulas use source fallback"
    );
  }
  signal?.throwIfAborted();
  const { css, html } = await renderMathJaxChtml(formula);
  const executablePath = await browserExecutable();
  const browser = await chromium.launch(
    unicodeBrowserLaunchOptions(executablePath)
  );
  const onAbort = (): void => {
    browser.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: 2048, width: 8192 },
    });
    const fontRoot = mathFontRoot();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const filename = url.pathname.split("/").at(-1);
      if (url.hostname !== "mathjax.local" || !filename?.endsWith(".woff2")) {
        await route.abort();
        return;
      }
      await route.fulfill({
        body: await readFile(join(fontRoot, filename)),
        contentType: "font/woff2",
      });
    });
    const browserCss = css.replaceAll(
      "@mathjax/mathjax-newcm-font/chtml/woff2/",
      "http://mathjax.local/"
    );
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>${browserCss}
html,body{margin:0;padding:0;background:transparent;color:${color}}
body{display:inline-block;font-size:48px}
mjx-container{display:inline-block!important;margin:0!important}
mjx-mtext bdi{font-style:normal;font-weight:400;white-space:pre}
</style><body>${html}</body>`
    );
    const probe = await page.evaluate(
      async ({ locale, patterns }) => {
        const devanagariPattern = new RegExp(patterns.devanagari, "u");
        const hanPattern = new RegExp(patterns.han, "u");
        const hangulPattern = new RegExp(patterns.hangul, "u");
        const japanesePattern = new RegExp(patterns.japanese, "u");
        const thaiPattern = new RegExp(patterns.thai, "u");
        const selectFont = (text: string): string => {
          if (hangulPattern.test(text)) {
            return "Noto Sans CJK KR";
          }
          if (japanesePattern.test(text)) {
            return "Noto Sans CJK JP";
          }
          if (hanPattern.test(text)) {
            return {
              ja: "Noto Sans CJK JP",
              ko: "Noto Sans CJK KR",
              "zh-Hans": "Noto Sans CJK SC",
              "zh-Hant": "Noto Sans CJK TC",
            }[locale];
          }
          if (thaiPattern.test(text)) {
            return "Loma";
          }
          if (devanagariPattern.test(text)) {
            return "FreeSans";
          }
          return "DejaVu Sans";
        };
        const runs = Array.from(document.querySelectorAll("mjx-mtext")).flatMap(
          (element) => {
            const text = element.textContent ?? "";
            if (!text.trim()) {
              return [];
            }
            const font = selectFont(text);
            const bdi = document.createElement("bdi");
            bdi.dir = "auto";
            bdi.style.fontFamily = `"${font}"`;
            bdi.textContent = text;
            element.replaceChildren(bdi);
            return [{ bdi, font, text }];
          }
        );
        await document.fonts.ready;
        for (const { bdi } of runs) {
          const runRect = bdi.getBoundingClientRect();
          let ancestor = bdi.parentElement;
          while (ancestor) {
            const ancestorRect = ancestor.getBoundingClientRect();
            if (runRect.right > ancestorRect.right) {
              ancestor.style.minWidth = `${Math.ceil(
                runRect.right - ancestorRect.left
              )}px`;
            }
            if (ancestor.tagName === "MJX-CONTAINER") {
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const container = document.querySelector("mjx-container");
        return {
          containerHeight: container?.getBoundingClientRect().height ?? 0,
          containerWidth: container?.getBoundingClientRect().width ?? 0,
          fontsReady: true,
          runs: runs.map(({ bdi, font, text }) => {
            const rect = bdi.getBoundingClientRect();
            const direction = getComputedStyle(bdi).direction as "ltr" | "rtl";
            const textNode = bdi.firstChild;
            const clusterLefts: number[] = [];
            if (textNode instanceof Text) {
              const segmenter = new Intl.Segmenter(undefined, {
                granularity: "grapheme",
              });
              for (const segment of segmenter.segment(text)) {
                const range = document.createRange();
                range.setStart(textNode, segment.index);
                range.setEnd(textNode, segment.index + segment.segment.length);
                clusterLefts.push(range.getBoundingClientRect().left);
              }
            }
            return {
              clusterLefts,
              direction,
              font,
              fontAvailable: document.fonts.check(`48px "${font}"`, text),
              text,
              visible: rect.width > 0 && rect.height > 0,
              width: rect.width,
            };
          }),
        };
      },
      { locale: resolveCjkLocale(), patterns: SCRIPT_PATTERNS }
    );
    assertBrowserProbe(probe);
    signal?.throwIfAborted();
    const png = await page.locator("mjx-container").screenshot({
      animations: "disabled",
      omitBackground: true,
      timeout: BROWSER_SCREENSHOT_TIMEOUT_MS,
      type: "png",
    });
    return { png, probe };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser.close();
  }
};
