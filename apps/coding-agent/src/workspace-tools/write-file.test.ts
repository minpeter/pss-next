import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, type ToolExecutionOptions } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleModelFromEnv } from "../model";
import { computeFileHash } from "./hashline";
import { createReadFileTool } from "./read-file";
import { createWriteFileTool } from "./write-file";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    chmod: vi.fn(original.chmod),
    mkdir: vi.fn(original.mkdir),
    readFile: vi.fn(original.readFile),
    rename: vi.fn(original.rename),
    rm: vi.fn(original.rm),
    writeFile: vi.fn(original.writeFile),
  };
});

const original =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const executionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "write-file-hash-test",
};
const FILE_HASH_PATTERN = /^file_hash: ([0-9a-f]{8})$/m;

function executeWrite(workspace: string) {
  const { execute } = createWriteFileTool(workspace);
  if (execute === undefined) {
    throw new Error("Expected executable write_file tool.");
  }
  return execute;
}

async function readHash(workspace: string, path: string): Promise<string> {
  const { execute } = createReadFileTool(workspace);
  if (execute === undefined) {
    throw new Error("Expected executable read_file tool.");
  }
  const output = String(await execute({ path }, executionOptions));
  const hash = FILE_HASH_PATTERN.exec(output)?.[1];
  if (hash === undefined) {
    throw new Error("Expected read_file hash metadata.");
  }
  return hash;
}

