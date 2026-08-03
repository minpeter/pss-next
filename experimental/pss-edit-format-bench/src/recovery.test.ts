import { describe, expect, it } from "vitest";
import { pssFormat } from "./formats";
import {
  type RecoveryModelCall,
  type RecoveryModelCaller,
  runWithRecovery,
} from "./recovery";
import { EDIT_TASKS, type EditTask } from "./tasks";

const task = EDIT_TASKS.find((t) => t.id === "single-line-to-two") as EditTask;
const LINE_TWO_ANCHOR = /^2#[A-Z]{2}\|/mu;

const caller = (replies: readonly string[]): RecoveryModelCaller => {
  let index = 0;
  return () => {
    const reply = replies[Math.min(index, replies.length - 1)] as string;
    index += 1;
    return Promise.resolve({ text: reply });
  };
};

const firstPassReply = (): string => {
  const rendered = pssFormat.render(task.path, task.initial).user;
  const anchor = LINE_TWO_ANCHOR.exec(rendered)?.[0].split("|")[0] as string;
  return JSON.stringify({
    path: task.path,
    edits: [
      {
        op: "replace",
        target: anchor,
        new_content: ['    greeting = "Hi"', '    msg = f"{greeting}, {name}"'],
      },
    ],
  });
};

const recoveryOptions = (replies: readonly string[]) => ({
  apply: (reply: string, initial: string, path?: string) =>
    pssFormat.apply(reply, initial, path),
  callModel: caller(replies),
  expected: task.expected,
  initial: task.initial,
  maxAttempts: 3,
  path: task.path,
  renderFile: (path: string, content: string) =>
    pssFormat.render(path, content).user,
  toolName: "pss-json",
  userPrompt: `${pssFormat.render(task.path, task.initial).user}\n\nTask: ${task.instruction}`,
});

