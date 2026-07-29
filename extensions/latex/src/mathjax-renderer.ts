import MathJax from "mathjax";

const SVG_OPEN = "<svg";
const SVG_CLOSE = "</svg>";
const SVG_EX_DIMENSION_PATTERN = /\b(width|height)="([0-9.]+)ex"/g;
const SVG_PIXELS_PER_EX = 32;
const SVG_SERIF_FONT = 'font-family="serif"';
const SVG_CJK_FONT =
  'font-family="Noto Sans CJK KR, Noto Sans CJK JP, NanumGothic, sans-serif"';

let runtime: ReturnType<typeof MathJax.init> | undefined;

const mathJaxRuntime = (): ReturnType<typeof MathJax.init> => {
  runtime ??= MathJax.init({
    loader: { load: ["input/tex", "output/svg"] },
    svg: { fontCache: "none" },
  });
  return runtime;
};

export const renderMathJaxSvg = async (
  formula: string,
  color: string
): Promise<string> => {
  const mathJax = await mathJaxRuntime();
  const node = await mathJax.tex2svgPromise(formula, { display: true });
  const serialized = mathJax.startup.adaptor.serializeXML(node);
  const start = serialized.indexOf(SVG_OPEN);
  const end = serialized.lastIndexOf(SVG_CLOSE);
  if (start === -1 || end === -1) {
    throw new Error("MathJax did not produce an SVG");
  }
  const svg = serialized.slice(start, end + SVG_CLOSE.length);
  return svg
    .replace(
      SVG_EX_DIMENSION_PATTERN,
      (_match, dimension: string, value: string) =>
        `${dimension}="${Math.ceil(Number(value) * SVG_PIXELS_PER_EX)}px"`
    )
    .replaceAll("currentColor", color)
    .replaceAll(SVG_SERIF_FONT, SVG_CJK_FONT);
};
