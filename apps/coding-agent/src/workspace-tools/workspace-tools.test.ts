import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "./index";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath } from "./path-safety";
import { globPatternToRegExp } from "./walk";
import { atomicWrite } from "./write-file";

const addedSecondLinePattern = /\+2#[A-Z]+\|export const second = 3;/u;
const addedThirdLinePattern = /\+3#[A-Z]+\|export const third = 3;/u;
const freshAnchorPattern = /2#[A-Z]+/u;
const directoryTruncationPattern = /truncated|showing 1000 of 1005/iu;
const fileHashPattern = /file_hash: ([0-9a-f]{8})/u;
const firstLineAnchorPattern = /1#[ZPMQVRWSNKTXJBYH]{2}(?=\|)/u;
const grepResultPattern = /src\/new\.ts:1#[ZPMQVRWSNKTXJBYH]{2}\|needle/u;
const intersectPattern = /intersect|overlap/iu;
const outsideWorkspacePattern = /outside the workspace/u;
const phantomLinePattern = /3#[ZPMQVRWSNKTXJBYH]{2}/u;
const secondLineAnchorPattern = /2#[ZPMQVRWSNKTXJBYH]{2}(?=\|)/u;
const skippedPattern = /skipped/u;
const staleFileHashPattern = /Stale file hash/u;
const symlinkPattern = /symlink/u;
const truncatedMarkerPattern = /\n\.\.\. truncated (\d+) bytes \.\.\.\n/u;
const truncatedPattern = /truncated|\+/u;
const unsupportedEndPattern = /end/u;
const workspaceEscapePattern = /escapes workspace/u;
const workspaceRootPattern = /workspace root/u;

const executionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "workspace-tool-test",
};

function executableTool(
  tools: ReturnType<typeof createWorkspaceTools>,
  name: string
) {
  const execute = tools[name]?.execute;
  if (typeof execute !== "function") {
    throw new TypeError(`Expected executable tool: ${name}`);
  }
  return execute;
}

