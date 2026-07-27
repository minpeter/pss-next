import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createNoopTool } from "../../testing/llm-test-utils";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  Agent,
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  type AgentOptions,
  createAgent,
} from "./agent";
import { threadStoreKey } from "./thread-entry";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);
const functionModel = () => Promise.resolve([]);
const invalidModelPattern = /invalid options\.model/;
const missingModelPattern = /missing options\.model/;
const missingOptionsPattern = /Agent options are required/;
const unsupportedApprovalPattern = /needsApproval.*not supported/;
const prepareModelStepPattern = /prepareModelStep/;
const duplicateToolOrderPattern = /toolOrder.*duplicate/;
const duplicateAlwaysActiveToolsPattern = /alwaysActiveTools.*duplicate/;
const agentOptionsSourceUrl = new URL("./options.ts", import.meta.url);
const agentSourceUrl = new URL("./agent.ts", import.meta.url);
const forbiddenAgentSubagentSurface = [
  ["Subagent", "Definition"].join(""),
  ["sub", "agents"].join(""),
  ["create", "Subagent", "Tools"].join(""),
  ["register", "Subagents"].join(""),
  ["subagent", "Count"].join(""),
  ["supports", "Background", "Subagents"].join(""),
] as const;

const acceptsModelOptions: AgentOptions = {
  instructions: "Use the injected model.",
  model: fakeModel,
  toolChoice: "auto",
  tools: {},
};
const functionModelOptions = {
  model: functionModel,
} as const;

type AssertFalse<T extends false> = T;
type IsAssignable<Source, Target> = Source extends Target ? true : false;
type RejectsFunctionModel = AssertFalse<
  IsAssignable<typeof functionModelOptions, AgentOptions>
>;
type RejectsSessionMethod = AssertFalse<
  "session" extends keyof Agent ? true : false
>;
const typeFixtures = [acceptsModelOptions, functionModelOptions];
type TypeFixtureAssertions = [RejectsFunctionModel, RejectsSessionMethod];
const typeFixtureAssertions: TypeFixtureAssertions = [false, false];

const collectRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  for await (const _event of run.events()) {
    // Drain the events so the run can finish.
  }
};