describe("runWithRecovery", () => {
  it("passes on the first attempt and reports attemptsUsed 1", async () => {
    const outcome = await runWithRecovery(recoveryOptions([firstPassReply()]));
    expect(outcome.recovered).toBe(true);
    expect(outcome.attemptsUsed).toBe(1);
    expect(outcome.firstAttemptFailed).toBe(false);
    expect(outcome.errorSequence).toEqual([]);
  });

  it("recovers after a malformed reply by feeding back the error", async () => {
    const outcome = await runWithRecovery(
      recoveryOptions(["not json at all", firstPassReply()])
    );
    expect(outcome.recovered).toBe(true);
    expect(outcome.attemptsUsed).toBe(2);
    expect(outcome.firstAttemptFailed).toBe(true);
    expect(outcome.errorSequence.length).toBe(1);
    expect(outcome.errorSequence[0]).toBe("unparsable");
  });

  it("does not recover when the model repeats the same mistake", async () => {
    const outcome = await runWithRecovery(
      recoveryOptions(["bad reply", "bad reply", "bad reply"])
    );
    expect(outcome.recovered).toBe(false);
    expect(outcome.attemptsUsed).toBe(3);
    expect(outcome.firstAttemptFailed).toBe(true);
    expect(outcome.errorSequence.length).toBe(3);
  });

  it("classifies a repeated error sequence as repeatedFailure", async () => {
    const outcome = await runWithRecovery(
      recoveryOptions(["bad reply", "bad reply", "bad reply"])
    );
    expect(outcome.repeatedFailure).toBe(true);
  });

  it("feeds the raw tool error back, not an oracle message", async () => {
    const seen: RecoveryModelCall[][] = [];
    let replyIndex = 0;
    const capture = ((messages) => {
      seen.push([...messages]);
      const reply = ["not json at all", firstPassReply()][
        Math.min(replyIndex, 1)
      ] as string;
      replyIndex += 1;
      return Promise.resolve({ text: reply });
    }) as RecoveryModelCaller;
    await runWithRecovery({
      ...recoveryOptions([]),
      callModel: capture,
    });
    const second = seen[1] as readonly RecoveryModelCall[];
    const tool = second.find((message) => message.role === "tool") as
      | { readonly output: string; readonly role: "tool" }
      | undefined;
    expect(tool).toBeDefined();
    expect(tool?.output).toBe("No JSON object in reply");
    expect(tool?.output?.toLowerCase()).not.toContain(
      "does not match the intended change"
    );
    expect(tool?.output).not.toContain("Re-read the file and retry");
  });

  it("feeds the OK diff block back when the edit applied but missed", async () => {
    const rendered = pssFormat.render(task.path, task.initial).user;
    const anchor = LINE_TWO_ANCHOR.exec(rendered)?.[0].split("|")[0] as string;
    const wrongButParsable = JSON.stringify({
      path: task.path,
      edits: [
        {
          op: "replace",
          target: anchor,
          new_content: ["    wrong content"],
        },
      ],
    });
    const seen: RecoveryModelCall[][] = [];
    let replyIndex = 0;
    const capture = ((messages) => {
      seen.push([...messages]);
      const reply = [wrongButParsable, firstPassReply()][
        Math.min(replyIndex, 1)
      ] as string;
      replyIndex += 1;
      return Promise.resolve({ text: reply });
    }) as RecoveryModelCaller;
    await runWithRecovery({
      ...recoveryOptions([]),
      callModel: capture,
    });
    const second = seen[1] as readonly RecoveryModelCall[];
    const tool = second.find((message) => message.role === "tool") as
      | { readonly output: string; readonly role: "tool" }
      | undefined;
    expect(tool).toBeDefined();
    expect(tool?.output).toContain("OK - edited file");
    expect(tool?.output).toContain("diff:");
    expect(tool?.output?.toLowerCase()).not.toContain(
      "does not match the intended change"
    );
  });

  it("appends the current file state when the edit applied but missed", async () => {
    const rendered = pssFormat.render(task.path, task.initial).user;
    const anchor = LINE_TWO_ANCHOR.exec(rendered)?.[0].split("|")[0] as string;
    const wrongButParsable = JSON.stringify({
      path: task.path,
      edits: [
        {
          op: "replace",
          target: anchor,
          new_content: ["    wrong content"],
        },
      ],
    });
    const seen: RecoveryModelCall[][] = [];
    let replyIndex = 0;
    const capture = ((messages) => {
      seen.push([...messages]);
      const reply = [wrongButParsable, firstPassReply()][
        Math.min(replyIndex, 1)
      ] as string;
      replyIndex += 1;
      return Promise.resolve({ text: reply });
    }) as RecoveryModelCaller;
    await runWithRecovery({
      ...recoveryOptions([]),
      callModel: capture,
    });
    const second = seen[1] as readonly RecoveryModelCall[];
    const tool = second.find((message) => message.role === "tool") as
      | { readonly output: string; readonly role: "tool" }
      | undefined;
    expect(tool).toBeDefined();
    // the edited file state (with the wrong content) must be visible to the model
    expect(tool?.output).toContain("    wrong content");
    expect(tool?.output).toContain("OK - file\npath: greet.py");
  });

  it("applies retries against the accumulated file state", async () => {
    // attempt 1: valid edit that produces a wrong intermediate state
    const rendered = pssFormat.render(task.path, task.initial).user;
    const anchor2 = LINE_TWO_ANCHOR.exec(rendered)?.[0].split("|")[0] as string;
    const wrongButApplied = JSON.stringify({
      path: task.path,
      edits: [
        {
          op: "replace",
          target: anchor2,
          new_content: ['    greeting = "Wrong"'],
        },
      ],
    });
    // attempt 2: the correct edit, anchored against the POST-attempt-1 file.
    // Applying it to the ORIGINAL file would reject its anchor as stale.
    const state1 = pssFormat.apply(wrongButApplied, task.initial, task.path)
      .text as string;
    const state1Render = pssFormat.render(task.path, state1).user;
    const state1Anchor2 = LINE_TWO_ANCHOR.exec(state1Render)?.[0].split(
      "|"
    )[0] as string;
    const corrected = JSON.stringify({
      path: task.path,
      edits: [
        {
          op: "replace",
          target: state1Anchor2,
          new_content: [
            '    greeting = "Hi"',
            '    msg = f"{greeting}, {name}"',
          ],
        },
      ],
    });

    const outcome = await runWithRecovery(
      recoveryOptions([wrongButApplied, corrected])
    );
    expect(outcome.recovered).toBe(true);
    expect(outcome.attemptsUsed).toBe(2);
  });
});
