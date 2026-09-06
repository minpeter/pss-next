import { startTui } from "../apps/coding-agent/src/tui/app.ts";
import { parseDirectStartArguments } from "../apps/coding-agent/src/tui/direct-start.ts";

// pnpm runs scripts in the repository but preserves the caller in INIT_CWD.
// Keep the process there for repository .env loading; only the workspace moves.
process.exitCode = await startTui({
  ...parseDirectStartArguments(process.argv.slice(2)),
  cwd: process.env.INIT_CWD || process.cwd(),
});
