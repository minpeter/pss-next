import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { typescriptSubprocessArguments } from "./typescript-subprocess.test-support";

const CLI_SUBPROCESS_TIMEOUT_MS = 30_000;
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function startProvider(mode: "failure" | "success") {
  const requestBodies: string[] = [];
  const server = createServer(async (request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    await once(request, "end");
    requestBodies.push(body);

    if (mode === "failure") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "provider-secret-must-not-leak" } })
      );
      return;
    }

    const parsed = JSON.parse(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `${[
        {
          choices: [
            {
              delta: { content: "OK", role: "assistant" },
              finish_reason: null,
            },
          ],
          created: 1,
          id: "chatcmpl-test",
          model: parsed.model,
        },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          created: 1,
          id: "chatcmpl-test",
          model: parsed.model,
          usage: {
            completion_tokens: 1,
            prompt_tokens: 10,
            total_tokens: 11,
          },
        },
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("")}data: [DONE]\n\n`
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Expected an IP test server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
  };
}

async function runCli(options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}) {
  const child = spawn(
    process.execPath,
    typescriptSubprocessArguments(
      join(import.meta.dirname, "runtime-block-time-cli.ts"),
      options.args
    ),
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        AI_API_KEY: undefined,
        AI_BASE_URL: undefined,
        AI_MODEL: undefined,
        ...options.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stderr, stdout };
}

describe("runtime block-time CLI integration", () => {
  it(
    "reports the dotenv-only model used by the instantiated provider",
    async () => {
      // Given
      const directory = await mkdtemp(join(tmpdir(), "runtime-dotenv-model-"));
      temporaryDirectories.push(directory);
      const provider = await startProvider("success");
      const outputDirectory = join(directory, "report");
      await writeFile(
        join(directory, ".env"),
        [
          "AI_API_KEY=dotenv-only-key",
          `AI_BASE_URL=${provider.baseUrl}`,
          "AI_MODEL=dotenv-only-model",
          "",
        ].join("\n")
      );

      // When
      const result = await runCli({
        args: [
          "--mode",
          "live",
          "--repetitions",
          "1",
          "--output",
          outputDirectory,
        ],
        cwd: directory,
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(provider.requestBodies.length).toBeGreaterThan(0);
      for (const requestBody of provider.requestBodies) {
        expect(JSON.parse(requestBody)).toMatchObject({
          model: "dotenv-only-model",
        });
      }
      expect(
        JSON.parse(
          await readFile(
            join(outputDirectory, "runtime-block-time.json"),
            "utf8"
          )
        )
      ).toMatchObject({ model: "dotenv-only-model" });
    },
    CLI_SUBPROCESS_TIMEOUT_MS
  );

  it(
    "emits only the execution sentinel when valid options reach a provider failure",
    async () => {
      // Given
      const directory = await mkdtemp(
        join(tmpdir(), "runtime-execution-fail-")
      );
      temporaryDirectories.push(directory);
      const provider = await startProvider("failure");

      // When
      const result = await runCli({
        args: [
          "--mode",
          "live",
          "--repetitions",
          "1",
          "--output",
          join(directory, "report"),
        ],
        cwd: directory,
        environment: {
          AI_API_KEY: "test-key",
          AI_BASE_URL: provider.baseUrl,
          AI_MODEL: "execution-failure-model",
        },
      });

      // Then
      expect(result).toEqual({
        exitCode: 1,
        stderr: "RUNTIME_BLOCK_TIME_EXECUTION_FAILED\n",
        stdout: "",
      });
    },
    CLI_SUBPROCESS_TIMEOUT_MS
  );
});
