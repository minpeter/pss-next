import { jsonSchema, type ToolSet, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoopTool,
  drainRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  loadModelStepRunner,
} from "../testing/llm-test-utils";
import { assistantMessage } from "../testing/test-fixtures";
import { encodeRuntimeAttachmentData } from "../thread/input/attachments";
import { ModelToolSelectionError } from "./model-step-error";

const generateTextMock = getGenerateTextMock();
const unsupportedApprovalPattern = /needsApproval.*not supported/;
const sha256FingerprintPattern = /sha256:[0-9a-f]{64}/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("generateModelStep", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes injected tools to generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];

    await expect(
      runModelStep(
        {
          instructions: "test instructions",
          model: fakeModel,
          tools: injectedTools,
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: signal,
        instructions: "test instructions",
        messages: history,
        model: fakeModel,
        tools: expect.objectContaining({
          injected: expect.any(Object),
        }),
      })
    );
  });

  it("hoists system history into instructions for provider-compatible prompts", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const messages = [{ role: "user" as const, content: "tail" }];

    await expect(
      runModelStep(
        {
          instructions: "base",
          model: fakeModel,
        },
        {
          history: [
            { role: "system", content: "compacted context" },
            ...messages,
          ],
          signal,
        }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "base\n\ncompacted context",
        messages,
      })
    );
  });

  it("snapshots history without invoking a custom iterator", async () => {
    const runModelStep = await loadModelStepRunner();
    const history = [{ role: "user" as const, content: "hello" }];
    const iterator = vi.fn(() => {
      throw new Error("history iterator must stay inert");
    });
    Object.defineProperty(history, Symbol.iterator, {
      configurable: true,
      value: iterator,
    });

    await expect(
      runModelStep(
        {
          model: fakeModel,
          prepareModelStep: ({ history: callbackHistory }) => {
            expect(callbackHistory).toEqual([
              { role: "user", content: "hello" },
            ]);
          },
        },
        {
          history,
          signal: new AbortController().signal,
          threadKey: "thread",
        }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(iterator).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "hello" }],
      })
    );
  });

  it.each([
    ["sparse", new Array(1), undefined],
    [
      "accessor-backed",
      (() => {
        const getter = vi.fn(() => ({ role: "user", content: "secret" }));
        const value: unknown[] = [];
        Object.defineProperty(value, "0", { get: getter });
        return value;
      })(),
      "getter",
    ],
  ])(
    "rejects %s history before selection or generation",
    async (_label, history, getterMarker) => {
      const runModelStep = await loadModelStepRunner();
      const prepareModelStep = vi.fn();

      await expect(
        runModelStep(
          { model: fakeModel, prepareModelStep },
          {
            history: history as never,
            signal: new AbortController().signal,
            threadKey: "thread",
          }
        )
      ).rejects.toThrow("dense array of data-property model messages");
      if (getterMarker) {
        const descriptor = Object.getOwnPropertyDescriptor(history, "0");
        expect(descriptor?.get).not.toHaveBeenCalled();
      }
      expect(prepareModelStep).not.toHaveBeenCalled();
      expect(generateTextMock).not.toHaveBeenCalled();
    }
  );

  it("lowers typed compaction context to a user-scoped summary", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const userProtocolLiteral = "<tool_call>literal user text</tool_call>";
    const selectorHistories: unknown[] = [];

    await expect(
      runModelStep(
        {
          instructions: "base",
          model: fakeModel,
          prepareModelStep: ({ history }) => {
            selectorHistories.push(history);
          },
        },
        {
          history: [
            {
              endSeqExclusive: 4,
              role: "compaction",
              startSeq: 0,
              summary: "old turns summarized",
            },
            { content: userProtocolLiteral, role: "user" },
          ],
          signal,
          threadKey: "thread-1",
        }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "base",
        messages: [
          {
            content:
              "The conversation history before this point was compacted into the following summary:\n<summary>\nold turns summarized\n</summary>",
            role: "user",
          },
          { content: userProtocolLiteral, role: "user" },
        ],
      })
    );
    expect(selectorHistories).toEqual([
      [
        {
          endSeqExclusive: 4,
          role: "compaction",
          startSeq: 0,
          summary: "old turns summarized",
        },
        { content: userProtocolLiteral, role: "user" },
      ],
    ]);
  });

  it("passes configured toolChoice to generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];

    await expect(
      runModelStep(
        {
          model: fakeModel,
          toolChoice: "required",
          tools: { required_tool: createNoopTool() },
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: "required",
      })
    );
  });

  it("passes a configured named toolChoice to generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const tools = { injected: createNoopTool() } satisfies ToolSet;
    const toolChoice = { type: "tool", toolName: "injected" } as const;

    await expect(
      runModelStep(
        {
          model: fakeModel,
          toolChoice,
          tools,
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice,
      })
    );
  });

  it("uses alphabetical tool order by default", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const tools = {
      zeta: createNoopTool(),
      alpha: createNoopTool(),
    } satisfies ToolSet;

    await runModelStep({ model: fakeModel, tools }, { history: [], signal });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["alpha", "zeta"],
        toolOrder: ["alpha", "zeta"],
      })
    );
  });

  it("keeps always-active tools as a canonical prefix before dynamic tools", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "system" as const, content: "summary" }];
    const tools = {
      zeta: createNoopTool(),
      always_b: createNoopTool(),
      dynamic_b: createNoopTool(),
      always_a: createNoopTool(),
      dynamic_a: createNoopTool(),
    } satisfies ToolSet;
    const seen: unknown[] = [];

    await runModelStep(
      {
        alwaysActiveTools: ["always_b", "always_a"],
        model: fakeModel,
        prepareModelStep: (input) => {
          seen.push(input);
          return {
            activeTools: ["zeta", "dynamic_a"],
            toolChoice: { type: "tool", toolName: "dynamic_a" },
          };
        },
        toolChoice: "required",
        toolOrder: ["always_a", "dynamic_a", "always_b"],
        tools,
      },
      {
        history,
        runtimeStepIndex: 7,
        signal,
        threadKey: "thread-secret",
      }
    );

    expect(seen).toEqual([
      expect.objectContaining({
        history,
        runtimeStepIndex: 7,
        signal,
        threadKey: "thread-secret",
        tools: expect.objectContaining({
          zeta: expect.objectContaining({ description: "No-op test tool." }),
        }),
      }),
    ]);
    expect(
      Object.isFrozen((seen[0] as { readonly tools: ToolSet }).tools)
    ).toBe(true);
    const callbackTool = (seen[0] as { readonly tools: ToolSet }).tools
      .dynamic_a;
    expect(callbackTool).not.toBe(tools.dynamic_a);
    expect(Object.isFrozen(callbackTool)).toBe(true);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["always_a", "always_b", "dynamic_a", "zeta"],
        toolChoice: { type: "tool", toolName: "dynamic_a" },
        toolOrder: ["always_a", "always_b", "dynamic_a", "zeta"],
      })
    );
    const generatedTools = generateTextMock.mock.calls.at(-1)?.[0]?.tools;
    expect(Object.keys(generatedTools ?? {})).toEqual([
      "always_a",
      "always_b",
      "dynamic_a",
      "zeta",
    ]);
    expect(generatedTools).not.toHaveProperty("dynamic_b");
  });

  it("isolates callback history and tool-facade mutations", async () => {
    const runModelStep = await loadModelStepRunner();
    const history = [{ content: "original prompt", role: "user" as const }];
    const activeTool = tool({
      description: "original description",
      execute: () => ({}),
      inputSchema: jsonSchema({
        additionalProperties: false,
        properties: {},
        type: "object",
      }),
      providerOptions: { example: { mode: "original" } },
    });

    await runModelStep(
      {
        model: fakeModel,
        prepareModelStep: (input) => {
          const callbackHistory = input.history as Array<{
            content: string;
            role: "user";
          }>;
          const firstMessage = callbackHistory[0];
          if (!firstMessage) {
            throw new TypeError("Expected callback history.");
          }
          firstMessage.content = "mutated prompt";
          const callbackTool = input.tools.active as unknown as {
            description: string;
            providerOptions: { example: { mode: string } };
          };
          try {
            callbackTool.description = "mutated description";
          } catch {
            // The frozen metadata facade rejects top-level mutation.
          }
          try {
            callbackTool.providerOptions.example.mode = "mutated";
          } catch {
            // Nested callback metadata is frozen as well.
          }
          return { activeTools: ["active"] };
        },
        tools: { active: activeTool },
      },
      {
        history,
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );

    expect(history[0]?.content).toBe("original prompt");
    expect(activeTool.description).toBe("original description");
    expect(activeTool.providerOptions).toEqual({
      example: { mode: "original" },
    });
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ content: "original prompt", role: "user" }],
        tools: expect.objectContaining({
          active: expect.objectContaining({
            description: "original description",
            providerOptions: { example: { mode: "original" } },
          }),
        }),
      })
    );
  });

  it("uses inert frozen snapshots for non-cloneable callback tool metadata", async () => {
    const runModelStep = await loadModelStepRunner();
    const description = vi.fn(() => "dynamic description");
    const execute = vi.fn(() => ({}));
    const locked = Object.freeze({ mode: "locked" });
    const providerOptions = {
      callback: () => "must not run",
      nested: { mode: "original" },
    } as Record<string, unknown>;
    Object.defineProperty(providerOptions, "locked", {
      configurable: false,
      enumerable: true,
      value: locked,
      writable: false,
    });
    let mutationRejected = false;

    await runModelStep(
      {
        model: fakeModel,
        prepareModelStep: (input) => {
          const callbackTool = input.tools.active as unknown as {
            description: () => string;
            execute: () => unknown;
            providerOptions: {
              locked: { mode: string };
              nested: { mode: string };
            };
          };
          expect(callbackTool.providerOptions.locked.mode).toBe("locked");
          try {
            callbackTool.providerOptions.nested.mode = "mutated";
          } catch {
            mutationRejected = true;
          }
          expect(() => callbackTool.description()).toThrow(
            "do not expose callable members"
          );
          expect(() => callbackTool.execute()).toThrow(
            "do not expose callable members"
          );
          return { activeTools: ["active"] };
        },
        tools: {
          active: tool({
            description,
            execute,
            inputSchema: jsonSchema({ type: "object" }),
            providerOptions: providerOptions as never,
          }),
        },
      },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );

    expect(mutationRejected).toBe(true);
    expect(providerOptions.nested).toEqual({ mode: "original" });
    expect(description).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not invoke registry or tool-definition accessors", async () => {
    const runModelStep = await loadModelStepRunner();
    const registryGetter = vi.fn(() => createNoopTool());
    const registry = {} as ToolSet;
    Object.defineProperty(registry, "accessor_tool", {
      enumerable: true,
      get: registryGetter,
    });

    await expect(
      runModelStep(
        { model: fakeModel, tools: registry },
        { history: [], signal: new AbortController().signal }
      )
    ).rejects.toThrow("must be a data property");
    expect(registryGetter).not.toHaveBeenCalled();

    const definitionGetter = vi.fn(() => ({ mode: "unsafe" }));
    const definition = {
      description: "safe definition",
    } as Record<string, unknown>;
    Object.defineProperty(definition, "providerOptions", {
      enumerable: true,
      get: definitionGetter,
    });
    const diagnostics: unknown[] = [];
    await runModelStep(
      {
        diagnostics: {
          report: (event) => {
            diagnostics.push(event);
          },
        },
        model: fakeModel,
        prepareModelStep: ({ tools }) => {
          expect(tools.accessor_tool).not.toHaveProperty("providerOptions");
          return { activeTools: ["accessor_tool"] };
        },
        tools: {
          accessor_tool: definition as unknown as ToolSet[string],
        },
      },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(definitionGetter).not.toHaveBeenCalled();
    expect(diagnostics[0]).toMatchObject({
      metadata: { semanticFingerprintUnavailableToolCount: 1 },
    });
  });

  it("fails closed when model history is not structured-cloneable", async () => {
    const runModelStep = await loadModelStepRunner();
    const prepareModelStep = vi.fn();

    await expect(
      runModelStep(
        { model: fakeModel, prepareModelStep },
        {
          history: [
            {
              content: "hello",
              nonCloneable: () => undefined,
              role: "user",
            } as never,
          ],
          signal: new AbortController().signal,
          threadKey: "thread",
        }
      )
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(prepareModelStep).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("treats an empty dynamic selection as only always-active tools", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;

    await runModelStep(
      {
        alwaysActiveTools: ["always"],
        model: fakeModel,
        prepareModelStep: () => ({ activeTools: [] }),
        tools: {
          dynamic: createNoopTool(),
          always: createNoopTool(),
        },
      },
      { history: [], signal, threadKey: "thread" }
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["always"],
        toolOrder: ["always"],
      })
    );
    const generatedTools = generateTextMock.mock.calls.at(-1)?.[0]?.tools;
    expect(Object.keys(generatedTools ?? {})).toEqual(["always"]);
    expect(generatedTools).not.toHaveProperty("dynamic");
  });

  it("copies callback-owned selections before passing them to AI SDK", async () => {
    const runModelStep = await loadModelStepRunner();
    const activeTools = ["dynamic"];
    const toolChoice: { toolName: string; type: "tool" } = {
      toolName: "dynamic",
      type: "tool",
    };

    await runModelStep(
      {
        model: fakeModel,
        prepareModelStep: () => ({ activeTools, toolChoice }),
        tools: { dynamic: createNoopTool() },
      },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );
    activeTools.push("mutated-after-return");
    toolChoice.toolName = "mutated-after-return";

    const call = generateTextMock.mock.calls.at(-1)?.[0];
    expect(call?.activeTools).toEqual(["dynamic"]);
    expect(call?.toolChoice).toEqual({
      toolName: "dynamic",
      type: "tool",
    });
  });

  it("rejects accessor-backed active-tool indices without invoking them", async () => {
    const runModelStep = await loadModelStepRunner();
    const indexGetter = vi.fn(() => "dynamic");
    const activeTools: string[] = [];
    Object.defineProperty(activeTools, "0", {
      enumerable: true,
      get: indexGetter,
    });

    await expect(
      runModelStep(
        {
          model: fakeModel,
          prepareModelStep: () => ({ activeTools }),
          tools: { dynamic: createNoopTool() },
        },
        {
          history: [],
          signal: new AbortController().signal,
          threadKey: "thread",
        }
      )
    ).rejects.toThrow("dense array of data-property tool names");
    expect(indexGetter).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("requires a real thread key only when model-step preparation runs", async () => {
    const runModelStep = await loadModelStepRunner();
    const get = vi.fn();
    const estimateTokens = vi.fn(() => 0);

    await expect(
      runModelStep(
        {
          attachmentStore: {
            delete: vi.fn(),
            get,
            put: vi.fn(),
          } as never,
          contextGate: {
            estimateTokens,
            maxInputTokens: 100,
          },
          model: fakeModel,
          prepareModelStep: () => ({ activeTools: [] }),
        },
        {
          history: [
            {
              content: [
                {
                  data: encodeRuntimeAttachmentData({
                    id: "must-not-hydrate",
                    schemaVersion: 1,
                  }),
                  mediaType: "application/octet-stream",
                  type: "file",
                },
              ],
              role: "user",
            },
          ],
          signal: new AbortController().signal,
        }
      )
    ).rejects.toThrow("prepareModelStep requires a runtime threadKey");
    expect(get).not.toHaveBeenCalled();
    expect(estimateTokens).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an array callback result",
      prepareModelStep: () => [] as never,
      toolChoice: undefined,
    },
    {
      label: "a null callback result",
      prepareModelStep: () => null as never,
      toolChoice: undefined,
    },
    {
      label: "an array model override",
      prepareModelStep: () => ({ model: [] }) as never,
      toolChoice: undefined,
    },
    {
      label: "a malformed model override",
      prepareModelStep: () => ({ model: {} }) as never,
      toolChoice: undefined,
    },
    {
      label: "a malformed tool choice",
      prepareModelStep: () => ({ toolChoice: { type: "bogus" } }) as never,
      toolChoice: undefined,
    },
    {
      label: "a null prepared tool choice",
      prepareModelStep: () => ({ toolChoice: null }) as never,
      toolChoice: undefined,
    },
    {
      label: "an inherited result selection",
      prepareModelStep: () =>
        Object.create({ activeTools: ["dynamic"] }) as never,
      toolChoice: undefined,
    },
    {
      label: "an unknown callback-result field",
      prepareModelStep: () => ({ activeTool: ["dynamic"] }) as never,
      toolChoice: undefined,
    },
    {
      label: "an inherited named tool choice",
      prepareModelStep: () => ({
        toolChoice: Object.create({ type: "tool", toolName: "always" }),
      }),
      toolChoice: undefined,
    },
    {
      label: "duplicate dynamic tools",
      prepareModelStep: () => ({ activeTools: ["dynamic", "dynamic"] }),
      toolChoice: undefined,
    },
    {
      label: "unknown dynamic tools",
      prepareModelStep: () => ({ activeTools: ["missing"] }),
      toolChoice: undefined,
    },
    {
      label: "always-active overlap",
      prepareModelStep: () => ({ activeTools: ["always"] }),
      toolChoice: undefined,
    },
    {
      label: "inactive named tool choice",
      prepareModelStep: () => ({ activeTools: [] }),
      toolChoice: { type: "tool" as const, toolName: "dynamic" },
    },
  ])("fails closed for $label", async ({ prepareModelStep, toolChoice }) => {
    const runModelStep = await loadModelStepRunner();

    await expect(
      runModelStep(
        {
          alwaysActiveTools: ["always"],
          model: fakeModel,
          prepareModelStep,
          toolChoice,
          tools: {
            always: createNoopTool(),
            dynamic: createNoopTool(),
          },
        },
        {
          history: [],
          signal: new AbortController().signal,
          threadKey: "thread",
        }
      )
    ).rejects.toMatchObject({ name: ModelToolSelectionError.name });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("accepts official-style model accessors without invoking them during selection", async () => {
    const runModelStep = await loadModelStepRunner();
    const providerGetter = vi.fn(() => "unsafe-provider");
    const modelOverride = {
      doGenerate: vi.fn(),
      doStream: vi.fn(),
      modelId: "unsafe-model",
      specificationVersion: "v4",
      supportedUrls: {},
    } as Record<string, unknown>;
    Object.defineProperty(modelOverride, "provider", {
      enumerable: true,
      get: providerGetter,
    });

    await runModelStep(
      {
        model: fakeModel,
        prepareModelStep: () => ({ model: modelOverride }) as never,
      },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "thread",
      }
    );
    expect(providerGetter).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: modelOverride })
    );
  });

  it.each([
    {
      label: "configured required choice",
      prepareModelStep: () => ({ activeTools: [] }),
      toolChoice: "required" as const,
    },
    {
      label: "prepared required choice",
      prepareModelStep: () => ({
        activeTools: [],
        toolChoice: "required" as const,
      }),
      toolChoice: undefined,
    },
  ])("rejects $label without an active tool", async (input) => {
    const runModelStep = await loadModelStepRunner();

    await expect(
      runModelStep(
        {
          model: fakeModel,
          prepareModelStep: input.prepareModelStep,
          toolChoice: input.toolChoice,
          tools: { dynamic: createNoopTool() },
        },
        {
          history: [],
          signal: new AbortController().signal,
          threadKey: "thread",
        }
      )
    ).rejects.toThrow(
      'toolChoice "required" cannot be used without an active tool'
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", ["dynamic", "dynamic"]],
    ["unknown", ["missing"]],
  ] as const)(
    "fails closed for %s configured tool order",
    async (_label, toolOrder) => {
      const runModelStep = await loadModelStepRunner();

      await expect(
        runModelStep(
          {
            model: fakeModel,
            toolOrder,
            tools: { dynamic: createNoopTool() },
          },
          { history: [], signal: new AbortController().signal }
        )
      ).rejects.toMatchObject({ name: ModelToolSelectionError.name });
      expect(generateTextMock).not.toHaveBeenCalled();
    }
  );

  it("snapshots configured tool-name arrays without invoking custom iterators", async () => {
    const runModelStep = await loadModelStepRunner();
    const alwaysActiveTools = ["always"];
    const toolOrder = ["always", "dynamic"];
    const alwaysIteratorGetter = vi.fn(() => {
      throw new Error("alwaysActiveTools iterator must stay inert");
    });
    const orderIteratorGetter = vi.fn(() => {
      throw new Error("toolOrder iterator must stay inert");
    });
    Object.defineProperty(alwaysActiveTools, Symbol.iterator, {
      get: alwaysIteratorGetter,
    });
    Object.defineProperty(toolOrder, Symbol.iterator, {
      get: orderIteratorGetter,
    });

    await runModelStep(
      {
        alwaysActiveTools,
        model: fakeModel,
        toolOrder,
        tools: {
          always: createNoopTool(),
          dynamic: createNoopTool(),
        },
      },
      { history: [], signal: new AbortController().signal }
    );

    expect(alwaysIteratorGetter).not.toHaveBeenCalled();
    expect(orderIteratorGetter).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: ["always", "dynamic"],
        toolOrder: ["always", "dynamic"],
      })
    );
  });

  it.each(["alwaysActiveTools", "toolOrder"] as const)(
    "rejects accessor-backed %s indices without invoking them",
    async (field) => {
      const runModelStep = await loadModelStepRunner();
      const indexGetter = vi.fn(() => "dynamic");
      const names: string[] = [];
      Object.defineProperty(names, "0", {
        enumerable: true,
        get: indexGetter,
      });

      await expect(
        runModelStep(
          {
            [field]: names,
            model: fakeModel,
            tools: { dynamic: createNoopTool() },
          },
          { history: [], signal: new AbortController().signal }
        )
      ).rejects.toThrow("dense array of data-property tool names");
      expect(indexGetter).not.toHaveBeenCalled();
      expect(generateTextMock).not.toHaveBeenCalled();
    }
  );

  it.each(["alwaysActiveTools", "toolOrder"] as const)(
    "rejects sparse configured %s arrays",
    async (field) => {
      const runModelStep = await loadModelStepRunner();

      await expect(
        runModelStep(
          {
            [field]: new Array<string>(1),
            model: fakeModel,
            tools: { dynamic: createNoopTool() },
          },
          { history: [], signal: new AbortController().signal }
        )
      ).rejects.toThrow("dense array of data-property tool names");
      expect(generateTextMock).not.toHaveBeenCalled();
    }
  );

  it("reports only bounded counts, timings, ids, and fingerprints", async () => {
    const runModelStep = await loadModelStepRunner();
    const diagnostics: unknown[] = [];

    await runModelStep(
      {
        diagnostics: {
          report: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        },
        model: fakeModel,
        prepareModelStep: () => ({ activeTools: ["dynamic_secret"] }),
        tools: { dynamic_secret: createNoopTool() },
      },
      {
        history: [{ content: "raw prompt secret", role: "user" }],
        runtimeStepIndex: 3,
        signal: new AbortController().signal,
        threadKey: "raw-thread-secret",
      }
    );

    await vi.waitFor(() =>
      expect(diagnostics).toEqual([
        {
          code: "model.tool_cache_fingerprint",
          level: "info",
          metadata: expect.objectContaining({
            activeToolCount: 1,
            attemptId: expect.stringMatching(uuidPattern),
            dynamicDescriptionToolCount: 0,
            modelIdentityFingerprint: expect.stringMatching(
              sha256FingerprintPattern
            ),
            modelIdentityFingerprintUnavailable: false,
            orderedToolSemanticFingerprint: expect.stringMatching(
              sha256FingerprintPattern
            ),
            registeredToolCount: 1,
            runtimeStepIndex: 3,
            selectionDurationMs: expect.any(Number),
            semanticFingerprintUnavailableToolCount: 0,
            toolLoadingStrategy: "eager-active-tools",
          }),
          phase: "model-step",
        },
      ])
    );
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("raw prompt secret");
    expect(serialized).not.toContain("raw-thread-secret");
    expect(serialized).not.toContain("dynamic_secret");
    expect(serialized).toMatch(sha256FingerprintPattern);
    expect(
      (diagnostics[0] as { metadata: { selectionDurationMs: number } }).metadata
        .selectionDurationMs
    ).toBeGreaterThanOrEqual(0);
  });

  it("correlates selection diagnostics and usage with one attempt ID", async () => {
    const diagnostics: Array<{
      readonly metadata?: { readonly attemptId?: string };
    }> = [];
    const { generateModelStepResult } = await import("./model-step");

    const result = await generateModelStepResult({
      diagnostics: {
        report: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
      history: [],
      model: fakeModel,
      signal: new AbortController().signal,
      tools: { tool: createNoopTool() },
    });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]?.metadata?.attemptId).toBe(result.usage.attemptId);
  });

  it("selects and fingerprints special-name tools through own properties", async () => {
    const runModelStep = await loadModelStepRunner();
    const specialNames = ["constructor", "toString", "__proto__"];
    const diagnostics: Array<{
      readonly metadata?: {
        readonly orderedToolSemanticFingerprint: string;
        readonly semanticFingerprintUnavailableToolCount: number;
      };
    }> = [];
    const tools = Object.fromEntries(
      specialNames.map((name) => [name, createNoopTool()])
    ) as ToolSet;

    await runModelStep(
      {
        diagnostics: {
          report: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        },
        model: fakeModel,
        prepareModelStep: () => ({ activeTools: specialNames }),
        toolOrder: specialNames,
        tools,
      },
      {
        history: [],
        signal: new AbortController().signal,
        threadKey: "special-name-tools",
      }
    );

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    const generatedTools = generateTextMock.mock.calls.at(-1)?.[0]?.tools;
    expect(Object.keys(generatedTools ?? {})).toEqual(specialNames);
    for (const name of specialNames) {
      expect(Object.hasOwn(generatedTools ?? {}, name)).toBe(true);
    }
    expect(diagnostics[0]?.metadata).toMatchObject({
      orderedToolSemanticFingerprint: expect.stringMatching(
        sha256FingerprintPattern
      ),
      semanticFingerprintUnavailableToolCount: 0,
    });
  });

  it("changes the semantic fingerprint when selected metadata changes", async () => {
    const runModelStep = await loadModelStepRunner();
    const diagnostics: Array<{
      readonly metadata?: {
        readonly orderedToolSemanticFingerprint: string;
        readonly orderedToolNamesFingerprint: string;
      };
    }> = [];
    const diagnosticSink = {
      report: (diagnostic: (typeof diagnostics)[number]) => {
        diagnostics.push(diagnostic);
      },
    };

    const cases = [
      {
        description: "definition-v1",
        inputExamples: [{ input: { query: "a" } }],
        providerOptions: { example: { mode: "a" } },
        strict: false,
      },
      {
        description: "definition-v1",
        inputExamples: [{ input: { query: "a" } }],
        providerOptions: { example: { mode: "a" } },
        strict: true,
      },
      {
        description: "definition-v2",
        inputExamples: [{ input: { query: "a" } }],
        providerOptions: { example: { mode: "a" } },
        strict: true,
      },
      {
        description: "definition-v2",
        inputExamples: [{ input: { query: "b" } }],
        providerOptions: { example: { mode: "a" } },
        strict: true,
      },
      {
        description: "definition-v2",
        inputExamples: [{ input: { query: "b" } }],
        providerOptions: { example: { mode: "b" } },
        strict: true,
      },
    ] as const;
    for (const definition of cases) {
      await runModelStep(
        {
          diagnostics: diagnosticSink,
          model: fakeModel,
          tools: {
            stable_name: tool({
              description: definition.description,
              execute: () => ({}),
              inputExamples: definition.inputExamples.map(({ input }) => ({
                input: { ...input },
              })),
              inputSchema: jsonSchema<{ query: string }>({
                additionalProperties: false,
                properties: {},
                type: "object",
              }),
              providerOptions: definition.providerOptions,
              strict: definition.strict,
            }),
          },
        },
        { history: [], signal: new AbortController().signal }
      );
    }

    await vi.waitFor(() => expect(diagnostics).toHaveLength(cases.length));
    expect(
      new Set(
        diagnostics.map(
          (diagnostic) => diagnostic.metadata?.orderedToolNamesFingerprint
        )
      ).size
    ).toBe(1);
    expect(
      new Set(
        diagnostics.map(
          (diagnostic) => diagnostic.metadata?.orderedToolSemanticFingerprint
        )
      ).size
    ).toBe(cases.length);
  });

  it("observes metadata mutations before the detached snapshot starts", async () => {
    const runModelStep = await loadModelStepRunner();
    const fingerprints: string[] = [];
    const providerOptions = { example: { mode: "original" } };
    const definition = {
      description: "stable definition",
      providerOptions,
    } as unknown as ToolSet[string];
    const diagnostics = {
      report: (diagnostic: {
        readonly metadata?: { readonly orderedToolSemanticFingerprint: string };
      }) => {
        const fingerprint = diagnostic.metadata?.orderedToolSemanticFingerprint;
        if (fingerprint) {
          fingerprints.push(fingerprint);
        }
      },
    };

    await runModelStep(
      { diagnostics, model: fakeModel, tools: { stable: definition } },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(fingerprints).toHaveLength(1));

    generateTextMock.mockImplementationOnce(() => {
      providerOptions.example.mode = "mutated-after-resolve";
      return Promise.resolve({
        responseMessages: [assistantMessage("DONE")],
      });
    });
    await runModelStep(
      { diagnostics, model: fakeModel, tools: { stable: definition } },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(fingerprints).toHaveLength(2));

    expect(fingerprints[1]).not.toBe(fingerprints[0]);
  });

  it("marks asynchronous schemas unavailable without awaiting mutable results", async () => {
    const runModelStep = await loadModelStepRunner();
    const diagnostics: Array<{
      readonly fingerprint: string;
      readonly unavailable: number;
    }> = [];
    const mutableSchema: {
      properties: { query: { type: "number" | "string" } };
      type: "object";
    } = {
      properties: { query: { type: "string" } },
      type: "object",
    };
    let resolveSchema: (schema: typeof mutableSchema) => void = () => undefined;
    const pendingSchema = new Promise<typeof mutableSchema>((resolve) => {
      resolveSchema = resolve;
    });
    const definition = {
      description: "async schema",
      inputSchema: jsonSchema(pendingSchema),
    } as unknown as ToolSet[string];
    const diagnosticSink = {
      report: (diagnostic: {
        readonly metadata?: {
          readonly orderedToolSemanticFingerprint: string;
          readonly semanticFingerprintUnavailableToolCount: number;
        };
      }) => {
        if (diagnostic.metadata) {
          diagnostics.push({
            fingerprint: diagnostic.metadata.orderedToolSemanticFingerprint,
            unavailable:
              diagnostic.metadata.semanticFingerprintUnavailableToolCount,
          });
        }
      },
    };

    await runModelStep(
      {
        diagnostics: diagnosticSink,
        model: fakeModel,
        tools: { delayed: definition },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]?.unavailable).toBe(1);

    mutableSchema.properties.query = { type: "number" };
    resolveSchema(mutableSchema);
    await pendingSchema;
    await runModelStep(
      {
        diagnostics: diagnosticSink,
        model: fakeModel,
        tools: { delayed: definition },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(diagnostics).toHaveLength(2));

    expect(diagnostics[1]).toEqual(diagnostics[0]);
  });

  it("observes schema Promise rejections after detached inspection", async () => {
    const runModelStep = await loadModelStepRunner();
    const unavailableCounts: number[] = [];
    const unhandledRejections: unknown[] = [];
    let rejectSchema: (reason: Error) => void = () => undefined;
    const pendingSchema = new Promise<never>((_resolve, reject) => {
      rejectSchema = reject;
    });
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await runModelStep(
        {
          diagnostics: {
            report(diagnostic) {
              const count =
                diagnostic.metadata?.semanticFingerprintUnavailableToolCount;
              if (count !== undefined) {
                unavailableCounts.push(count);
              }
            },
          },
          model: fakeModel,
          tools: {
            rejecting: {
              inputSchema: jsonSchema(pendingSchema),
            } as unknown as ToolSet[string],
          },
        },
        { history: [], signal: new AbortController().signal }
      );
      await vi.waitFor(() => expect(unavailableCounts).toEqual([1]));

      rejectSchema(new Error("schema-boom"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("observes shadowed native Promises after detached inspection", async () => {
    const runModelStep = await loadModelStepRunner();
    const unavailableCounts: number[] = [];
    const unhandledRejections: unknown[] = [];
    let rejectSchema: (reason: Error) => void = () => undefined;
    const pendingSchema = new Promise<never>((_resolve, reject) => {
      rejectSchema = reject;
    });
    // biome-ignore lint/suspicious/noThenProperty: this regression intentionally shadows Promise.prototype.then.
    Object.defineProperty(pendingSchema, "then", { value: undefined });
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await runModelStep(
        {
          diagnostics: {
            report(diagnostic) {
              const count =
                diagnostic.metadata?.semanticFingerprintUnavailableToolCount;
              if (count !== undefined) {
                unavailableCounts.push(count);
              }
            },
          },
          model: fakeModel,
          tools: {
            rejecting: {
              inputSchema: jsonSchema(pendingSchema),
            } as unknown as ToolSet[string],
          },
        },
        { history: [], signal: new AbortController().signal }
      );
      await vi.waitFor(() => expect(unavailableCounts).toEqual([1]));

      rejectSchema(new Error("shadowed-then-boom"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("does not assimilate accessor-backed schema thenables", async () => {
    const runModelStep = await loadModelStepRunner();
    const unavailableCounts: number[] = [];
    let thenGetterCount = 0;
    const hostileThenable = Object.create(null) as Record<string, unknown>;
    // biome-ignore lint/suspicious/noThenProperty: this regression intentionally exercises a hostile thenable accessor.
    Object.defineProperty(hostileThenable, "then", {
      enumerable: true,
      get() {
        thenGetterCount += 1;
        return () => undefined;
      },
    });

    await runModelStep(
      {
        diagnostics: {
          report(diagnostic) {
            const count =
              diagnostic.metadata?.semanticFingerprintUnavailableToolCount;
            if (count !== undefined) {
              unavailableCounts.push(count);
            }
          },
        },
        model: fakeModel,
        tools: {
          thenable: {
            inputSchema: jsonSchema(hostileThenable),
          } as unknown as ToolSet[string],
        },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(unavailableCounts).toEqual([1]));

    expect(thenGetterCount).toBe(0);
  });

  it("marks arbitrary Standard Schema converters unavailable", async () => {
    const runModelStep = await loadModelStepRunner();
    const unavailableCounts: number[] = [];
    let conversionCount = 0;
    const definition = {
      inputSchema: {
        "~standard": {
          jsonSchema: {
            input() {
              conversionCount += 1;
              return { type: "object" };
            },
          },
          validate: () => ({ value: undefined }),
          vendor: "stateful-example",
          version: 1,
        },
      },
    } as unknown as ToolSet[string];

    await runModelStep(
      {
        diagnostics: {
          report(diagnostic) {
            const count =
              diagnostic.metadata?.semanticFingerprintUnavailableToolCount;
            if (count !== undefined) {
              unavailableCounts.push(count);
            }
          },
        },
        model: fakeModel,
        tools: { standard: definition },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(unavailableCounts).toEqual([1]));

    expect(conversionCount).toBe(0);
  });

  it("does not rerun a bare lazy schema callback for diagnostics", async () => {
    const runModelStep = await loadModelStepRunner();
    const unavailableCounts: number[] = [];
    let conversionCount = 0;
    const definition = {
      inputSchema: () => {
        conversionCount += 1;
        return jsonSchema({ type: "object" });
      },
    } as ToolSet[string];

    await runModelStep(
      {
        diagnostics: {
          report(diagnostic) {
            const count =
              diagnostic.metadata?.semanticFingerprintUnavailableToolCount;
            if (count !== undefined) {
              unavailableCounts.push(count);
            }
          },
        },
        model: fakeModel,
        tools: { lazy: definition },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(unavailableCounts).toEqual([1]));

    expect(conversionCount).toBe(0);
  });

  it("isolates diagnostic reflection failures from model generation", async () => {
    const runModelStep = await loadModelStepRunner();
    const unavailableCounts: number[] = [];
    const hostileDefinition = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("diagnostic-proxy-boom");
        },
      }
    ) as ToolSet[string];

    await runModelStep(
      {
        diagnostics: {
          report(diagnostic) {
            const count =
              diagnostic.metadata?.semanticFingerprintUnavailableToolCount;
            if (count !== undefined) {
              unavailableCounts.push(count);
            }
          },
        },
        model: fakeModel,
        tools: { hostile: hostileDefinition },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(unavailableCounts).toEqual([1]));

    expect(generateTextMock).toHaveBeenCalledOnce();
  });

  it("starts the model request before resolving detached schema diagnostics", async () => {
    const runModelStep = await loadModelStepRunner();
    const order: string[] = [];
    const definition = {
      inputSchema: jsonSchema(() => {
        order.push("schema");
        return {
          properties: { query: { type: "string" } },
          type: "object",
        };
      }),
    } as ToolSet[string];
    generateTextMock.mockImplementationOnce(() => {
      order.push("model-request");
      return Promise.resolve({
        responseMessages: [assistantMessage("DONE")],
      });
    });

    await runModelStep(
      {
        diagnostics: {
          report() {
            order.push("diagnostic-report");
          },
        },
        model: fakeModel,
        tools: { lazy: definition },
      },
      { history: [], signal: new AbortController().signal }
    );
    await vi.waitFor(() => expect(order).toContain("diagnostic-report"));

    expect(order[0]).toBe("model-request");
    expect(order.indexOf("schema")).toBeGreaterThan(
      order.indexOf("model-request")
    );
  });

  it("fingerprints provider-tool ids and canonical arguments", async () => {
    const runModelStep = await loadModelStepRunner();
    const fingerprints: string[] = [];
    const diagnostics = {
      report: (diagnostic: {
        readonly metadata?: { readonly orderedToolSemanticFingerprint: string };
      }) => {
        const fingerprint = diagnostic.metadata?.orderedToolSemanticFingerprint;
        if (fingerprint) {
          fingerprints.push(fingerprint);
        }
      },
    };

    for (const mode of ["a", "b"]) {
      const providerTool = {
        args: { mode },
        id: "example.search",
        inputSchema: jsonSchema({
          additionalProperties: false,
          properties: {},
          type: "object",
        }),
        isProviderExecuted: true,
        outputSchema: jsonSchema({}),
        type: "provider",
      } as unknown as ToolSet[string];
      await runModelStep(
        {
          diagnostics,
          model: fakeModel,
          tools: { provider_search: providerTool },
        },
        { history: [], signal: new AbortController().signal }
      );
    }

    await vi.waitFor(() => expect(fingerprints).toHaveLength(2));
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it("distinguishes non-JSON numeric provider arguments", async () => {
    const runModelStep = await loadModelStepRunner();
    const fingerprints: string[] = [];
    const diagnostics = {
      report: (diagnostic: {
        readonly metadata?: { readonly orderedToolSemanticFingerprint: string };
      }) => {
        const fingerprint = diagnostic.metadata?.orderedToolSemanticFingerprint;
        if (fingerprint) {
          fingerprints.push(fingerprint);
        }
      },
    };

    for (const value of [0, -0, Number.NaN, Number.POSITIVE_INFINITY]) {
      await runModelStep(
        {
          diagnostics,
          model: fakeModel,
          tools: {
            provider_search: {
              args: { value },
              id: "example.search",
              isProviderExecuted: true,
              type: "provider",
            } as unknown as ToolSet[string],
          },
        },
        { history: [], signal: new AbortController().signal }
      );
    }

    await vi.waitFor(() => expect(fingerprints).toHaveLength(4));
    expect(new Set(fingerprints).size).toBe(4);
  });

  it("reports per-tool semantic fingerprint failures without dropping diagnostics", async () => {
    const runModelStep = await loadModelStepRunner();
    const diagnostics: unknown[] = [];
    const brokenTool = {
      description: "broken schema",
      get inputSchema(): never {
        throw new Error("schema unavailable");
      },
    } as unknown as ToolSet[string];

    await runModelStep(
      {
        diagnostics: {
          report: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        },
        model: fakeModel,
        tools: {
          broken: brokenTool,
          healthy: {
            description: "healthy definition",
          } as unknown as ToolSet[string],
        },
      },
      { history: [], signal: new AbortController().signal }
    );

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]).toMatchObject({
      metadata: {
        orderedToolSemanticFingerprint: expect.stringMatching(
          sha256FingerprintPattern
        ),
        semanticFingerprintUnavailableToolCount: 1,
      },
    });
  });

  it("does not evaluate dynamic descriptions while fingerprinting", async () => {
    const runModelStep = await loadModelStepRunner();
    const description = vi.fn(() => "resolved description");
    const diagnostics: unknown[] = [];

    await runModelStep(
      {
        diagnostics: {
          report: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        },
        model: fakeModel,
        tools: {
          dynamic: {
            description,
          } as unknown as ToolSet[string],
        },
      },
      { history: [], signal: new AbortController().signal }
    );

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(description).not.toHaveBeenCalled();
    expect(diagnostics[0]).toMatchObject({
      metadata: {
        dynamicDescriptionToolCount: 1,
        semanticFingerprintUnavailableToolCount: 0,
      },
    });
  });

  it("does not let fingerprint failures block model generation", async () => {
    const runModelStep = await loadModelStepRunner();
    const report = vi.fn();
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(
      new Error("crypto unavailable")
    );

    await expect(
      runModelStep(
        {
          diagnostics: { report },
          model: fakeModel,
          tools: { tool: createNoopTool() },
        },
        { history: [], signal: new AbortController().signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);
    expect(report).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledOnce();
  });

  it("does not await a slow diagnostics sink", async () => {
    const runModelStep = await loadModelStepRunner();
    let markReportStarted: (() => void) | undefined;
    const reportStarted = new Promise<void>((resolve) => {
      markReportStarted = resolve;
    });

    await expect(
      runModelStep(
        {
          diagnostics: {
            report: () => {
              markReportStarted?.();
              return new Promise<void>(() => undefined);
            },
          },
          model: fakeModel,
          tools: { tool: createNoopTool() },
        },
        { history: [], signal: new AbortController().signal }
      )
    ).resolves.toEqual([assistantMessage("DONE")]);
    await reportStarted;
  });

  it("skips fingerprint work when diagnostics are not configured", async () => {
    const runModelStep = await loadModelStepRunner();
    const digest = vi.spyOn(crypto.subtle, "digest");

    await runModelStep(
      { model: fakeModel, tools: { tool: createNoopTool() } },
      { history: [], signal: new AbortController().signal }
    );

    expect(digest).not.toHaveBeenCalled();
  });

  it("attributes usage to the provider response model before the configured model", async () => {
    generateTextMock.mockResolvedValue({
      finalStep: {
        model: { modelId: "configured-step-model", provider: "provider-a" },
        performance: { responseTimeMs: 125 },
      },
      finishReason: "stop",
      response: { modelId: "provider-routed-model" },
      responseMessages: [assistantMessage("DONE")],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    const { generateModelStepResult } = await import("./model-step");

    const result = await generateModelStepResult({
      history: [{ role: "user", content: "hello" }],
      model: fakeModel,
      signal: new AbortController().signal,
    });

    expect(result.usage).toMatchObject({
      modelId: "provider-routed-model",
      provider: "provider-a",
      type: "model-usage",
    });
  });

  it("drops malformed usage metadata and falls back to safe model attribution", async () => {
    generateTextMock.mockResolvedValue({
      finalStep: {
        model: { modelId: "safe/fallback-model", provider: "safe.provider" },
        performance: { responseTimeMs: 12.6 },
      },
      finishReason: "provider-secret\ninvalid",
      response: { modelId: "routed-model\ninvalid" },
      responseMessages: [assistantMessage("DONE")],
      usage: {
        inputTokenDetails: {
          cacheReadTokens: 1.5,
          cacheWriteTokens: 2,
          noCacheTokens: Number.NaN,
        },
        inputTokens: -1,
        outputTokenDetails: { reasoningTokens: 3 },
        outputTokens: 0,
        totalTokens: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    const { generateModelStepResult } = await import("./model-step");

    const result = await generateModelStepResult({
      history: [{ role: "user", content: "hello" }],
      model: fakeModel,
      signal: new AbortController().signal,
    });

    expect(result.usage).toEqual({
      attemptId: expect.any(String),
      cacheWriteTokens: 2,
      durationMs: 13,
      modelId: "safe/fallback-model",
      outputTokens: 0,
      provider: "safe.provider",
      reasoningTokens: 3,
      type: "model-usage",
    });
  });

  it("falls back to the prepared model for usage attribution", async () => {
    const preparedModel = {
      ...fakeModel,
      modelId: "prepared-model",
      provider: "prepared-provider",
      supportedUrls: {},
    };
    const { generateModelStepResult } = await import("./model-step");

    const result = await generateModelStepResult({
      history: [{ role: "user", content: "hello" }],
      model: fakeModel,
      prepareModelStep: () => ({ model: preparedModel }),
      signal: new AbortController().signal,
      threadKey: "thread",
    });

    expect(result.usage).toMatchObject({
      modelId: "prepared-model",
      provider: "prepared-provider",
    });
  });

  it("creates one distinct opaque attempt ID per runtime model-step invocation", async () => {
    const { generateModelStepResult } = await import("./model-step");
    const options = {
      history: [{ role: "user" as const, content: "hello" }],
      model: fakeModel,
      signal: new AbortController().signal,
    };

    const first = await generateModelStepResult(options);
    const second = await generateModelStepResult(options);

    expect(first.usage.attemptId).toMatch(uuidPattern);
    expect(second.usage.attemptId).not.toBe(first.usage.attemptId);
  });

  it("rejects tools using AI SDK tool approval before generateText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const tools = {
      risky: {
        ...createNoopTool(),
        needsApproval: true,
      },
    } satisfies ToolSet;

    await expect(
      runModelStep(
        {
          model: fakeModel,
          tools,
        },
        { history, signal }
      )
    ).rejects.toThrow(unsupportedApprovalPattern);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("Agent tool wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes injected AgentOptions tools into generateText", async () => {
    const Agent = await loadAgent();
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const agent = new Agent({
      model: fakeModel,
      tools: injectedTools,
    });

    await drainRun(await agent.send("use injected tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        tools: expect.objectContaining({
          injected: expect.any(Object),
        }),
      })
    );
  });

  it("passes AgentOptions toolChoice into generateText", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      toolChoice: "required",
      tools: { required_tool: createNoopTool() },
    });

    await drainRun(await agent.send("force tool choice"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        toolChoice: "required",
      })
    );
  });

  it("does not attach product tools by default", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({ model: fakeModel });

    await drainRun(await agent.send("run without product tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });
});