describe("Agent", () => {
  it("keeps AgentOptions type fixtures reachable", () => {
    expect(typeFixtures).toHaveLength(2);
    expect(typeFixtureAssertions).toHaveLength(2);
  });

  it("constructs agents with new Agent", () => {
    expect(new Agent({ model: fakeModel })).toBeInstanceOf(Agent);
  });

  it("exposes an async factory for plugin initialization", async () => {
    await expect(createAgent({ model: fakeModel })).resolves.toBeInstanceOf(
      Agent
    );
  });

  it("rejects caller-owned runtime model functions", () => {
    expect(() => Reflect.construct(Agent, [functionModelOptions])).toThrow(
      invalidModelPattern
    );
  });

  it("omits runtime-owned subagent options and generated tool injection", async () => {
    const source = [
      await readFile(agentOptionsSourceUrl, "utf8"),
      await readFile(agentSourceUrl, "utf8"),
    ].join("\n");

    for (const forbiddenName of forbiddenAgentSubagentSurface) {
      expect(source).not.toContain(forbiddenName);
    }
  });

  it("uses the default thread for agent.send", async () => {
    const agent = new Agent({ model: fakeModel });
    await expect(agent.send("hello")).resolves.toBeDefined();
  });

  it("wraps send and steer turns with operation context", async () => {
    const contexts: AgentInstrumentationContext[] = [];
    const instrumentation: AgentInstrumentation = {
      wrapTurn: (turn, context) => {
        contexts.push(context);
        return turn;
      },
    };
    const agent = new Agent({
      instrumentations: [instrumentation],
      model: createMockLanguageModelV4(() =>
        Promise.resolve(mockLanguageModelV4Text("DONE"))
      ),
      namespace: "support",
    });
    const thread = agent.thread("customer-1");

    await collectRun(await thread.send("hello"));
    await collectRun(await thread.steer("one more thing"));

    expect(contexts).toEqual([
      {
        namespace: "support",
        operation: "send",
        threadKey: "customer-1",
      },
      {
        namespace: "support",
        operation: "steer",
        threadKey: "customer-1",
      },
    ]);
  });

  it("reuses handles for named threads", () => {
    const agent = new Agent({ model: fakeModel });
    expect(agent.thread("a")).toBe(agent.thread("a"));
    expect(agent.thread("a")).not.toBe(agent.thread("b"));
  });

  it("reuses scoped thread handles by their canonical address", () => {
    const agent = new Agent({ model: fakeModel });

    expect(agent.thread({ key: "a", scope: "user:1" })).toBe(
      agent.thread({ key: "a", scope: "user:1" })
    );
    expect(agent.thread({ key: "a", scope: "user:1" })).not.toBe(
      agent.thread({ key: "a", scope: "user:2" })
    );
  });

  it("exposes the stable thread-store key for host-level adapters", () => {
    expect(threadStoreKey("plain")).toBe("plain");
    expect(threadStoreKey({ key: "room/1", scope: "user:1" })).toBe(
      "scope:user%3A1:thread:room%2F1"
    );
  });

  it("drops disposed thread handles so keys can be reused", async () => {
    const agent = new Agent({ model: fakeModel });
    const first = agent.thread("reuse");

    await first.dispose();
    const second = agent.thread("reuse");
    await collectRun(await second.send("hello"));

    expect(second).not.toBe(first);
  });

  it("rejects missing constructor options with an actionable error", () => {
    expect(() => Reflect.construct(Agent, [undefined])).toThrow(
      missingOptionsPattern
    );
  });

  it("rejects missing model configuration with an actionable error", () => {
    expect(() => new Agent({} as AgentOptions)).toThrow(missingModelPattern);
  });

  it("rejects invalid model configuration with an actionable error", () => {
    expect(() => Reflect.construct(Agent, [{ model: "not-a-model" }])).toThrow(
      invalidModelPattern
    );
  });

  it("rejects tools using AI SDK tool approval", () => {
    const tools = {
      risky: {
        ...createNoopTool(),
        needsApproval: true,
      },
    } satisfies NonNullable<AgentOptions["tools"]>;

    expect(
      () =>
        new Agent({
          model: fakeModel,
          tools,
        })
    ).toThrow(unsupportedApprovalPattern);
  });

  it("rejects malformed model-step preparation options", () => {
    expect(() =>
      Reflect.construct(Agent, [
        { model: fakeModel, prepareModelStep: "invalid" },
      ])
    ).toThrow(prepareModelStepPattern);
    expect(
      () =>
        new Agent({
          model: fakeModel,
          toolOrder: ["duplicate", "duplicate"],
        })
    ).toThrow(duplicateToolOrderPattern);
    expect(
      () =>
        new Agent({
          alwaysActiveTools: ["duplicate", "duplicate"],
          model: fakeModel,
        })
    ).toThrow(duplicateAlwaysActiveToolsPattern);
  });

  it.each(["alwaysActiveTools", "toolOrder"] as const)(
    "keeps a custom %s iterator inert through the public factory",
    async (field) => {
      const names = ["stable"];
      const iteratorGetter = vi.fn(() => {
        throw new Error(`${field} iterator must stay inert`);
      });
      Object.defineProperty(names, Symbol.iterator, {
        get: iteratorGetter,
      });

      const agent = await createAgent({
        [field]: names,
        model: fakeModel,
        tools: { stable: createNoopTool() },
      });
      await collectRun(await agent.send("use stable tools"));

      expect(iteratorGetter).not.toHaveBeenCalled();
    }
  );

  it("rejects accessor-backed tool registries without invoking them", async () => {
    const registryGetter = vi.fn(() => {
      throw new Error("registry getter must stay inert");
    });
    const prepareModelStep = vi.fn(() => ({ activeTools: [] }));
    const tools = {} as NonNullable<AgentOptions["tools"]>;
    Object.defineProperty(tools, "inactive", {
      enumerable: true,
      get: registryGetter,
    });

    await expect(
      createAgent({ model: fakeModel, prepareModelStep, tools })
    ).rejects.toThrow("must be a data property");
    expect(registryGetter).not.toHaveBeenCalled();
    expect(prepareModelStep).not.toHaveBeenCalled();
  });
});
