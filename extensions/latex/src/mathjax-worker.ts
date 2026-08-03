import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parentPort } from "node:worker_threads";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { CjkLocale } from "./mathjax-renderer";

interface MathJaxAdaptor {
  serializeXML(node: unknown): string;
  tags(node: unknown, name: string): readonly unknown[];
}
interface MathJaxRuntime {
  readonly startup: { readonly adaptor: MathJaxAdaptor };
  tex2svgPromise(
    formula: string,
    options: { readonly display: boolean }
  ): Promise<unknown>;
}
interface MathJaxModule {
  init(options: Record<string, unknown>): Promise<MathJaxRuntime>;
}
interface RenderRequest {
  readonly color: string;
  readonly formula: string;
  readonly id: number;
  readonly locale: CjkLocale;
}

const require = createRequire(import.meta.url);
const MathJax = require("mathjax") as MathJaxModule;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;
const FONT_SIZE = 48;
const PADDING = 10;
const UNSAFE_SVG_PATTERN = /<(?:image|foreignObject|script|style)\b/i;
const EXTERNAL_REFERENCE_PATTERN =
  /(?:href\s*=\s*["'](?!#)|url\(\s*["']?(?!#))/i;
const MERROR_PATTERN = /data-(?:mjx-error|mml-node=["']merror)/i;
const NON_ASCII_PATTERN = /[^\p{ASCII}]/u;
const VIEW_BOX_CAPTURE_PATTERN = /\bviewBox="([^"]+)"/u;
const VIEW_BOX_PATTERN = /\bviewBox="[^"]+"/u;
const WIDTH_PATTERN = /\bwidth="[^"]+"/u;
const HEIGHT_PATTERN = /\bheight="[^"]+"/u;
const WHITESPACE_PATTERN = /\s+/u;
const SCRIPT_PACKAGES = [
  ["@fontsource-variable/noto-sans-arabic", /\p{Script=Arabic}/u],
  ["@fontsource-variable/noto-sans-hebrew", /\p{Script=Hebrew}/u],
  ["@fontsource-variable/noto-sans-devanagari", /\p{Script=Devanagari}/u],
  ["@fontsource-variable/noto-sans-thai", /\p{Script=Thai}/u],
] as const;
const CJK_PACKAGES: Record<CjkLocale, string> = {
  ja: "@fontsource-variable/noto-sans-jp",
  ko: "@fontsource-variable/noto-sans-kr",
  "zh-Hans": "@fontsource-variable/noto-sans-sc",
  "zh-Hant": "@fontsource-variable/noto-sans-tc",
};
const HANGUL_PATTERN = /\p{Script=Hangul}/u;
const KANA_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_PATTERN = /\p{Script=Han}/u;
const fontCache = new Map<string, Promise<Uint8Array[]>>();

const [mathjax] = await Promise.all([
  MathJax.init({
    loader: {
      load: [
        "input/tex-base",
        "[tex]/ams",
        "[tex]/newcommand",
        "[tex]/textmacros",
        "output/svg",
      ],
    },
    svg: { fontCache: "local" },
    tex: {
      maxBuffer: 16 * 1024,
      maxMacros: 256,
      maxTemplateSubtitutions: 1000,
      packages: ["base", "ams", "newcommand", "textmacros"],
    },
  }),
  readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")).then((bytes) =>
    initWasm(bytes)
  ),
]);

const readFonts = (packageName: string): Promise<Uint8Array[]> => {
  const cached = fontCache.get(packageName);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    const root = join(
      dirname(require.resolve(`${packageName}/package.json`)),
      "files"
    );
    const names = (await readdir(root)).filter((name) =>
      name.endsWith("-wght-normal.woff2")
    );
    const output: Uint8Array[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, names.length) }, async () => {
        while (cursor < names.length) {
          const name = names[cursor++];
          if (name) {
            output.push(new Uint8Array(await readFile(join(root, name))));
          }
        }
      })
    );
    return output;
  })();
  fontCache.set(packageName, promise);
  promise.catch(() => fontCache.delete(packageName));
  return promise;
};

