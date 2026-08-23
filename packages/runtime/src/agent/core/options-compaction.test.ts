import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createCallbackModel } from "../../testing/test-fixtures";
import type { AgentCompaction } from "../../thread/runtime/auto-compaction-types";
import { Agent, createAgent } from "./agent";
import { assertAgentOptions } from "./options";

describe("AgentOptions.compaction", () => {
  it("rejects non-functions", () => {
    const options: unknown = {
      compaction: {},
      model: createCallbackModel(() => []),
    };

    expect(() => assertAgentOptions(options)).toThrow(
      "Agent: options.compaction must be a function."
    );
  });

  it("rejects a function with a non-function maxInputTokens property", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, { maxInputTokens: 1 }),
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction.maxInputTokens must be a function.");
  });

  it("rejects a function with a non-function deadlineMs property", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, { deadlineMs: 5000 }),
        model: createCallbackModel(() => []),
      })
    ).toThrow("Agent: options.compaction.deadlineMs must be a function.");
  });

  it("rejects a function with an invalid onOverflow property", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, { onOverflow: "retry" }),
        model: createCallbackModel(() => []),
      })
    ).toThrow(
      'Agent: options.compaction.onOverflow must be "compact" or "error".'
    );
  });

  it("accepts a function carrying budget properties", () => {
    expect(() =>
      assertAgentOptions({
        compaction: Object.assign(() => undefined, {
          deadlineMs: () => 5000,
          maxInputTokens: () => 1,
          onOverflow: "error",
        }),
        model: createCallbackModel(() => []),
      })
    ).not.toThrow();
  });

  it("reads a compaction option getter only once", () => {
    const compaction: AgentCompaction = () => undefined;
    const options = {
      model: createCallbackModel(() => []),
    };
    let reads = 0;
    Object.defineProperty(options, "compaction", {
      get: () => {
        reads += 1;
        return reads === 1 ? compaction : {};
      },
    });

    expect(() => new Agent(options)).not.toThrow();
    expect(reads).toBe(1);
  });

  it("reads a tools option getter only once", () => {
    const options = {
      model: createCallbackModel(() => []),
    };
    let reads = 0;
    Object.defineProperty(options, "tools", {
      get: () => {
        reads += 1;
        return reads === 1 ? {} : { x: { needsApproval: true } };
      },
    });

    expect(() => new Agent(options)).not.toThrow();
    expect(reads).toBe(1);
  });

  it("rejects an invalid first compaction value without rereading", () => {
    const compaction: AgentCompaction = () => undefined;
    const options = {
      model: createCallbackModel(() => []),
    };
    let reads = 0;
    Object.defineProperty(options, "compaction", {
      get: () => {
        reads += 1;
        return reads === 1 ? {} : compaction;
      },
    });

    expect(() => new Agent(options)).toThrow();
    expect(reads).toBe(1);
  });

  it("rejects unsafe first tools without rereading", () => {
    const options = {
      model: createCallbackModel(() => []),
    };
    let reads = 0;
    Object.defineProperty(options, "tools", {
      get: () => {
        reads += 1;
        return reads === 1 ? { x: { needsApproval: true } } : {};
      },
    });

    expect(() => new Agent(options)).toThrow();
    expect(reads).toBe(1);
  });

  it("reads nested compaction capabilities once in Agent", () => {
    const compaction: AgentCompaction = () => undefined;
    let reads = 0;
    Object.defineProperty(compaction, "maxInputTokens", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("NESTED_SECRET_SENTINEL");
        }
        return () => 100;
      },
    });

    expect(
      () =>
        new Agent({
          compaction,
          model: createCallbackModel(() => []),
        })
    ).not.toThrow();
    expect(reads).toBe(1);
  });

  it("reads nested compaction capabilities once in createAgent", async () => {
    const compaction: AgentCompaction = () => undefined;
    let reads = 0;
    Object.defineProperty(compaction, "maxInputTokens", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("NESTED_SECRET_SENTINEL");
        }
        return () => 100;
      },
    });

    await expect(
      createAgent({
        compaction,
        model: createCallbackModel(() => []),
      })
    ).resolves.toBeInstanceOf(Agent);
    expect(reads).toBe(1);
  });

  it("enumerates a tools proxy once in createAgent", async () => {
    let reads = 0;
    const tools = new Proxy(
      {},
      {
        ownKeys: () => {
          reads += 1;
          if (reads > 1) {
            throw new Error("SECOND_READ_SECRET_SENTINEL");
          }
          return [];
        },
      }
    );

    await expect(
      createAgent({
        model: createCallbackModel(() => []),
        tools,
      })
    ).resolves.toBeInstanceOf(Agent);
    expect(reads).toBe(1);
  });

  it("reads each tools proxy descriptor once in createAgent", async () => {
    let reads = 0;
    const tools = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          reads += 1;
          if (reads > 1) {
            throw new Error("DESCRIPTOR_SECOND_SENTINEL");
          }
          return {
            configurable: true,
            enumerable: true,
            value: { execute: () => "safe" },
          };
        },
        ownKeys: () => ["x"],
      }
    );

    await expect(
      createAgent({
        model: createCallbackModel(() => []),
        tools,
      })
    ).resolves.toBeInstanceOf(Agent);
    expect(reads).toBe(1);
  });

  it("checks each tool approval capability once in createAgent", async () => {
    let reads = 0;
    const toolDefinition = new Proxy(
      tool({
        execute: () => "safe",
        inputSchema: jsonSchema({ type: "object" }),
      }),
      {
        has: (target, property) => {
          if (property === "needsApproval") {
            reads += 1;
            if (reads > 1) {
              throw new Error("SECOND_READ_SECRET_SENTINEL");
            }
          }
          return Reflect.has(target, property);
        },
      }
    );

    await expect(
      createAgent({
        model: createCallbackModel(() => []),
        tools: { x: toolDefinition },
      })
    ).resolves.toBeInstanceOf(Agent);
    expect(reads).toBe(1);
  });
});