function expectNoMutations(): void {
  for (const operation of [chmod, mkdir, rename, rm, writeFile]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

describe("write_file hash preconditions", () => {
  let workspace: string;

  it("sends explicit non-strict generation while keeping the hash optional", async () => {
    const requests: unknown[] = [];
    const model = createOpenAICompatibleModelFromEnv({
      runtimeEnv: {
        AI_API_KEY: "fixture-key",
        AI_BASE_URL: "https://fixture.invalid/v1",
        AI_MODEL: "fixture-model",
      },
      fetch: (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          Response.json({
            id: "fixture-response",
            object: "chat.completion",
            created: 0,
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          })
        );
      },
    });
    const result = await generateText({
      model,
      prompt: "Reply OK without calling a tool.",
      tools: { write_file: createWriteFileTool(workspace) },
    });
    expect(result.text).toBe("OK");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "write_file",
            strict: false,
            parameters: {
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    expectNoMutations();
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    workspace = await original.mkdtemp(join(tmpdir(), "pss-write-hash-test-"));
  });

  afterEach(async () => {
    await original.rm(workspace, { force: true, recursive: true });
    await expect(original.lstat(workspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ".invalid",
    ". . . . ",
    "        ",
    "E3B0C442",
    "e3b0c442\n",
    "",
    null,
  ])("rejects invalid hash %j in the SDK before execution", async (hash) => {
    const definition = createWriteFileTool(workspace);
    const execute = vi.fn(executeWrite(workspace));
    const result = await generateText({
      model: new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              type: "tool-call",
              toolCallId: "invalid-hash",
              toolName: "write_file",
              input: JSON.stringify({
                content: "replacement",
                expected_file_hash: hash,
                path: "missing/deep/index.html",
              }),
            },
          ],
          finishReason: { raw: "tool-calls", unified: "tool-calls" },
          usage: {
            inputTokens: {
              cacheRead: undefined,
              cacheWrite: undefined,
              noCache: 1,
              total: 1,
            },
            outputTokens: {
              reasoning: undefined,
              text: 1,
              total: 1,
            },
          },
          warnings: [],
        },
      }),
      prompt: "Run the fixture tool call.",
      tools: { write_file: { ...definition, execute } },
    });

    expect(result.toolCalls[0]).toMatchObject({
      invalid: true,
      error: { name: "AI_InvalidToolInputError" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expectNoMutations();
    expect(await original.readdir(workspace)).toEqual([]);
  });

  it.each(["index.html", "missing/deep/index.html"])(
    "rejects guarded creation of %s before any mutation",
    async (path) => {
      await expect(
        executeWrite(workspace)(
          {
            content: "replacement",
            expected_file_hash: "00000000",
            path,
          },
          executionOptions
        )
      ).rejects.toMatchObject({
        name: "FileHashPreconditionError",
        code: "FILE_HASH_TARGET_MISSING",
        cause: { code: "ENOENT" },
      });
      expectNoMutations();
      expect(await original.readdir(workspace)).toEqual([]);
    }
  );

  it("does not treat the empty-file hash as a missing-file sentinel", async () => {
    expect(computeFileHash("")).toBe("e3b0c442");
    await expect(
      executeWrite(workspace)(
        {
          content: "replacement",
          expected_file_hash: "e3b0c442",
          path: "index.html",
        },
        executionOptions
      )
    ).rejects.toMatchObject({
      name: "FileHashPreconditionError",
      code: "FILE_HASH_TARGET_MISSING",
      cause: { code: "ENOENT" },
    });
    expectNoMutations();
    expect(await original.readdir(workspace)).toEqual([]);
  });

  it.each(["index.html", "missing/deep/index.html"])(
    "creates %s without a hash",
    async (path) => {
      await executeWrite(workspace)(
        { content: "new content", path },
        executionOptions
      );
      expect(await original.readFile(join(workspace, path), "utf8")).toBe(
        "new content"
      );
      expect(readFile).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledOnce();
    }
  );

  it.each(["", "original\n"])(
    "overwrites %j using its exact read_file hash and preserves permissions",
    async (content) => {
      const path = join(workspace, "index.html");
      await original.writeFile(path, content, { mode: 0o640 });
      const hash = await readHash(workspace, "index.html");
      vi.clearAllMocks();

      await executeWrite(workspace)(
        {
          content: "replacement",
          expected_file_hash: hash,
          path: "index.html",
        },
        executionOptions
      );
      expect(readFile).toHaveBeenCalledTimes(2);
      expect(await original.readFile(path, "utf8")).toBe("replacement");
      expect((await original.stat(path)).mode % 0o1000).toBe(0o640);
      expect(await original.readdir(workspace)).toEqual(["index.html"]);
    }
  );

  it("rejects a stale read_file hash without changing target bytes", async () => {
    const path = join(workspace, "index.html");
    await original.writeFile(path, "original");
    const hash = await readHash(workspace, "index.html");
    await original.writeFile(path, "concurrent change");
    vi.clearAllMocks();

    await expect(
      executeWrite(workspace)(
        {
          content: "replacement",
          expected_file_hash: hash,
          path: "index.html",
        },
        executionOptions
      )
    ).rejects.toMatchObject({
      name: "FileHashPreconditionError",
      code: "FILE_HASH_MISMATCH",
    });
    expect(readFile).toHaveBeenCalledOnce();
    expectNoMutations();
    expect(await original.readFile(path, "utf8")).toBe("concurrent change");
  });

  it.each(["delete", "change"])(
    "fails closed and removes its temp file when the target undergoes %s after the first check",
    async (action) => {
      const path = join(workspace, "index.html");
      await original.writeFile(path, "original");
      const hash = await readHash(workspace, "index.html");
      vi.clearAllMocks();
      // Gate on the completed real temp write: the first hash check has passed,
      // and the second check must still observe this concurrent mutation.
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        await original.writeFile(...args);
        expect(args[0]).not.toBe(path);
        expect(readFile).toHaveBeenCalledTimes(1);
        if (action === "delete") {
          await original.rm(path);
        } else {
          await original.writeFile(path, "concurrent change");
        }
      });

      const attempt = executeWrite(workspace)(
        {
          content: "replacement",
          expected_file_hash: hash,
          path: "index.html",
        },
        executionOptions
      );
      if (action === "delete") {
        await expect(attempt).rejects.toMatchObject({
          name: "FileHashPreconditionError",
          code: "FILE_HASH_TARGET_MISSING",
          cause: { code: "ENOENT" },
        });
        await expect(original.lstat(path)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await original.readdir(workspace)).toEqual([]);
      } else {
        await expect(attempt).rejects.toMatchObject({
          name: "FileHashPreconditionError",
          code: "FILE_HASH_MISMATCH",
        });
        expect(await original.readFile(path, "utf8")).toBe("concurrent change");
        expect(await original.readdir(workspace)).toEqual(["index.html"]);
      }
      expect(readFile).toHaveBeenCalledTimes(2);
      expect(writeFile).toHaveBeenCalledOnce();
      expect(rename).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalledOnce();
    }
  );

  it.each([1, 2])(
    "preserves an EACCES error at hash check %s",
    async (check) => {
      const path = join(workspace, "index.html");
      await original.writeFile(path, "original");
      const hash = await readHash(workspace, "index.html");
      vi.clearAllMocks();
      const denied = Object.assign(new Error("fixture read denied"), {
        code: "EACCES",
      });
      if (check === 2) {
        vi.mocked(readFile).mockImplementationOnce(original.readFile);
      }
      vi.mocked(readFile).mockRejectedValueOnce(denied);

      await expect(
        executeWrite(workspace)(
          {
            content: "replacement",
            expected_file_hash: hash,
            path: "index.html",
          },
          executionOptions
        )
      ).rejects.toBe(denied);
      expect(await original.readFile(path, "utf8")).toBe("original");
      expect(await original.readdir(workspace)).toEqual(["index.html"]);
      expect(rename).not.toHaveBeenCalled();
      if (check === 1) {
        expectNoMutations();
      } else {
        expect(writeFile).toHaveBeenCalledOnce();
        expect(rm).toHaveBeenCalledOnce();
      }
    }
  );
});
