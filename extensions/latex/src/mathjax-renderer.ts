import MathJax from "mathjax";

let runtime: ReturnType<typeof MathJax.init> | undefined;

const mathJaxRuntime = (): ReturnType<typeof MathJax.init> => {
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
  return {
    css: mathJax.startup.adaptor.textContent(style),
    html: mathJax.startup.adaptor.serializeXML(node),
  };
};
