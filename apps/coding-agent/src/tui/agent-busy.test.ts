import {
  type Component,
  Container,
  type Editor,
  type Terminal,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import {
  type AgentTurn,
  createAgent,
  speculativeCompaction,
} from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentExtensionUi } from "../extensions/types";

const terminalHarness = vi.hoisted(() => ({
  send: (_data: string): void => undefined,
  surface: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class TestTerminal implements Terminal {
    columns = 80;
    rows = 24;
    kittyProtocolActive = false;
    clearFromCursor = noop;
    clearLine = noop;
    clearScreen = noop;
    hideCursor = noop;
    moveBy = noop;
    setProgress = noop;
    setTitle = noop;
    showCursor = noop;
    stop = noop;
    write = noop;
    drainInput() {
      return Promise.resolve();
    }
    start(onInput: (data: string) => void) {
      terminalHarness.send = onInput;
    }
  }
  class TestScreen extends actual.TuiMainScreen {
    override start() {
      terminalHarness.surface = this;
      super.start();
    }
  }
  return {
    ...actual,
    ProcessTerminal: TestTerminal,
    TuiMainScreen: TestScreen,
  };
});

import { type AgentTUIConfig, createAgentTUI, FooterStatusBar } from "./agent";
import { createCompactCommand } from "./compact-command";
import { withCompactionStatus } from "./compaction-status";
import { createToolRenderers } from "./renderers/tool-renderers";
import { TuiSessionMachine } from "./session-state";

const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const bounded = async <T>(
  promise: Promise<T>,
  description = "Expected event was not observed"
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(description)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const findFooter = (component: Component): FooterStatusBar | undefined => {
  if (component instanceof FooterStatusBar) {
    return component;
  }
  if (component instanceof Container) {
    for (const child of component.children) {
      const found = findFooter(child);
      if (found) {
        return found;
      }
    }
  }
  return;
};
const footer = () => {
  const result = terminalHarness.surface && findFooter(terminalHarness.surface);
  if (!result) {
    throw new Error("No mounted footer");
  }
  return result;
};
const SPINNER_PATTERN = /[\u2800-\u28ff]/u;
const frame = () => footer().render(80).join("").match(SPINNER_PATTERN)?.[0];
const expectBusy = () => {
  const first = frame();
  expect.soft(first).toBeDefined();
  vi.advanceTimersByTime(80);
  expect.soft(frame()).toBeDefined();
  expect.soft(frame()).not.toBe(first);
};
const input = (value: string) => {
  for (const char of value) {
    terminalHarness.send(char);
  }
};
const idleGate = () => {
  const idle = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      idle.resolve();
    });
  return idle.promise;
};
const exit = async (run: Promise<void>) => {
  process.emit("SIGINT", "SIGINT");
  process.emit("SIGINT", "SIGINT");
  await run;
  expect(vi.getTimerCount()).toBe(0);
};
const thread = () => ({
  interrupt: vi.fn(),
  send: vi.fn(() => {
    throw new Error("Unexpected send");
  }),
  steer: vi.fn(() => {
    throw new Error("Unexpected steer");
  }),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.sequential("real TUI busy lifetimes", () => {
  it.each([
    "activation",
    "setup",
    "command",
    "reload",
    "preprocess",
    "history",
  ] as const)(
    "animates during %s until its promise settles",
    async (boundary) => {
      const entered = gate();
      const release = gate();
      const pending = () => {
        entered.resolve();
        return release.promise;
      };
      const idle = idleGate();
      const config: AgentTUIConfig = {
        thread: thread(),
        commands: [
          {
            name: "slow",
            description: "fixture",
            execute: async () => {
              if (boundary === "command") {
                await pending();
              }
              return {
                success: true,
                ...(boundary === "reload"
                  ? { action: { type: "reload" as const } }
                  : {}),
              };
            },
          },
        ],
        onExtensionUiReady: boundary === "activation" ? pending : undefined,
        onSetup: boundary === "setup" ? pending : undefined,
        onCommandAction: pending,
        preprocessUserInput: async () => {
          await pending();
          return { success: false, error: "consumed" };
        },
        replayHistoryOnStartup: boundary === "history",
        sessionSelector: {
          currentSessionKey: () => "one",
          listSessions: async () => [],
          switchSession: async () => undefined,
          loadCurrentHistory: async () => {
            await pending();
            return [];
          },
        },
      };
      const run = createAgentTUI(config);
      let settled = idle;
      try {
        if (!["activation", "setup", "history"].includes(boundary)) {
          await idle;
          settled = idleGate();
          input(boundary === "preprocess" ? "go\r" : "/slow\r");
        }
        await entered.promise;
        expectBusy();
      } finally {
        release.resolve();
        await settled;
        expect(frame()).toBeUndefined();
        await exit(run);
      }
    }
  );

  it("suspends a command for a user modal, resumes work after selection, and retains independent status owners", async () => {
    let ui!: CodingAgentExtensionUi;
    const mounted = gate();
    const selected = gate();
    const release = gate();
    const idle = idleGate();
    const run = createAgentTUI({
      thread: thread(),
      onExtensionUiReady: (createUi) => {
        ui = createUi();
      },
      commands: [
        {
          name: "modal",
          description: "fixture",
          execute: async () => {
            const selection = ui.select({
              label: "Choose",
              options: [{ label: "One", value: "one" }],
            });
            mounted.resolve();
            await selection;
            selected.resolve();
            await release.promise;
            return { success: true };
          },
        },
      ],
    });
    await idle;
    const settled = idleGate();
    input("/modal\r");
    try {
      await mounted.promise;
      expect(frame()).toBeUndefined();
      const clearOne = ui.status("one");
      const clearTwo = ui.status("two");
      clearOne();
      expectBusy();
      clearTwo();
      expect(frame()).toBeUndefined();
      input("\r");
      await selected.promise;
      expectBusy();
    } finally {
      input("\u001b");
      release.resolve();
      await settled;
      await exit(run);
    }
  });

  it.each(["model", "session"] as const)(
    "covers %s listing and switching but not selector user wait",
    async (kind) => {
      const listing = gate();
      const releaseList = gate();
      const mounted = gate();
      const switching = gate();
      const releaseSwitch = gate();
      const loading = gate();
      const releaseHistory = gate();
      const idle = idleGate();
      const run = createAgentTUI({
        thread: thread(),
        commands: [
          {
            name: "pick",
            description: "fixture",
            execute: () => ({
              success: true,
              action: {
                type: kind === "model" ? "select-model" : "select-session",
              },
            }),
          },
        ],
        modelSelector: {
          currentModelId: () => {
            mounted.resolve();
            return "old";
          },
          listModelIds: async () => {
            listing.resolve();
            await releaseList.promise;
            return ["next"];
          },
          switchModel: () => {
            switching.resolve();
            return releaseSwitch.promise;
          },
        },
        sessionSelector: {
          currentSessionKey: () => {
            mounted.resolve();
            return "old";
          },
          listSessions: async () => {
            listing.resolve();
            await releaseList.promise;
            return [
              {
                key: "next",
                cwd: "/fixture",
                createdAt: "2026-09-05T00:00:00Z",
                updatedAt: "2026-09-05T00:00:00Z",
              },
            ];
          },
          switchSession: () => {
            switching.resolve();
            return releaseSwitch.promise;
          },
          loadCurrentHistory: async () => {
            loading.resolve();
            await releaseHistory.promise;
            return [];
          },
        },
      });
      await idle;
      const settled = idleGate();
      input("/pick\r");
      try {
        await listing.promise;
        expectBusy();
        releaseList.resolve();
        await mounted.promise;
        expect(frame()).toBeUndefined();
        input("\r");
        await switching.promise;
        expectBusy();
        releaseSwitch.resolve();
        if (kind === "session") {
          await loading.promise;
          expectBusy();
        }
      } finally {
        releaseList.resolve();
        releaseSwitch.resolve();
        releaseHistory.resolve();
        await settled;
        await exit(run);
      }
    }
  );

  it.each(["manual", "automatic"] as const)(
    "animates during real %s compaction summary execution",
    async (kind) => {
      let ui: CodingAgentExtensionUi | undefined;
      const summaryEntered = gate();
      const releaseSummary = gate();
      const compacted = gate();
      const committing = gate();
      const releaseCommit = gate();
      const diagnostics: unknown[] = [];
      const host = createInMemoryHost();
      const commit = host.store.threads.commit.bind(host.store.threads);
      vi.spyOn(host.store.threads, "commit").mockImplementation(
        async (...args) => {
          const state = args[1].state as { compactions?: unknown[] };
          if ((state.compactions?.length ?? 0) > 0) {
            committing.resolve();
            await releaseCommit.promise;
          }
          return await commit(...args);
        }
      );
      const summaryCall = kind === "manual" ? 2 : 3;
      let calls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          const isSummary = ++calls === summaryCall;
          if (isSummary) {
            summaryEntered.resolve();
            await releaseSummary.promise;
          }
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({
                  type: "text-delta",
                  id: "t",
                  delta: isSummary
                    ? "summary"
                    : "Long history content. ".repeat(200),
                });
                controller.enqueue({ type: "text-end", id: "t" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { raw: "stop", unified: "stop" },
                  usage: {
                    inputTokens: {
                      noCache: 100,
                      total: 100,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      text: isSummary ? 2 : 1200,
                      total: isSummary ? 2 : 1200,
                      reasoning: undefined,
                    },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      });
      const agent = await createAgent({
        host: {
          ...host,
          diagnostics: {
            report: (diagnostic) => {
              diagnostics.push(diagnostic);
              if ((diagnostic.compaction?.summaryCalls ?? 0) > 0) {
                expect
                  .soft(["committed", "skipped"])
                  .toContain(diagnostic.compaction?.outcome);
                compacted.resolve();
              }
            },
          },
        },
        model,
        ...(kind === "automatic"
          ? {
              compaction: withCompactionStatus(
                speculativeCompaction({
                  maxInputTokens: 10_000,
                  prepareRatio: 0.1,
                  promoteRatio: 0.2,
                  retainRatio: 0.05,
                }),
                () => ui?.status("Compacting")
              ),
            }
          : {}),
      });
      const realThread = agent.thread("compaction");
      const idle = idleGate();
      const run = createAgentTUI({
        thread: realThread,
        onExtensionUiReady: (createUi) => {
          ui = createUi();
        },
        commands: [
          createCompactCommand({
            compact: async () => {
              const result = await realThread.compact();
              expect(result.status).toBe("compacted");
              compacted.resolve();
              return result;
            },
          }),
        ],
      });
      await idle;
      let settled = idleGate();
      input("first\r");
      await settled;
      settled = idleGate();
      input(kind === "manual" ? "/compact\r" : "second\r");
      try {
        await bounded(
          summaryEntered.promise,
          `Summary did not start: ${JSON.stringify(diagnostics)}`
        );
        expectBusy();
        if (kind === "automatic") {
          await settled;
          expectBusy();
        }
        releaseSummary.resolve();
        await bounded(
          committing.promise,
          "Compaction did not reach persistence"
        );
        expectBusy();
        releaseCommit.resolve();
        await bounded(
          compacted.promise,
          `Compaction did not commit: ${JSON.stringify(diagnostics)}`
        );
      } finally {
        releaseSummary.resolve();
        releaseCommit.resolve();
        await settled;
        await exit(run);
        await agent.dispose();
      }
    }
  );

  it("keeps the original physical turn cancellable after steering settles, through Esc cleanup", async () => {
    const text = gate();
    const steeringEnded = gate();
    const cancelled = gate();
    const cleanup = gate();
    const reloading = gate();
    const releaseReload = gate();
    const model = new MockLanguageModelV4({
      doStream: async (options) => ({
        stream: new ReadableStream({
          start(controller) {
            options.abortSignal?.addEventListener(
              "abort",
              () => {
                cancelled.resolve();
                cleanup.promise.then(() =>
                  controller.error(new DOMException("Cancelled", "AbortError"))
                );
              },
              { once: true }
            );
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({
              type: "text-delta",
              id: "t",
              delta: "Working",
            });
          },
        }),
      }),
    });
    const agent = await createAgent({ host: createInMemoryHost(), model });
    const realThread = agent.thread("steering");
    const idle = idleGate();
    let steeringReturned = false;
    let subscriptions = 0;
    const observe = (turn: AgentTurn): AgentTurn => ({
      ...turn,
      events: () =>
        (async function* () {
          subscriptions += 1;
          for await (const part of turn.events()) {
            yield part;
            if (part.type === "assistant-output-delta") {
              text.resolve();
            }
          }
        })(),
    });
    const run = createAgentTUI({
      commands: [
        {
          name: "reload",
          description: "fixture",
          allowDuringActiveTurn: true,
          execute: () => ({ success: true, action: { type: "reload" } }),
        },
      ],
      onCommandAction: () => {
        reloading.resolve();
        return releaseReload.promise;
      },
      thread: {
        send: async (value) => observe(await realThread.send(value)),
        steer: async (value) => {
          const steering = observe(await realThread.steer(value));
          steeringReturned = true;
          return steering;
        },
        interrupt: () => realThread.interrupt(),
      },
    });
    await idle;
    const settled = idleGate();
    input("go\r");
    await text.promise;
    const surface = terminalHarness.surface;
    if (!surface) {
      throw new Error("No mounted surface");
    }
    const composer = surface.children.at(-1) as Container;
    const editor = composer.children[0] as Editor;
    const requestRender = surface.requestRender.bind(surface);
    vi.spyOn(surface, "requestRender").mockImplementation((force) => {
      requestRender(force);
      if (steeringReturned && !editor.disableSubmit) {
        steeringEnded.resolve();
      }
    });
    try {
      input("change direction\r");
      await steeringEnded.promise;
      expect.soft(subscriptions).toBe(1);
      expectBusy();
      input("/reload\r");
      await reloading.promise;
      expectBusy();
      input("\u001b");
      await bounded(cancelled.promise);
      expectBusy();
    } finally {
      cleanup.resolve();
      realThread.interrupt();
      await settled;
      expectBusy();
      const noWork = gate();
      const original = footer().setForegroundMessage.bind(footer());
      vi.spyOn(footer(), "setForegroundMessage").mockImplementation(
        (message) => {
          original(message);
          if (message === null) {
            noWork.resolve();
          }
        }
      );
      releaseReload.resolve();
      await bounded(noWork.promise);
      expect(frame()).toBeUndefined();
      await exit(run);
      await agent.dispose();
    }
  });

  it("keeps one ticker through real text, physical parallel tools, step waits, and async finalization", async () => {
    const providers = [gate(), gate()];
    const controllers = [
      gate<ReadableStreamDefaultController>(),
      gate<ReadableStreamDefaultController>(),
    ];
    const releaseProviders = [gate(), gate()];
    const tools = [gate(), gate()];
    const releaseTools = [gate(), gate()];
    const completedTools = [gate(), gate()];
    const events = new Map<string, ReturnType<typeof gate<void>>>();
    const event = (name: string) => {
      let value = events.get(name);
      if (!value) {
        value = gate();
        events.set(name, value);
      }
      return value;
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = calls++;
        providers[index]?.resolve();
        await releaseProviders[index]?.promise;
        return {
          stream: new ReadableStream({
            start(controller) {
              controllers[index]?.resolve(controller);
            },
          }),
        };
      },
    });
    const agent = await createAgent({
      host: createInMemoryHost(),
      model,
      tools: {
        read_file: tool({
          inputSchema: jsonSchema<{ path: string }>({
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          }),
          execute: async ({ path }) => {
            const index = Number(path);
            tools[index]?.resolve();
            await releaseTools[index]?.promise;
            completedTools[index]?.resolve();
            return "file";
          },
        }),
      },
    });
    const realThread = agent.thread("busy");
    const finalizing = gate();
    const releaseFinalizing = gate();
    const observe = (turn: AgentTurn): AgentTurn => ({
      ...turn,
      events: () =>
        (async function* () {
          for await (const part of turn.events()) {
            yield part;
            event(
              `${part.type}:${"toolCallId" in part ? part.toolCallId : ""}`
            ).resolve();
          }
        })(),
    });
    const idle = idleGate();
    const run = createAgentTUI({
      toolRenderers: createToolRenderers(),
      thread: {
        interrupt: () => realThread.interrupt(),
        send: async (text) => observe(await realThread.send(text)),
        steer: (text) => realThread.steer(text),
      },
      onTurnComplete: () => {
        finalizing.resolve();
        return releaseFinalizing.promise;
      },
    });
    await idle;
    const settled = idleGate();
    input("go\r");
    const usage = {
      inputTokens: { noCache: 1, total: 1 },
      outputTokens: { text: 1, total: 1 },
    };
    try {
      await providers[0]?.promise;
      expectBusy();
      const ticker = Reflect.get(footer(), "ticker");
      releaseProviders[0]?.resolve();
      const c = await controllers[0]?.promise;
      c?.enqueue({ type: "text-start", id: "text" });
      c?.enqueue({ type: "text-delta", id: "text", delta: "Still generating" });
      await event("assistant-output-delta:").promise;
      expectBusy();
      c?.enqueue({ type: "text-end", id: "text" });
      for (const index of [0, 1]) {
        c?.enqueue({
          type: "tool-input-start",
          id: `call${index}`,
          toolName: "read_file",
        });
        await event(`tool-call-input-start:call${index}`).promise;
        expectBusy();
        c?.enqueue({
          type: "tool-input-delta",
          id: `call${index}`,
          delta: `{"path":"${index}"}`,
        });
        await event(`tool-call-input-delta:call${index}`).promise;
        expectBusy();
        c?.enqueue({ type: "tool-input-end", id: `call${index}` });
        c?.enqueue({
          type: "tool-call",
          toolCallId: `call${index}`,
          toolName: "read_file",
          input: `{"path":"${index}"}`,
        });
      }
      c?.enqueue({
        type: "finish",
        finishReason: { raw: "tool_calls", unified: "tool-calls" },
        usage,
      });
      c?.close();
      await Promise.all(tools.map((value) => value.promise));
      expectBusy();
      releaseTools[0]?.resolve();
      await completedTools[0]?.promise;
      expectBusy();
      releaseTools[1]?.resolve();
      await providers[1]?.promise;
      expectBusy();
      expect.soft(Reflect.get(footer(), "ticker")).toBe(ticker);
      releaseProviders[1]?.resolve();
      const c2 = await controllers[1]?.promise;
      c2?.enqueue({ type: "text-start", id: "done" });
      c2?.enqueue({ type: "text-delta", id: "done", delta: "Done" });
      c2?.enqueue({ type: "text-end", id: "done" });
      c2?.enqueue({
        type: "finish",
        finishReason: { raw: "stop", unified: "stop" },
        usage,
      });
      c2?.close();
      await finalizing.promise;
      expectBusy();
    } finally {
      for (const value of [...releaseProviders, ...releaseTools]) {
        value.resolve();
      }
      releaseFinalizing.resolve();
      realThread.interrupt();
      await settled;
      await exit(run);
      await agent.dispose();
    }
  });
});
