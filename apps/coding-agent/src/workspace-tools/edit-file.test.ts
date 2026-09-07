import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSchema, generateText, type ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenAICompatibleModelFromEnv } from "../model";
import { createEditFileTool } from "./edit-file";
import { createReadFileTool } from "./read-file";

const ANCHOR_EXAMPLE_PATTERN = /\b\d+#[A-Za-z0-9]+\b/gu;
const ANCHOR_SHAPE_PATTERN = /^\d+#[ZPMQVRWSNKTXJBYH]{2}$/u;
const READ_ANCHOR_PATTERN = /^(\d+#[ZPMQVRWSNKTXJBYH]{2})\|/gmu;
const FILE_HASH_PATTERN = /^file_hash: ([0-9a-f]{8})$/mu;
const fixture = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
const options: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "edit-anchor-test",
};

function descriptions(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "description" && typeof child === "string"
      ? [child]
      : descriptions(child)
  );
}

async function snapshot(workspace: string) {
  const path = join(workspace, "fixture.txt");
  const metadata = await stat(path, { bigint: true });
  return {
    bytes: await readFile(path),
    ctimeNs: metadata.ctimeNs,
    entries: await readdir(workspace),
    inode: metadata.ino,
    mtimeNs: metadata.mtimeNs,
  };
}

describe("edit_file anchor contract", () => {
  let workspace: string;
  let anchors: string[];
  let hash: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-edit-anchor-test-"));
    await writeFile(join(workspace, "fixture.txt"), fixture);
    const read = createReadFileTool(workspace).execute;
    if (read === undefined) {
      throw new Error("Expected executable read_file.");
    }
    const output = String(await read({ path: "fixture.txt" }, options));
    anchors = [...output.matchAll(READ_ANCHOR_PATTERN)].map(
      (match) => match[1]
    );
    const fileHash = FILE_HASH_PATTERN.exec(output)?.[1];
    if (fileHash === undefined || anchors.length !== 5) {
      throw new Error("Expected read_file anchors and file hash.");
    }
    hash = fileHash;
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  it("serializes non-strict generation with optional hash and anchor fields through the SDK", async () => {
    const requests: unknown[] = [];
    const before = await snapshot(workspace);
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
      tools: { edit_file: createEditFileTool(workspace) },
    });
    expect(result.text).toBe("OK");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "edit_file",
            strict: false,
            parameters: {
              required: ["path", "edits"],
              additionalProperties: false,
              properties: {
                expected_file_hash: { type: "string" },
                edits: {
                  items: {
                    required: ["op", "new_content"],
                    additionalProperties: false,
                    properties: {
                      target: { type: "string" },
                      first: { type: "string" },
                      last: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    });
    expect(await snapshot(workspace)).toEqual(before);
  });

  it("ships anchor example tokens with the parser's valid shape", async () => {
    const definition = createEditFileTool(workspace);
    const schema = await asSchema(definition.inputSchema).jsonSchema;
    if (typeof definition.description !== "string") {
      throw new TypeError("Expected a static edit_file description.");
    }
    const tokens = [definition.description, ...descriptions(schema)]
      .flatMap((text) => [...text.matchAll(ANCHOR_EXAMPLE_PATTERN)])
      .map((match) => match[0]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      // Shape is not content validity: actual edits below copy fresh read anchors.
      expect(token).toMatch(ANCHOR_SHAPE_PATTERN);
    }
  });

  it.each(["target", "range"])(
    "edits with omitted unused fields: %s",
    async (variant) => {
      const execute = createEditFileTool(workspace).execute;
      if (execute === undefined) {
        throw new Error("Expected executable edit_file.");
      }
      await execute(
        {
          path: "fixture.txt",
          expected_file_hash: hash,
          edits: [
            {
              op: "replace",
              ...(variant === "target"
                ? { target: anchors[1] }
                : { first: anchors[1], last: anchors[2] }),
              new_content: "replacement",
            },
          ],
        },
        options
      );
      expect(await readFile(join(workspace, "fixture.txt"), "utf8")).toBe(
        variant === "target"
          ? "alpha\nreplacement\ngamma\ndelta\nepsilon\n"
          : "alpha\nreplacement\ndelta\nepsilon\n"
      );
    }
  );

  it.each([
    "both",
    "empty-range",
    "empty-target",
    "placeholder-range",
    "partial-empty-range",
    "batch-conflict",
    "stale-hash",
    "stale-anchor",
    "overlap",
    "insertion-intersection",
  ])("rejects %s without any mutation", async (scenario) => {
    const execute = createEditFileTool(workspace).execute;
    if (execute === undefined) {
      throw new Error("Expected executable edit_file.");
    }
    const target = {
      op: "replace" as const,
      target: anchors[1],
      new_content: "replacement",
    };
    const range = {
      op: "replace" as const,
      first: anchors[1],
      last: anchors[2],
      new_content: "replacement",
    };
    const conflict = { ...target, first: "", last: "" };
    const cases = {
      both: [{ ...range, target: anchors[0] }],
      "empty-range": [conflict],
      "empty-target": [{ ...range, target: "" }],
      "placeholder-range": [{ ...target, first: "N/A", last: "N/A" }],
      "partial-empty-range": [{ ...target, first: "" }],
      "batch-conflict": [target, conflict],
      "stale-hash": [target],
      "stale-anchor": [
        { ...target, target: anchors[1] === "2#ZZ" ? "2#PP" : "2#ZZ" },
      ],
      overlap: [target, range],
      "insertion-intersection": [
        range,
        { op: "append" as const, target: anchors[1], new_content: "insert" },
      ],
    };
    const before = await snapshot(workspace);
    await expect(
      execute(
        {
          path: "fixture.txt",
          expected_file_hash: scenario === "stale-hash" ? "00000000" : hash,
          edits: cases[scenario as keyof typeof cases],
        },
        options
      )
    ).rejects.toBeInstanceOf(Error);
    expect(await snapshot(workspace)).toEqual(before);
  });
});
