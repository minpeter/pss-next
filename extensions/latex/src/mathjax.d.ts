declare module "mathjax" {
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

  const MathJax: MathJaxModule;
  export default MathJax;
}
