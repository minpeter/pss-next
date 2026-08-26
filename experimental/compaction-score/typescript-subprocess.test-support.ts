const tsxImport = import.meta.resolve("tsx");

export const typescriptSubprocessArguments = (
  entrypoint: string,
  arguments_: readonly string[] = []
): string[] => [
  "--import",
  tsxImport,
  "--conditions=@minpeter/pss-source",
  entrypoint,
  ...arguments_,
];
