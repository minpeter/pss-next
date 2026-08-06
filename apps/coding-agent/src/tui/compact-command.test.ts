import type { AgentOptions } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { compactCurrentThread, createCompactCommand } from "./compact-command";

describe("/compact", () => {
  it("compacts the current thread and reports the affected history", async () => {
    const compact = vi.fn(() => Promise.resolve({ compactedMessages: 12 }));

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Compacted 12 conversation messages.",
      success: true,
    });
    expect(compact).toHaveBeenCalledOnce();
  });

  it("turns runtime failures into a command result", async () => {
    const compact = vi.fn(() => Promise.reject(new Error("history is empty")));

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Compaction failed: history is empty",
      success: false,
    });
  });
});

describe("compactCurrentThread", () => {
  it("summarizes the full durable history before committing the prefix", async () => {
    const history = [
      { content: "question", role: "user" as const },
      { content: "answer", role: "assistant" as const },
    ];
    const summarize = vi.fn(() => Promise.resolve("continuation handoff"));
    const commit = vi.fn(() => Promise.resolve());
    const model = {} as AgentOptions["model"];

    await expect(
      compactCurrentThread({
        commit,
        history,
        instructions: "coding rules",
        model,
        summarize,
      })
    ).resolves.toEqual({ compactedMessages: 2 });
    expect(summarize).toHaveBeenCalledWith({
      history,
      model: { instructions: "coding rules", model },
    });
    expect(commit).toHaveBeenCalledWith({
      endSeqExclusive: 2,
      startSeq: 0,
      summary: "continuation handoff",
    });
  });

  it("rejects empty sessions without spending a model call", async () => {
    const summarize = vi.fn(() => Promise.resolve("unused"));
    const commit = vi.fn(() => Promise.resolve());

    await expect(
      compactCurrentThread({
        commit,
        history: [],
        instructions: "coding rules",
        model: {} as AgentOptions["model"],
        summarize,
      })
    ).rejects.toThrow("no conversation history");
    expect(summarize).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});
