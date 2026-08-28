import { resolve } from "node:path";

export const LIFECYCLE_TIMEOUT_MS = 30_000;

export interface CelldProcessConfiguration {
  readonly bucket: string;
  readonly celld: string;
  readonly endpoint: string;
  readonly esbuild: string;
}

export function celldProcessConfiguration(): CelldProcessConfiguration {
  return {
    bucket: process.env.CELLD_QA_BUCKET ?? "pss-celld-qa",
    celld: process.env.CELLD_BIN ?? `${process.env.HOME}/.local/bin/celld`,
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:14566",
    esbuild:
      process.env.CELLD_ESBUILD ??
      resolve(
        import.meta.dirname,
        "../../../node_modules/.pnpm/@esbuild+linux-x64@0.28.2/node_modules/@esbuild/linux-x64/bin/esbuild"
      ),
  };
}

export function localEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  };
}

export function celldArguments({
  bucket,
  endpoint,
  port,
  prefix,
}: Pick<CelldProcessConfiguration, "bucket" | "endpoint"> & {
  readonly port: number;
  readonly prefix: string;
}): string[] {
  return [
    "--bucket",
    `s3://${bucket}/${prefix}`,
    "--endpoint",
    endpoint,
    "--region",
    "us-east-1",
    "--listen",
    `127.0.0.1:${port}`,
    "--internal-listen",
    "127.0.0.1:0",
  ];
}
