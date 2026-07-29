import { createRequire } from "node:module";

interface MathJaxAdaptor {
  serializeXML(node: unknown): string;
  textContent(node: unknown): string;
}

interface MathJaxRuntime {
  readonly startup: {
    readonly adaptor: MathJaxAdaptor;
    readonly document: unknown;
    readonly output: {
      styleSheet(document: unknown): unknown;
    };
  };
  tex2chtmlPromise(
    formula: string,
    options: { readonly display: boolean }
  ): Promise<unknown>;
}

interface MathJaxModule {
  init(options: {
    readonly loader: { readonly load: readonly string[] };
  }): Promise<MathJaxRuntime>;
}

const require = createRequire(import.meta.url);
const MathJax = require("mathjax") as MathJaxModule;
let runtime: ReturnType<MathJaxModule["init"]> | undefined;

const mathJaxRuntime = (): ReturnType<MathJaxModule["init"]> => {
  runtime ??= MathJax.init({
    loader: { load: ["input/tex", "output/chtml"] },
  });
  return runtime;
};

export const renderMathJaxChtml = async (
  formula: string
): Promise<{ css: string; html: string }> => {
  const mathJax = await mathJaxRuntime();
  const node = await mathJax.tex2chtmlPromise(formula, { display: true });
  const style = mathJax.startup.output.styleSheet(mathJax.startup.document);
  const result = {
    css: mathJax.startup.adaptor.textContent(style),
    html: mathJax.startup.adaptor.serializeXML(node),
  };
  if (result.html.includes("<mjx-merror")) {
    throw new Error("MathJax rejected the Unicode formula");
  }
  return result;
};
