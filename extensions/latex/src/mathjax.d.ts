declare module "mathjax" {
  interface MathJaxAdaptor {
    serializeXML(node: unknown): string;
  }

  interface MathJaxRuntime {
    readonly startup: {
      readonly adaptor: MathJaxAdaptor;
    };
    tex2svgPromise(
      formula: string,
      options: { readonly display: boolean }
    ): Promise<unknown>;
  }

  interface MathJaxModule {
    init(options: {
      readonly loader: { readonly load: readonly string[] };
      readonly svg: { readonly fontCache: "none" };
    }): Promise<MathJaxRuntime>;
  }

  const MathJax: MathJaxModule;
  export default MathJax;
}
