import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function lastLines(value, count = 12) {
  return value.trim().split("\n").slice(-count).join("\n");
}

function readExecResult(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
}

export function runAgent(input) {
  const execResultPath = join(tmpdir(), `pss-exec-${process.pid}.json`);
  const timeoutSeconds = Math.min(1200, input.extra?.timeoutSeconds ?? 1200);
  const args = [
    "exec",
    "--workspace",
    input.cwd,
    "--stdin",
    "--web-tools",
    "disabled",
    "--timeout-seconds",
    String(timeoutSeconds),
    "--result-file",
    execResultPath,
  ];
  if (input.model) {
    args.push("--model", input.model);
  }
  const run = spawnSync("pss", args, {
    cwd: input.cwd,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    input: input.prompt,
    maxBuffer: 64 * 1024 * 1024,
    timeout: (timeoutSeconds + 30) * 1000,
  });
  const execResult = readExecResult(execResultPath);
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const ok = run.status === 0 && execResult?.status === "completed";
  const result = {
    ok,
    output: execResult?.finalText || lastLines(stdout),
    transcript: stdout || null,
    observedModel: execResult?.modelIds?.at(-1) ?? input.model ?? null,
    error: ok
      ? null
      : (execResult?.error ??
        lastLines(stderr || stdout || run.error?.message || "PSS failed")),
    agentExitCode: run.status ?? -1,
  };
  rmSync(execResultPath, { force: true });
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const input = JSON.parse(process.argv[2]);
  let result;
  try {
    result = runAgent(input);
  } catch (error) {
    result = {
      ok: false,
      output: "",
      transcript: null,
      observedModel: input.model ?? null,
      error: error instanceof Error ? error.message : String(error),
      agentExitCode: -1,
    };
  }
  mkdirSync(dirname(input.resultPath), { recursive: true });
  writeFileSync(input.resultPath, JSON.stringify(result), "utf8");
  process.stdout.write(
    `__AGENT_RESULT__ ${JSON.stringify({
      ok: result.ok,
      observedModel: result.observedModel,
      error: result.error,
      agentExitCode: result.agentExitCode,
    })}\n`
  );
}
