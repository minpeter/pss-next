#!/usr/bin/env node
import { runCodingAgentCli } from "../dist/cli.js";
import {
  formatModelEnvSetupHelp,
  isModelEnvValidationError,
} from "../dist/env.js";

try {
  const exitCode = await runCodingAgentCli();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} catch (error) {
  if (isModelEnvValidationError(error)) {
    process.stderr.write(formatModelEnvSetupHelp(error));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