describe("workspace coding tools", () => {
  let outside: string;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-workspace-"));
    outside = await mkdtemp(join(tmpdir(), "pss-outside-"));
    await mkdir(join(workspace, "src"));
    await writeFile(
      join(workspace, "src", "example.ts"),
      "export const first = 1;\nexport const second = 2;\n",
      "utf8"
    );
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("reads hashline anchors and applies deterministic edits", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    const anchor = initial.match(secondLineAnchorPattern)?.[0];
    const fileHash = initial.match(fileHashPattern)?.[1];
    expect(anchor).toBeDefined();
    expect(fileHash).toBeDefined();
    if (anchor === undefined || fileHash === undefined) {
      throw new Error("Expected hashline metadata.");
    }

    await edit(
      {
        edits: [
          {
            lines: ["export const second = 3;"],
            op: "replace",
            pos: anchor,
          },
        ],
        expected_file_hash: fileHash,
        path: "src/example.ts",
      },
      executionOptions
    );

    await expect(
      readFile(join(workspace, "src", "example.ts"), "utf8")
    ).resolves.toBe("export const first = 1;\nexport const second = 3;\n");
  });

  it("includes removed and added lines in a diff section of the output", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");

    const output = await read({ path: "src/example.ts" }, executionOptions);
    const anchor = String(output).match(secondLineAnchorPattern)?.[0];

    const editOutput = String(
      await edit(
        {
          path: "src/example.ts",
          edits: [
            {
              op: "replace",
              pos: anchor,
              lines: "export const second = 3;",
            },
            { op: "append", lines: "export const third = 3;" },
          ],
        },
        executionOptions
      )
    );

    expect(editOutput).toContain("diff:");
    expect(editOutput).toContain(`-${anchor}|export const second = 2;`);
    expect(editOutput).toMatch(addedSecondLinePattern);
    expect(editOutput).toMatch(addedThirdLinePattern);

    // the returned anchors must match what a fresh read would compute,
    // so the model can chain the next edit without re-reading
    const freshOutput = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    const freshAnchor = freshAnchorPattern.exec(freshOutput)?.[0];
    expect(freshAnchor).toBeDefined();
    expect(editOutput).toContain(`+${freshAnchor}|export const second = 3;`);
  });

  it("reports added anchors at final positions after shifted edits", async () => {
    const targetPath = join(workspace, "src", "shifted.ts");
    await writeFile(targetPath, "one\ntwo\nthree\nfour\n", "utf8");
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/shifted.ts" }, executionOptions)
    );
    const anchorAt = (lineNumber: number): string | undefined =>
      initial
        .split("\n")
        .find((line) => line.startsWith(`${lineNumber}#`))
        ?.split("|")[0];
    const firstAnchor = anchorAt(1);
    const fourthAnchor = anchorAt(4);
    expect(firstAnchor).toBeDefined();
    expect(fourthAnchor).toBeDefined();
    if (firstAnchor === undefined || fourthAnchor === undefined) {
      throw new Error("Expected shifted-file hashline anchors.");
    }

    const editOutput = String(
      await edit(
        {
          edits: [
            {
              lines: ["ONE", "INSERTED"],
              op: "replace",
              pos: firstAnchor,
            },
            {
              lines: "FOUR",
              op: "replace",
              pos: fourthAnchor,
            },
          ],
          path: "src/shifted.ts",
        },
        executionOptions
      )
    );
    const freshOutput = String(
      await read({ path: "src/shifted.ts" }, executionOptions)
    );
    const finalFourthLine = freshOutput
      .split("\n")
      .find((line) => line.endsWith("|FOUR"));

    expect(finalFourthLine).toBeDefined();
    expect(editOutput).toContain(`+${finalFourthLine}`);
  });

  it("truncates oversized edit_file result payloads", async () => {
    const targetPath = join(workspace, "src", "large-edit.ts");
    await writeFile(targetPath, "before\n", "utf8");
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/large-edit.ts" }, executionOptions)
    );
    const anchor = initial
      .split("\n")
      .find((line) => line.startsWith("1#"))
      ?.split("|")[0];
    expect(anchor).toBeDefined();
    if (anchor === undefined) {
      throw new Error("Expected large-edit hashline anchor.");
    }

    const output = String(
      await edit(
        {
          edits: [
            {
              lines: "x".repeat(70_000),
              op: "replace",
              pos: anchor,
            },
          ],
          path: "src/large-edit.ts",
        },
        executionOptions
      )
    );

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(output).toContain("truncated");
  });

  it("rejects stale anchors and stale file hashes", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    const anchor = initial.match(firstLineAnchorPattern)?.[0];
    const fileHash = initial.match(fileHashPattern)?.[1];
    if (anchor === undefined || fileHash === undefined) {
      throw new Error("Expected hashline metadata.");
    }
    await writeFile(join(workspace, "src", "example.ts"), "changed\n", "utf8");

    await expect(
      edit(
        {
          edits: [{ lines: ["replacement"], op: "replace", pos: anchor }],
          expected_file_hash: fileHash,
          path: "src/example.ts",
        },
        executionOptions
      )
    ).rejects.toThrow(staleFileHashPattern);
  });

  it("keeps file operations inside the workspace", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const write = executableTool(tools, "write_file");
    await expect(
      read({ path: "../outside.txt" }, executionOptions)
    ).rejects.toThrow(workspaceEscapePattern);

    await symlink(outside, join(workspace, "linked"), "dir");
    await expect(
      write({ content: "escape", path: "linked/escape.txt" }, executionOptions)
    ).rejects.toThrow(symlinkPattern);
  });

  it("supports glob, grep, shell, write, and delete workflows", async () => {
    const tools = createWorkspaceTools({ workspace });
    const glob = executableTool(tools, "glob_files");
    const grep = executableTool(tools, "grep_files");
    const shell = executableTool(tools, "shell_execute");
    const write = executableTool(tools, "write_file");
    const remove = executableTool(tools, "delete_file");

    await write({ content: "needle\n", path: "src/new.ts" }, executionOptions);
    await expect(
      glob({ path: "src", pattern: "*.ts" }, executionOptions)
    ).resolves.toContain("src/new.ts");
    await expect(
      grep(
        { fixed_strings: true, include: "*.ts", pattern: "needle" },
        executionOptions
      )
    ).resolves.toMatch(grepResultPattern);
    await expect(
      shell({ command: "pwd" }, executionOptions)
    ).resolves.toContain(workspace);

    const executable = join(workspace, "script.sh");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    await write(
      { content: "#!/bin/sh\necho ok\n", path: "script.sh" },
      executionOptions
    );
    expect((await stat(executable)).mode % 0o1000).toBe(0o755);

    await remove({ path: "src/new.ts" }, executionOptions);
    await expect(
      readFile(join(workspace, "src", "new.ts"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves paths when the workspace is the filesystem root", async () => {
    const resolved = await resolveWorkspacePath("/", "/tmp");
    expect(resolved.root).toBe("/");
    expect(resolved.path).toBe("/tmp");
  });

  it("accepts absolute paths through a symlinked workspace alias", async () => {
    const alias = join(outside, "workspace-alias");
    await symlink(workspace, alias, "dir");
    const tools = createWorkspaceTools({ workspace: alias });
    const read = executableTool(tools, "read_file");
    const remove = executableTool(tools, "delete_file");

    const output = String(
      await read({ path: join(alias, "src", "example.ts") }, executionOptions)
    );
    expect(output).toContain("path: src/example.ts");
    expect(output).not.toContain("..");

    await expect(
      remove({ path: ".", recursive: true }, executionOptions)
    ).rejects.toThrow(workspaceRootPattern);
    await expect(
      stat(join(workspace, "src", "example.ts"))
    ).resolves.toBeTruthy();
  });

  it("writes and edits through a file symlink update the target", async () => {
    const target = join(workspace, "src", "target.ts");
    const link = join(workspace, "src", "link.ts");
    await writeFile(target, "before\n", { mode: 0o600 });
    await symlink(target, link);
    const tools = createWorkspaceTools({ workspace });
    const write = executableTool(tools, "write_file");
    const remove = executableTool(tools, "delete_file");

    await write({ content: "after\n", path: "src/link.ts" }, executionOptions);
    await expect(readFile(target, "utf8")).resolves.toBe("after\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await stat(target)).mode % 0o1000).toBe(0o600);

    await remove({ path: "src/link.ts" }, executionOptions);
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(target, "utf8")).resolves.toBe("after\n");
  });

  it("cleans up the temp file when an atomic write fails", async () => {
    const directory = join(workspace, "src", "blocking-dir");
    await mkdir(directory);
    await expect(atomicWrite(directory, "payload")).rejects.toThrow();
    const leftovers = (await readdir(join(workspace, "src"))).filter((entry) =>
      entry.includes(".pss-")
    );
    expect(leftovers).toStrictEqual([]);
  });

  it("truncates on UTF-8 boundaries and honors tiny budgets", () => {
    const emojis = "😀".repeat(100);
    const truncated = truncateToolOutput(emojis, 50);
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(50);
    expect(truncated).not.toContain("\uFFFD");

    const tiny = truncateToolOutput("x".repeat(1000), 10);
    expect(Buffer.byteLength(tiny)).toBeLessThanOrEqual(10);
  });

  it("reports the actual omitted byte count in the truncation marker", () => {
    const source = "a".repeat(1000);
    const truncated = truncateToolOutput(source, 100);
    const marker = truncatedMarkerPattern.exec(truncated);
    expect(marker).not.toBeNull();
    if (marker === null) {
      throw new Error("Expected truncation marker.");
    }
    const actualOmitted =
      Buffer.byteLength(source) -
      (Buffer.byteLength(truncated) - Buffer.byteLength(marker[0]));
    expect(Number(marker[1])).toBe(actualOmitted);
  });

  it("appends to an empty file without a leading blank line", async () => {
    await writeFile(join(workspace, "src", "empty.ts"), "", "utf8");
    const tools = createWorkspaceTools({ workspace });
    const edit = executableTool(tools, "edit_file");
    await edit(
      { edits: [{ lines: ["first"], op: "append" }], path: "src/empty.ts" },
      executionOptions
    );
    await expect(
      readFile(join(workspace, "src", "empty.ts"), "utf8")
    ).resolves.toBe("first");
  });

  it("rejects end on append/prepend and insertions intersecting replacements", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    const anchor = initial.match(secondLineAnchorPattern)?.[0];
    if (anchor === undefined) {
      throw new Error("Expected hashline metadata.");
    }

    await expect(
      edit(
        {
          edits: [{ end: anchor, lines: ["x"], op: "append" }],
          path: "src/example.ts",
        },
        executionOptions
      )
    ).rejects.toThrow(unsupportedEndPattern);

    await expect(
      edit(
        {
          edits: [
            { lines: ["replaced"], op: "replace", pos: anchor },
            { lines: ["inserted"], op: "prepend", pos: anchor },
          ],
          path: "src/example.ts",
        },
        executionOptions
      )
    ).rejects.toThrow(intersectPattern);
  });

  it("does not advertise a phantom line for a trailing newline", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const output = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    expect(output).toContain("lines: 1-2/2");
    expect(output).not.toMatch(phantomLinePattern);
  });

  it("marks truncated directory listings", async () => {
    const crowded = join(workspace, "crowded");
    await mkdir(crowded);
    for (let index = 0; index < 1005; index += 1) {
      await writeFile(join(crowded, `f${index}.txt`), "x", "utf8");
    }
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const output = String(await read({ path: "crowded" }, executionOptions));
    expect(output).toMatch(directoryTruncationPattern);
  });

  it("marks truncated glob results", async () => {
    await writeFile(join(workspace, "src", "second.ts"), "export {}\n", "utf8");
    const tools = createWorkspaceTools({ workspace });
    const glob = executableTool(tools, "glob_files");
    const output = String(
      await glob(
        { max_results: 1, path: "src", pattern: "*.ts" },
        executionOptions
      )
    );
    expect(output).toMatch(truncatedPattern);
  });

  it("reports files skipped during grep for size", async () => {
    await writeFile(
      join(workspace, "src", "large.txt"),
      `needle\n${"x".repeat(2 * 1024 * 1024)}`,
      "utf8"
    );
    await writeFile(
      join(workspace, "src", "small.txt"),
      "needle here\n",
      "utf8"
    );
    const tools = createWorkspaceTools({ workspace });
    const grep = executableTool(tools, "grep_files");
    const output = String(
      await grep(
        { fixed_strings: true, path: "src", pattern: "needle" },
        executionOptions
      )
    );
    expect(output).toContain("src/small.txt");
    expect(output).toMatch(skippedPattern);
  });

  it("treats backslashes in glob patterns as literal characters", () => {
    const matcher = globPatternToRegExp("foo\\d.ts");
    expect(matcher.test("foo\\d.ts")).toBe(true);
    expect(matcher.test("food.ts")).toBe(false);
  });

  it("deletes a symlink with the target's expected_file_hash", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const remove = executableTool(tools, "delete_file");
    await symlink(
      join(workspace, "src", "example.ts"),
      join(workspace, "src", "hash-link.ts")
    );
    const output = String(
      await read({ path: "src/hash-link.ts" }, executionOptions)
    );
    const fileHash = fileHashPattern.exec(output)?.[1];
    if (fileHash === undefined) {
      throw new Error("Expected file hash in read output.");
    }
    await remove(
      { expected_file_hash: fileHash, path: "src/hash-link.ts" },
      executionOptions
    );
    await expect(
      lstat(join(workspace, "src", "hash-link.ts"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(workspace, "src", "example.ts"))
    ).resolves.toBeTruthy();
  });

  it("refuses hash validation for links pointing outside the workspace", async () => {
    const tools = createWorkspaceTools({ workspace });
    const remove = executableTool(tools, "delete_file");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(
      join(outside, "secret.txt"),
      join(workspace, "src", "outside-link.ts")
    );
    await expect(
      remove(
        { expected_file_hash: "12345678", path: "src/outside-link.ts" },
        executionOptions
      )
    ).rejects.toThrow(outsideWorkspacePattern);
    await expect(
      lstat(join(workspace, "src", "outside-link.ts"))
    ).resolves.toBeTruthy();
  });

  it("deletes dangling and outside-pointing symlinks as links", async () => {
    const dangling = join(workspace, "src", "dangling.ts");
    await symlink(join(workspace, "src", "gone.ts"), dangling);
    const outsideLink = join(workspace, "src", "outside-link.ts");
    await symlink(join(outside, "secret.ts"), outsideLink);
    await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
    const tools = createWorkspaceTools({ workspace });
    const remove = executableTool(tools, "delete_file");

    await remove({ path: "src/dangling.ts" }, executionOptions);
    await expect(lstat(dangling)).rejects.toMatchObject({ code: "ENOENT" });

    await remove({ path: "src/outside-link.ts" }, executionOptions);
    await expect(lstat(outsideLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outside, "secret.ts"), "utf8")).resolves.toBe(
      "secret\n"
    );
  });

  it("force-kills commands that ignore SIGTERM", async () => {
    const tools = createWorkspaceTools({ workspace });
    const shell = executableTool(tools, "shell_execute");
    const startedAt = Date.now();
    const output = String(
      await shell(
        { command: "trap '' TERM; sleep 30", timeout_seconds: 1 },
        executionOptions
      )
    );
    expect(output).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 20_000);

  it("withholds provider API keys from shell commands", async () => {
    process.env.AI_API_KEY = "pss-test-secret";
    process.env.azure_openai_api_key = "pss-test-secret-2";
    process.env.INTEGRATION_SERVICE_TOKEN = "pss-test-token-kept";
    try {
      const tools = createWorkspaceTools({ workspace });
      const shell = executableTool(tools, "shell_execute");
      const output = String(
        await shell(
          {
            command:
              "echo $AI_API_KEY $azure_openai_api_key $INTEGRATION_SERVICE_TOKEN",
          },
          executionOptions
        )
      );
      expect(output).not.toContain("pss-test-secret");
      expect(output).toContain("pss-test-token-kept");
    } finally {
      delete process.env.AI_API_KEY;
      delete process.env.azure_openai_api_key;
      delete process.env.INTEGRATION_SERVICE_TOKEN;
    }
  });
});
