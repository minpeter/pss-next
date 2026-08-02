import { describe, expect, it } from "vitest";
import {
  runWithRecovery,
  type RecoveryModelCaller,
} from "./recovery";
import { pssFormat } from "./formats";
import { EDIT_TASKS, type EditTask } from "./tasks";

const task = EDIT_TASKS.find((t) => t.id === "single-line-to-two") as EditTask;

const caller = (replies: readonly string[]): RecoveryModelCaller => {
  let index = 0;
  return async () => {
    const reply = replies[Math.min(index, replies.length - 1)] as string;
    index += 1;
    return { text: reply };
  };
};

const firstPassReply = (): string => {
  const rendered = pssFormat.render(task.path, task.initial).user;
  const anchor = /^2#[A-Z]{2}\|/mu.exec(rendered)?.[0].split("|")[0] as string;
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
  apply: (reply: string, initial: string) => pssFormat.apply(reply, initial),
  callModel: caller(replies),
  expected: task.expected,
  initial: task.initial,
  maxAttempts: 3,
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
});
