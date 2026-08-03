export const NEXTJS_EVALS_SHA = "34d92a50266d2b70be5ac8ac147bd270f52d4a12";
// Pinned for reproducibility: 16.3.0-canary.92+ ERESOLVE-conflicts with the
// pinned fixture's peer dependencies. Override only via --next-version or
// PSS_BENCH_NEXT_VERSION for non-reproducible experiments.
export const DEFAULT_NEXT_VERSION = "16.3.0-canary.89";
export const NEXTJS_EVALS_REPOSITORY = "https://github.com/vercel/next.js.git";
export const DEFAULT_MODEL = "qwen3.8-max-preview";
export const DEFAULT_BASE_URL = "https://apis.opengateway.ai/v1";
export const SMOKE_EVALS = new Set([
  "agent-000-app-router-migration-simple",
  "agent-026-no-serial-await",
  "agent-033-forbidden-auth",
  "agent-043-view-transitions",
]);