const fontsFor = async (
  formula: string,
  locale: CjkLocale
): Promise<Uint8Array[]> => {
  const packages = new Set<string>();
  if (NON_ASCII_PATTERN.test(formula)) {
    packages.add("@fontsource-variable/noto-sans");
  }
  for (const [name, pattern] of SCRIPT_PACKAGES) {
    if (pattern.test(formula)) {
      packages.add(name);
    }
  }
  if (HAN_PATTERN.test(formula)) {
    packages.add(CJK_PACKAGES[locale]);
  }
  if (HANGUL_PATTERN.test(formula)) {
    packages.add(CJK_PACKAGES.ko);
  }
  if (KANA_PATTERN.test(formula)) {
    packages.add(CJK_PACKAGES.ja);
  }
  return (await Promise.all([...packages].map(readFonts))).flat();
};

const prepareSvg = (svg: string, color: string): string => {
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES || MERROR_PATTERN.test(svg)) {
    throw new Error("MathJax rejected the formula");
  }
  if (UNSAFE_SVG_PATTERN.test(svg) || EXTERNAL_REFERENCE_PATTERN.test(svg)) {
    throw new Error("MathJax produced unsafe SVG");
  }
  const values = VIEW_BOX_CAPTURE_PATTERN.exec(svg)?.[1]
    ?.trim()
    .split(WHITESPACE_PATTERN)
    .map(Number);
  if (values?.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("MathJax produced an invalid SVG");
  }
  const [x = 0, y = 0, width = 0, height = 0] = values;
  const widthPx = Math.ceil((width / 1000) * FONT_SIZE) + 2 * PADDING;
  const heightPx = Math.ceil((height / 1000) * FONT_SIZE) + 2 * PADDING;
  if (
    !(width > 0 && height > 0) ||
    widthPx > MAX_DIMENSION ||
    heightPx > MAX_DIMENSION ||
    widthPx * heightPx > MAX_PIXELS
  ) {
    throw new Error("MathJax SVG dimensions exceed limits");
  }
  const padding = (PADDING / FONT_SIZE) * 1000;
  return svg
    .replace(WIDTH_PATTERN, `width="${widthPx}"`)
    .replace(HEIGHT_PATTERN, `height="${heightPx}"`)
    .replace(
      VIEW_BOX_PATTERN,
      `viewBox="${x - padding} ${y - padding} ${width + 2 * padding} ${height + 2 * padding}"`
    )
    .replace("<svg ", `<svg color="${color}" `);
};

const render = async ({
  formula,
  color,
  locale,
}: RenderRequest): Promise<Uint8Array> => {
  const container = await mathjax.tex2svgPromise(formula, { display: true });
  const node = mathjax.startup.adaptor.tags(container, "svg")[0];
  if (!node) {
    throw new Error("MathJax did not produce SVG output");
  }
  const svg = prepareSvg(mathjax.startup.adaptor.serializeXML(node), color);
  const fonts = await fontsFor(formula, locale);
  const renderer = new Resvg(svg, {
    font: {
      fontBuffers: fonts,
      defaultFontFamily: "Noto Sans",
      sansSerifFamily: "Noto Sans",
      serifFamily: "Noto Sans",
    },
  });
  try {
    const image = renderer.render();
    try {
      const png = image.asPng();
      if (png.byteLength > MAX_PNG_BYTES) {
        throw new Error("Renderer produced an oversized PNG");
      }
      return png;
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
};

if (!parentPort) {
  throw new Error("MathJax worker requires a parent port");
}
const port = parentPort;
port.on("message", (request: RenderRequest) => {
  render(request).then(
    (png) => port.postMessage({ id: request.id, png }),
    (error: unknown) =>
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
  );
});
