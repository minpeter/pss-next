import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  type AgenticToolEvent,
  buildAgenticPrompt,
  buildAgenticSystemPrompt,
  summarizeToolEvents,
} from "./agentic";
import { createAgenticTraceWriter } from "./agentic-trace";
import { EDIT_TASKS } from "./tasks";

const task = EDIT_TASKS.find((item) => item.id === "single-line-to-two");
if (task === undefined) {
  throw new Error("fixture task missing");
}

describe("agentic pss harness", () => {
  it("does not preload the file contents into the task prompt", () => {
    const prompt = buildAgenticPrompt(task);

    expect(prompt).toContain(`Target file: ${task.path}`);
    expect(prompt).toContain(task.instruction);
    expect(prompt).not.toContain("OK - file");
    expect(prompt).not.toContain("file_hash:");
  });

  it("instructs the model to call tools instead of printing JSON", () => {
    const system = buildAgenticSystemPrompt();

    expect(system).toContain("Use read_file and edit_file as actual tools");
    expect(system).toContain("never print edit JSON as plain text");
    expect(system).toContain(
      "For replace, use target for one line OR first and last for a range; never combine them."
    );
    expect(system).toContain(
      "The score compares the entire workspace byte-for-byte"
    );
    expect(system).not.toContain("Call edit_file by emitting one JSON object");
  });

  it("counts a read, failed edit, and later successful recovery", () => {
    const events: readonly AgenticToolEvent[] = [
      {
        inputJson: '{"path":"greet.py"}',
        name: "read_file",
        output: "OK - file",
      },
      {
        error: "Stale anchor",
        inputJson: "{}",
        name: "edit_file",
        output: "ERROR - Stale anchor",
      },
      {
        fileAfter: task.expected,
        inputJson: "{}",
        name: "edit_file",
        output: "OK - edited file",
      },
    ];

    expect(summarizeToolEvents(events, task.expected)).toEqual({
      editCalls: 2,
      editSuccesses: 1,
      failureKind: undefined,
      firstEditPassed: false,
      passed: true,
      readCalls: 1,
      recovered: true,
      toolStatus: "succeeded",
      verificationStatus: "passed",
    });
  });

  it("marks a later correct edit as recovery", () => {
    const events: readonly AgenticToolEvent[] = [
      {
        fileAfter: "wrong state\n",
        inputJson: "{}",
        name: "edit_file",
        output: "OK - edited file",
      },
      {
        inputJson: '{"path":"greet.py"}',
        name: "read_file",
        output: "OK - file",
      },
      {
        fileAfter: task.expected,
        inputJson: "{}",
        name: "edit_file",
        output: "OK - edited file",
      },
    ];

    expect(summarizeToolEvents(events, task.expected).recovered).toBe(true);
  });

  it("separates tool execution from exact verification", () => {
    const summary = summarizeToolEvents(
      [
        {
          fileAfter: `${task.expected}\n`,
          inputJson: "{}",
          name: "edit_file",
          output: "OK - edited file",
        },
      ],
      task.expected
    );

    expect(summary).toMatchObject({
      failureKind: "verification-failed",
      toolStatus: "succeeded",
      verificationStatus: "failed",
    });
  });

  it("appends raw trace events in occurrence order", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-agentic-trace-test-"));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    const path = join(root, "trace.jsonl");
    const writeEvent = createAgenticTraceWriter(path);

    await writeEvent({
      requestAttempt: 1,
      run: 1,
      task: task.id,
      timestampMs: 1,
      type: "attempt_started",
    });
    await writeEvent({
      inputJson: '{"path":"greet.py"}',
      name: "read_file",
      requestAttempt: 1,
      run: 1,
      task: task.id,
      timestampMs: 2,
      type: "tool_call",
    });

    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly type: string });
    expect(events.map((event) => event.type)).toEqual([
      "attempt_started",
      "tool_call",
    ]);
  });
});
