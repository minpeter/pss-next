declare const PSS_CLI_VERSION: string | undefined;

export const cliVersion: string | undefined =
  typeof PSS_CLI_VERSION === "string" ? PSS_CLI_VERSION : undefined;
