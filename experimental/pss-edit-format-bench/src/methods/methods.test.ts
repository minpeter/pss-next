import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { computeFileHash } from "../formats";
import { EDIT_TASKS } from "../tasks";
import { getEditMethod } from "./index";
import type { MethodToolHooks } from "./types";

const task = EDIT_TASKS.find((item) => item.id === "single-line-to-two");
if (task === undefined) {
  throw new Error("fixture task missing");
}

const emptyHooks = (workspaceTarget = task.path): MethodToolHooks => ({
  events: [],
  requestAttempt: 1,
  run: 1,
  task,
  targetPath: workspaceTarget,
  trace: undefined,
});

const seed = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
};

const execute = async (
  tool: { execute?: (...args: never[]) => unknown },
  input: unknown
): Promise<string> => {
  if (tool.execute === undefined) {
    throw new Error("missing execute");
  }
  const result = await tool.execute(
    input as never,
    {
      abortSignal: AbortSignal.timeout(5000),
      messages: [],
      toolCallId: "test",
    } as never
  );
  return typeof result === "string" ? result : String(result);
};

describe("edit methods write the filesystem", () => {
  it("pss-json edit_file updates the target file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-method-pss-"));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    await seed(root, task.initialFiles);
    const method = getEditMethod("pss-json");
    const tools = method.createTools(root, emptyHooks());
    const readOut = await execute(tools.read_file, { path: task.path });
    expect(readOut).toContain("OK - file");
    expect(readOut).toContain("file_hash:");
    const hash = computeFileHash(task.initial);
    // greet.py line 2 is the msg assignment — use production anchors from read
    const line2 = readOut.split("\n").find((line) => line.startsWith("2#"));
    expect(line2).toBeDefined();
    const anchor = line2?.split("|")[0];
    expect(anchor).toBeDefined();
    const editOut = await execute(tools.edit_file, {
      path: task.path,
      expected_file_hash: hash,
      edits: [
        {
          op: "replace",
          target: anchor,
          new_content: [
            '    greeting = "Hi"',
            '    msg = f"{greeting}, {name}"',
          ],
        },
      ],
    });
    expect(editOut).toContain("OK - edited file");
    expect(await readFile(join(root, task.path), "utf8")).toBe(task.expected);
  });

  it("omp-dsl edit_file applies a DSL patch on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-method-omp-"));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    await seed(root, task.initialFiles);
    const method = getEditMethod("omp-dsl");
    const tools = method.createTools(root, emptyHooks());
    const patch = [
      `[${task.path}#A1B2]`,
      "SWAP 2.=2:",
      '+    greeting = "Hi"',
      '+    msg = f"{greeting}, {name}"',
    ].join("\n");
    const editOut = await execute(tools.edit_file, {
      path: task.path,
      patch,
    });
    expect(editOut).toContain("OK - edited file");
    expect(await readFile(join(root, task.path), "utf8")).toBe(task.expected);
  });

  it("grok-json write replaces the whole file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-method-grok-"));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    await seed(root, task.initialFiles);
    const method = getEditMethod("grok-json");
    const tools = method.createTools(root, emptyHooks());
    const editOut = await execute(tools.edit_file, {
      edits: [{ op: "write", content: task.expected }],
    });
    expect(editOut).toContain("OK - edited file");
    expect(await readFile(join(root, task.path), "utf8")).toBe(task.expected);
  });
});
