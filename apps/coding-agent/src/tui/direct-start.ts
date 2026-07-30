export interface DirectStartSelection {
  readonly sessionKey?: string;
}

export const parseDirectStartArguments = (
  argv: readonly string[]
): DirectStartSelection => {
  const flag = argv.indexOf("--session");
  const value = flag === -1 ? undefined : argv[flag + 1];
  return value === undefined || value.startsWith("-")
    ? {}
    : { sessionKey: value };
};
