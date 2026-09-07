import {
  type Component,
  type Container,
  Markdown,
  stripTerminalSequences,
  type Terminal,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentExtensionUi } from "../extensions/types";
import type { AssistantRendererContext } from "./assistant-renderer";
import type { BaseToolCallView } from "./tool-call-view";
import { ColdSnapshot, type TranscriptOwner } from "./transcript-owner";

const terminal = vi.hoisted(() => ({
  columns: 100,
  send: (_data: string): void => undefined,
  screen: undefined as TuiMainScreen | undefined,
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  const noop = () => undefined;
  class LocalTerminal implements Terminal {
    get columns() {
      return terminal.columns;
    }
    rows = 40;
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
      terminal.send = onInput;
    }
  }
  class LocalScreen extends actual.TuiMainScreen {
    override start() {
      terminal.screen = this;
      super.start();
    }
  }
  return {
    ...actual,
    ProcessTerminal: LocalTerminal,
    TuiMainScreen: LocalScreen,
  };
});

import { type AgentTUIConfig, createAgentTUI } from "./agent";
import { createModelCommand } from "./model-command";
import { ModelSelectorComponent } from "./model-selector";
import { TuiSessionMachine } from "./session-state";

const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Missing TUI event")),
          2000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const idle = () => {
  const signal = gate();
  const original = TuiSessionMachine.prototype.awaitInput;
  const spy = vi
    .spyOn(TuiSessionMachine.prototype, "awaitInput")
    .mockImplementation(function (this: TuiSessionMachine, resolve) {
      original.call(this, resolve);
      spy.mockRestore();
      signal.resolve();
    });
  return bounded(signal.promise);
};
const send = (text: string) => {
  for (const char of text) {
    terminal.send(char);
  }
};
const surface = () => {
  if (!terminal.screen) {
    throw new Error("TUI not mounted");
  }
  return terminal.screen;
};
const chat = () => surface().children[1] as Container;
const rows = (component: Component = chat(), width = 100) => [
  ...component.render(width),
];
const plain = () => stripTerminalSequences(rows().join("\n"));
const onRender = async (matches: () => boolean, action: () => void) => {
  const signal = gate();
  const screen = surface();
  const requestRender = screen.requestRender.bind(screen);
  const spy = vi.spyOn(screen, "requestRender").mockImplementation((force) => {
    requestRender(force);
    if (matches()) {
      signal.resolve();
    }
  });
  try {
    action();
    await bounded(signal.promise);
  } finally {
    spy.mockRestore();
  }
};
const prefix = () =>
  chat().children.map((component) => ({ component, lines: rows(component) }));
const unchanged = (snapshot: ReturnType<typeof prefix>) => {
  for (const { component, lines } of snapshot) {
    expect(rows(component)).toEqual(lines);
    expect(chat().children).toContain(component);
  }
};
function stream() {
  let next = gate<
    { event: AgentEvent; consumed: ReturnType<typeof gate<void>> } | undefined
  >();
  const run = {
    runId: "local-run",
    events: () =>
      (async function* () {
        for (;;) {
          const slot = await next.promise;
          next = gate();
          if (!slot) {
            return;
          }
          yield slot.event;
          slot.consumed.resolve();
        }
      })(),
  } as AgentTurn;
  return {
    run,
    end: () => next.resolve(undefined),
    emit: async (event: Record<string, unknown>) => {
      const consumed = gate();
      next.resolve({ event: event as AgentEvent, consumed });
      await bounded(consumed.promise);
    },
  };
}
async function fixture(extra: Partial<AgentTUIConfig> = {}) {
  const source = stream();
  const started = gate();
  const steered = gate();
  const ready = idle();
  const run = createAgentTUI({
    ...extra,
    thread: {
      send: () => {
        started.resolve();
        return Promise.resolve(source.run);
      },
      steer: () => {
        steered.resolve();
        return Promise.resolve(source.run);
      },
      interrupt: source.end,
    },
  });
  await ready;
  let active = false;
  return {
    ...source,
    async start() {
      active = true;
      send("USER\r");
      await bounded(started.promise);
    },
    async steer() {
      send("STEERING_USER\r");
      await bounded(steered.promise);
    },
    async command(text: string) {
      const ready = idle();
      send(`${text}\r`);
      await ready;
    },
    async finish() {
      const ready = idle();
      source.end();
      await ready;
      active = false;
    },
    async close() {
      if (active) {
        const ready = idle();
        source.end();
        await ready;
      }
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      await bounded(run);
    },
  };
}
beforeEach(() => {
  terminal.columns = 100;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.sequential("actual TUI transcript ownership", () => {
  it.each(["direct", "picker"] as const)(
    "appends only one model notice through %s and retains session notices and COLD header",
    async (method) => {
      let current = "MODEL_A";
      const cwd = "/CWD_SENTINEL";
      const header = { title: "LOGO", subtitle: `${current}\n${cwd}` };
      const footer = { text: "FOOTER_A" };
      const switchModel = vi.fn((id: string) => {
        current = id;
        header.subtitle = `${id}\n${cwd}`;
        footer.text = "FOOTER_B";
      });
      const models = {
        currentModelId: () => current,
        listModelIds: async () => ["MODEL_A", "MODEL_B"],
        switchModel,
      };
      const app = await fixture({
        header,
        footer,
        modelSelector: models,
        commands: [
          createModelCommand(models),
          {
            name: "rename",
            description: "fixture",
            execute: () => {
              header.subtitle = `${current}\n${cwd}\nSESSION_RENAMED`;
              return { success: true, action: { type: "refresh-header" } };
            },
          },
        ],
      });
      try {
        const before = rows(surface().children[0]);
        if (method === "direct") {
          await app.command("/model MODEL_B");
        } else {
          await onRender(
            () =>
              (surface().children.at(-1) as Container).children[0] instanceof
              ModelSelectorComponent,
            () => send("/model\r")
          );
          const ready = idle();
          send("MODEL_B\r");
          await ready;
        }
        expect(current).toBe("MODEL_B");
        expect(switchModel).toHaveBeenCalledExactlyOnceWith("MODEL_B");
        expect(rows(surface().children[0])).toEqual(before);
        const notice = plain()
          .split("\n")
          .filter((line) => line.trim());
        expect(notice).toHaveLength(1);
        expect(notice[0].match(/MODEL_B/g)).toHaveLength(1);
        expect(plain()).not.toContain(cwd);
        expect(
          stripTerminalSequences(rows(surface().children.at(-1)).join("\n"))
        ).toContain("FOOTER_B");
        const noticeRows = rows();
        await app.command("/rename");
        expect(rows().slice(0, noticeRows.length)).toEqual(noticeRows);
        expect(plain()).toContain("SESSION_RENAMED");
        expect(rows(surface().children[0])).toEqual(before);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["direct", "picker"] as const)(
    "replaces only the current HOT model notice through %s",
    async (method) => {
      let current = "MODEL_A";
      const models = {
        currentModelId: () => current,
        listModelIds: async () => [
          "MODEL_A",
          "MODEL_B",
          "MODEL_C",
          "MODEL_ERROR",
        ],
        switchModel: (id: string) => {
          if (id === "MODEL_ERROR") {
            throw new Error("SWITCH_SENTINEL");
          }
          current = id;
        },
      };
      const app = await fixture({
        commands: [createModelCommand(models)],
        modelSelector: models,
      });
      const choose = async (id: string) => {
        if (method === "direct") {
          await app.command(`/model ${id}`);
          return;
        }
        await onRender(
          () =>
            (surface().children.at(-1) as Container).children[0] instanceof
            ModelSelectorComponent,
          () => send("/model\r")
        );
        const ready = idle();
        send(`${id}\r`);
        await ready;
      };
      try {
        await choose("MODEL_B");
        await choose("MODEL_C");
        expect(
          plain()
            .split("\n")
            .filter((line) => line.trim())
        ).toHaveLength(1);
        expect(plain()).not.toContain("MODEL_B");
        expect(plain()).toContain("MODEL_C");
        expect(rows().join("\n")).toContain("\x1b[47m\x1b[30m");
        await choose("MODEL_ERROR");
        expect(plain()).toContain("MODEL_C");
        expect(plain()).toContain("SWITCH_SENTINEL");
        const cold = rows();
        await choose("MODEL_B");
        expect(rows().slice(0, cold.length)).toEqual(cold);
        expect(plain()).toContain("MODEL_B");
        expect(plain()).toContain("MODEL_C");
      } finally {
        await app.close();
      }
    }
  );

  it.each(["unchanged", "error", "cancel"] as const)(
    "does not claim a picker model change on %s",
    async (outcome) => {
      const switchModel = vi.fn(() => {
        if (outcome === "error") {
          throw new Error("SWITCH_ERROR_SENTINEL");
        }
      });
      const models = {
        currentModelId: () => "MODEL_A",
        listModelIds: async () => ["MODEL_A", "MODEL_B"],
        switchModel,
      };
      const app = await fixture({
        commands: [createModelCommand(models)],
        modelSelector: models,
      });
      try {
        await onRender(
          () =>
            (surface().children.at(-1) as Container).children[0] instanceof
            ModelSelectorComponent,
          () => send("/model\r")
        );
        const ready = idle();
        send(outcome === "cancel" ? "\x1b" : "\r");
        await ready;
        if (outcome === "error") {
          expect(plain()).toContain("SWITCH_ERROR_SENTINEL");
          expect(plain()).not.toContain("MODEL_A");
        } else {
          expect(plain().trim()).toBe("");
        }
        expect(switchModel).toHaveBeenCalledTimes(outcome === "cancel" ? 0 : 1);
      } finally {
        await app.close();
      }
    }
  );

  it("does not rewrite the startup header when current model/session changes", async () => {
    const header = { title: "LOGO", subtitle: "MODEL_A" };
    const app = await fixture({
      header,
      commands: [
        {
          name: "change",
          description: "fixture",
          execute: () => {
            header.subtitle = "MODEL_B_SESSION_B";
            return {
              success: true,
              message: "MODEL_B_SESSION_B",
              action: { type: "refresh-header" },
            };
          },
        },
      ],
    });
    try {
      const before = rows(surface().children[0]);
      await app.command("/change");
      expect(rows(surface().children[0])).toEqual(before);
      expect(plain()).toContain("MODEL_B_SESSION_B");
    } finally {
      await app.close();
    }
  });

  it("settles a pulsing notice before user append, not on its historical timeout", async () => {
    const callbacks: (() => void)[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 140) {
        callbacks.push(fn);
        const handle = original(fn, ms, ...args);
        clearTimeout(handle);
        return handle;
      }
      return original(fn, ms, ...args);
    }) as typeof setTimeout);
    const app = await fixture();
    try {
      await app.command("");
      const normal = rows();
      await app.command("");
      expect(rows()).not.toEqual(normal);
      await app.start();
      const cold = prefix();
      expect(rows().slice(0, normal.length)).toEqual(normal);
      for (const fn of callbacks) {
        fn();
      }
      unchanged(cold);
    } finally {
      await app.close();
    }
  });

  it("appends reverse A/B results below already completed content", async () => {
    const app = await fixture();
    try {
      await app.start();
      for (const toolCallId of ["A", "B"]) {
        await app.emit({
          type: "tool-call",
          toolCallId,
          toolName: "fixture",
          input: { path: toolCallId },
        });
      }
      await app.emit({
        type: "tool-result",
        toolCallId: "B",
        toolName: "fixture",
        output: { type: "text", value: "RESULT_B" },
      });
      const cold = prefix();
      await app.emit({
        type: "tool-result",
        toolCallId: "A",
        toolName: "fixture",
        output: { type: "text", value: "RESULT_A" },
      });
      unchanged(cold);
      expect(plain().indexOf("RESULT_A")).toBeGreaterThan(
        plain().indexOf("RESULT_B")
      );
    } finally {
      await app.close();
    }
  });

  it("isolates completed answers even when an old custom renderer ignores abort", async () => {
    let late!: () => void;
    let context!: AssistantRendererContext;
    const app = await fixture({
      assistantRenderer: (ctx) => {
        context = ctx;
        const view = new Markdown("", 1, 0, ctx.markdownTheme);
        late = () => {
          view.setText("BUGGY_LATE_RENDER");
          ctx.requestRender();
          ctx.notify("STALE_NOTICE");
        };
        return view;
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "FIRST_ANSWER" });
      await app.emit({ type: "assistant-output", text: "FIRST_ANSWER" });
      const cold = prefix();
      late();
      unchanged(cold);
      expect(plain()).not.toContain("STALE_NOTICE");
      expect(context.signal.aborted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("continues streaming below steering without changing its old answer", async () => {
    const app = await fixture();
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "BEFORE_STEERING",
      });
      await app.steer();
      const cold = prefix();
      await app.emit({
        type: "assistant-output-delta",
        text: "AFTER_STEERING",
      });
      unchanged(cold);
      expect(plain().indexOf("AFTER_STEERING")).toBeGreaterThan(
        plain().indexOf("STEERING_USER")
      );
    } finally {
      await app.close();
    }
  });

  it.each([48, 100])(
    "expands only completed text at width %i",
    async (width) => {
      const app = await fixture();
      terminal.columns = width;
      const markers = Array.from(
        { length: 16 },
        (_, i) => `CELL_${String(i).padStart(2, "0")}`
      );
      const answer = [
        "| HEADER_ID | VALUE_ID |",
        "| --- | --- |",
        ...markers.map((m) => `| ${m} | OK |`),
        "",
        "VERIFY_A",
        "",
        "VERIFY_B",
        "",
        "VERIFY_C",
      ].join("\n");
      try {
        await app.start();
        await app.emit({
          type: "tool-result",
          toolCallId: "tool",
          toolName: "fixture",
          output: { type: "text", value: "TOOL_PREFIX" },
        });
        const cold = prefix();
        await app.emit({ type: "assistant-output-delta", text: answer });
        const active = chat().children.at(-1);
        expect(rows(active, width)).toHaveLength(8);
        expect(
          stripTerminalSequences(rows(active, width).join("\n"))
        ).not.toContain("HEADER_ID");
        await app.emit({ type: "assistant-output", text: answer });
        unchanged(cold);
        const final = stripTerminalSequences(rows(chat(), width).join("\n"));
        for (const marker of [
          "HEADER_ID",
          ...markers,
          "VERIFY_A",
          "VERIFY_B",
          "VERIFY_C",
        ]) {
          expect(final.split(marker)).toHaveLength(2);
        }
        expect(chat().children.at(-1)).toBeInstanceOf(ColdSnapshot);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    "fallback",
    "short",
    "code",
    "late-reasoning",
    "abort",
    "error",
    "steering",
    "tools",
  ] as const)("finalizes text only at its own boundary: %s", async (mode) => {
    const app = await fixture();
    const lines = Array.from(
      { length: mode === "short" ? 2 : 24 },
      (_, i) => `TEXT_${String(i).padStart(2, "0")}`
    );
    const text =
      mode === "code"
        ? `\`\`\`ts\n${lines.join("\n")}\n\`\`\``
        : lines.join("\n");
    const reasoning = Array.from(
      { length: 20 },
      (_, i) => `THINK_${String(i).padStart(2, "0")}`
    ).join("\n");
    try {
      await app.start();
      if (mode === "late-reasoning") {
        await app.emit({ type: "assistant-reasoning-delta", text: reasoning });
      }
      if (mode !== "fallback") {
        await app.emit({ type: "assistant-output-delta", text });
      }
      if (mode === "late-reasoning") {
        await app.emit({ type: "assistant-reasoning", text: reasoning });
        expect(chat().children.at(-1)).not.toBeInstanceOf(ColdSnapshot);
      }
      const streamed = rows();
      if (mode === "abort" || mode === "error") {
        await app.emit(
          mode === "abort"
            ? { type: "turn-abort" }
            : { type: "turn-error", message: "FAIL_ID" }
        );
        await app.finish();
        expect(plain()).not.toContain("TEXT_00");
        expect(plain()).toContain("TEXT_23");
      } else if (mode === "steering") {
        await app.steer();
        const cold = prefix();
        const continuation = text.replaceAll("TEXT", "NEXT");
        await app.emit({ type: "assistant-output-delta", text: continuation });
        await app.emit({ type: "assistant-output", text: text + continuation });
        unchanged(cold);
        expect(plain()).not.toContain("TEXT_00");
        for (const marker of lines) {
          expect(plain().split(marker.replace("TEXT", "NEXT"))).toHaveLength(2);
        }
      } else {
        await app.emit({ type: "assistant-output", text });
        for (const marker of lines) {
          expect(plain().split(marker)).toHaveLength(2);
        }
        if (mode === "short") {
          expect(rows()).toEqual(streamed);
        }
        if (mode === "late-reasoning") {
          expect(plain()).not.toContain("THINK_00");
          expect(plain().match(/THINK_\d+/g)).toHaveLength(8);
        }
        if (mode === "tools") {
          const cold = prefix();
          await app.emit({
            type: "tool-call",
            toolCallId: "next",
            toolName: "fixture",
            input: {},
          });
          await app.emit({
            type: "tool-result",
            toolCallId: "next",
            toolName: "fixture",
            output: { type: "text", value: "RESULT_ID" },
          });
          await app.emit({ type: "step-start" });
          await app.emit({ type: "assistant-output", text: "FINAL_ID" });
          unchanged(cold);
          expect(plain().split("TEXT_00")).toHaveLength(2);
        }
      }
    } finally {
      await app.close();
    }
  });

  it("captures the full current async renderer once, then revokes it", async () => {
    const ready = gate();
    const release = gate();
    const dispose = vi.fn();
    const setText = vi.fn();
    let context!: AssistantRendererContext;
    let display = ["PENDING_ID"];
    const app = await fixture({
      assistantRenderer: (ctx) => {
        context = ctx;
        release.promise.then(() => {
          display = Array.from(
            { length: 20 },
            (_, i) => `CUSTOM_${String(i).padStart(2, "0")}`
          );
          ctx.requestRender();
          ready.resolve();
        });
        return {
          invalidate: () => undefined,
          setText,
          dispose,
          render: () => display,
        };
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "SOURCE_ID" });
      release.resolve();
      await bounded(ready.promise);
      expect(rows(chat().children.at(-1))).toHaveLength(8);
      await app.emit({ type: "assistant-output", text: "SOURCE_ID" });
      expect(plain().match(/CUSTOM_\d+/g)).toHaveLength(20);
      expect(setText).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(context.signal.aborted).toBe(true);
      const cold = prefix();
      display = ["LATE_ID"];
      context.requestRender();
      context.notify("LATE_NOTICE_ID");
      unchanged(cold);
      expect(plain()).not.toContain("LATE_ID");
    } finally {
      await app.close();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("freezes the chosen reasoning tail independently of a long answer and resize", async () => {
    const app = await fixture();
    const reasoning = Array.from(
      { length: 12 },
      (_, i) => `REASON_${i} 漢字🙂`
    ).join("\n");
    const answer = Array.from({ length: 20 }, (_, i) => `ANSWER_${i}`).join(
      "\n"
    );
    try {
      await app.start();
      await app.emit({ type: "assistant-reasoning-delta", text: reasoning });
      const shown = rows(chat().children[chat().children.length - 1]);
      expect(shown).toHaveLength(8);
      await app.emit({ type: "assistant-reasoning", text: reasoning });
      const cold = prefix();
      expect(rows(chat().children[chat().children.length - 1])).toEqual(shown);
      await app.emit({ type: "assistant-output-delta", text: answer });
      await app.emit({ type: "assistant-output", text: answer });
      unchanged(cold);
      const complete = rows();
      rows(chat(), 31);
      rows(chat(), 140);
      expect(rows()).toEqual(complete);
      expect(plain()).toContain("REASON_11");
      expect(plain()).not.toContain("REASON_0");
      expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it("keeps exact canonical arguments across interleaved A/B/C continuations and isolates retained tool setters", async () => {
    const calls: { input: unknown; output: unknown; view: BaseToolCallView }[] =
      [];
    const app = await fixture({
      toolRenderers: {
        fixture: (view, input, output) => {
          calls.push({ input, output, view });
          view.setPrettyBlock("fixture", String(output ?? "PENDING"));
        },
      },
    });
    const source = {
      A: { path: "A", content: "one\ntwo\n漢字\n" },
      B: { path: "B", content: "B source" },
      C: { path: "C", content: "C source" },
    };
    const encoded = Object.fromEntries(
      Object.entries(source).map(([id, input]) => [id, JSON.stringify(input)])
    );
    try {
      await app.start();
      for (const id of ["A", "B", "C"]) {
        await app.emit({
          type: "tool-call-input-start",
          toolCallId: id,
          toolName: "fixture",
        });
        await app.emit({
          type: "tool-call-input-delta",
          toolCallId: id,
          inputTextDelta: encoded[id].slice(0, 12),
        });
      }
      const old = prefix().slice(0, -1);
      for (const id of ["A", "C", "B"] as const) {
        await app.emit({
          type: "tool-call-input-delta",
          toolCallId: id,
          inputTextDelta: encoded[id].slice(12),
        });
        await app.emit({
          type: "tool-call",
          toolCallId: id,
          toolName: "fixture",
          input: source[id],
        });
      }
      unchanged(old);
      for (const id of ["C", "A", "B"] as const) {
        const before = prefix().filter(
          (entry) => entry.component instanceof ColdSnapshot
        );
        await app.emit({
          type: "tool-result",
          toolCallId: id,
          toolName: "fixture",
          output: { type: "text", value: `RESULT_${id}` },
        });
        unchanged(before);
        expect(
          [...calls].reverse().find((call) => call.output === `RESULT_${id}`)
            ?.input
        ).toEqual(source[id]);
      }
      const cold = prefix();
      for (const { view } of calls) {
        view.setPrettyBlock("STALE", "BUGGY_TOOL");
        view.clear();
      }
      unchanged(cold);
      expect(plain()).not.toContain("BUGGY_TOOL");
      expect(plain().indexOf("RESULT_C")).toBeLessThan(
        plain().indexOf("RESULT_A")
      );
      expect(plain().indexOf("RESULT_A")).toBeLessThan(
        plain().indexOf("RESULT_B")
      );
      expect(JSON.parse(encoded.A)).toEqual(source.A);
    } finally {
      await app.close();
    }
  });

  it.each(["empty", "error", "abort"] as const)(
    "seals partial output on %s terminal completion",
    async (ending) => {
      const app = await fixture();
      try {
        await app.start();
        if (ending !== "empty") {
          await app.emit({ type: "assistant-output-delta", text: "PARTIAL" });
        }
        if (ending === "error") {
          await app.emit({ type: "turn-error", message: "ERROR_SENTINEL" });
        }
        if (ending === "abort") {
          await app.emit({ type: "turn-abort" });
        }
        await app.finish();
        expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
          true
        );
        if (ending !== "empty") {
          expect(plain()).toContain("PARTIAL");
        }
        if (ending === "error") {
          expect(plain()).toContain("ERROR_SENTINEL");
        }
      } finally {
        await app.close();
      }
    }
  );

  it("retains old output on failed replacement load and revokes callbacks across explicit reset", async () => {
    const callbacks: (() => void)[] = [];
    let fail = true;
    const app = await fixture({
      assistantRenderer: (ctx) => {
        const view = new Markdown("", 1, 0, ctx.markdownTheme);
        callbacks.push(() => {
          view.setText("STALE_AFTER_RESET");
          ctx.notify("STALE_NOTICE");
          ctx.requestRender();
        });
        return view;
      },
      commands: [
        {
          name: "replace",
          description: "fixture",
          execute: () => ({
            success: true,
            action: { type: "session", clear: true },
          }),
        },
      ],
      sessionSelector: {
        currentSessionKey: () => "new-session",
        listSessions: async () => [],
        switchSession: async () => undefined,
        loadCurrentHistory: () =>
          fail
            ? Promise.reject(new Error("LOAD_FAILED"))
            : Promise.resolve([{ role: "assistant", content: "REPLAY" }]),
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "OLD_ANSWER" });
      await app.finish();
      const before = prefix();
      const epoch = (chat() as TranscriptOwner).epoch;
      await app.command("/replace");
      unchanged(before);
      expect(plain()).toContain("LOAD_FAILED");
      expect((chat() as TranscriptOwner).epoch).toBe(epoch);
      fail = false;
      await app.command("/replace");
      expect((chat() as TranscriptOwner).epoch).toBe(epoch + 1);
      const cold = prefix();
      for (const callback of callbacks) {
        callback();
      }
      unchanged(cold);
      expect(plain()).toContain("REPLAY");
      expect(plain()).not.toContain("OLD_ANSWER");
      expect(plain()).not.toContain("STALE");
    } finally {
      await app.close();
    }
  });

  it("allows enrichment only while HOT and seals before reload without clearing history", async () => {
    let complete!: () => void;
    const host = new AbortController();
    const app = await fixture({
      assistantRendererSignal: host.signal,
      assistantRenderer: (ctx) => {
        const view = new Markdown("", 1, 0, ctx.markdownTheme);
        complete = () => {
          view.setText("READY_ENRICHMENT");
          ctx.requestRender();
        };
        return view;
      },
      commands: [
        {
          name: "reload",
          description: "fixture",
          execute: () => ({
            success: true,
            action: { type: "reload" },
            message: "RELOADED",
          }),
        },
      ],
      onCommandAction: () => {
        host.abort();
        complete();
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "FALLBACK" });
      complete();
      expect(plain()).toContain("READY_ENRICHMENT");
      await app.finish();
      const cold = prefix();
      const epoch = (chat() as TranscriptOwner).epoch;
      await app.command("/reload");
      unchanged(cold);
      expect((chat() as TranscriptOwner).epoch).toBe(epoch);
    } finally {
      await app.close();
    }
  });

  it.each([false, true])(
    "freezes the %s-ready graphic or fallback without invoking its renderer on resize",
    async (readyAtSeal) => {
      let ready = false;
      let renderCount = 0;
      let context!: AssistantRendererContext;
      const asset = "\x1b_Ga=T,f=100;ASSET\x1b\\";
      const graphicRows = [asset, ...Array.from({ length: 12 }, () => "")];
      const app = await fixture({
        assistantRenderer: (ctx) => {
          context = ctx;
          const view = new Markdown("", 1, 0, ctx.markdownTheme);
          const render = view.render.bind(view);
          view.render = (width) => {
            renderCount += 1;
            return ready ? [...graphicRows] : render(width);
          };
          return view;
        },
      });
      try {
        await app.start();
        await app.emit({
          type: "assistant-output-delta",
          text: "GRAPHIC_FALLBACK",
        });
        ready = readyAtSeal;
        await app.emit({ type: "assistant-output", text: "GRAPHIC_FALLBACK" });
        const cold = prefix();
        const count = renderCount;
        ready = true;
        context.requestRender();
        rows(chat(), 12);
        unchanged(cold);
        expect(renderCount).toBe(count);
        const frozen = chat().children[chat().children.length - 1];
        if (readyAtSeal) {
          expect(frozen.render(12)).toEqual(graphicRows);
        } else {
          expect(plain()).toContain("GRAPHIC_FALLBACK");
          expect(rows().join("\n")).not.toContain(asset);
        }
        expect(context.signal.aborted).toBe(true);
      } finally {
        await app.close();
      }
    }
  );

  it("ignores an old stream after an explicit active-turn reset and cancels old prompts/status", async () => {
    let ui!: CodingAgentExtensionUi;
    const app = await fixture({
      onExtensionUiReady: (create) => {
        ui = create();
      },
      commands: [
        {
          name: "new",
          description: "fixture",
          allowDuringActiveTurn: true,
          execute: () => ({
            success: true,
            message: "RESET_DONE",
            action: { type: "session", clear: true },
          }),
        },
      ],
      sessionSelector: {
        currentSessionKey: () => "new",
        listSessions: async () => [],
        switchSession: async () => undefined,
        loadCurrentHistory: async () => [
          { role: "assistant", content: "NEW_EPOCH" },
        ],
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "OLD_STREAM" });
      const epoch = (chat() as TranscriptOwner).epoch;
      await onRender(
        () => plain().includes("RESET_DONE"),
        () => send("/new\r")
      );
      expect((chat() as TranscriptOwner).epoch).toBe(epoch + 1);
      const afterReset = rows();
      await app.emit({ type: "assistant-output-delta", text: "STALE_DELTA" });
      await app.emit({
        type: "tool-call",
        toolCallId: "reused",
        toolName: "fixture",
        input: { stale: true },
      });
      expect(rows()).toEqual(afterReset);
      const prompt = ui.input({ label: "OLD_EPOCH_PROMPT" });
      ui.status("OLD_EPOCH_STATUS");
      (chat() as TranscriptOwner).reset("session-navigation");
      await expect(prompt).resolves.toBeUndefined();
      expect(
        stripTerminalSequences(surface().render(100).join("\n"))
      ).not.toContain("OLD_EPOCH_STATUS");
    } finally {
      await app.close();
    }
  });

  it("freezes before multiline rejected steering and resumes below the rejection", async () => {
    const app = await fixture({
      preprocessUserInput: async (input) =>
        input === "STEERING_USER"
          ? { success: false, error: "REJECT_ONE\nREJECT_TWO" }
          : undefined,
    });
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "BEFORE_REJECTION",
      });
      await onRender(
        () => plain().includes("REJECT_TWO"),
        () => send("STEERING_USER\r")
      );
      const cold = prefix().filter(
        (entry) => entry.component instanceof ColdSnapshot
      );
      await app.emit({
        type: "assistant-output-delta",
        text: "AFTER_REJECTION",
      });
      unchanged(cold);
      expect(plain().indexOf("AFTER_REJECTION")).toBeGreaterThan(
        plain().indexOf("REJECT_TWO")
      );
    } finally {
      await app.close();
    }
  });

  it("hands off even empty tool input and freezes the pending card on abort", async () => {
    const app = await fixture();
    try {
      await app.start();
      await app.emit({
        type: "assistant-output-delta",
        text: "PARTIAL_REASON",
      });
      await app.emit({
        type: "tool-call-input-start",
        toolCallId: "EMPTY_A",
        toolName: "fixture",
      });
      const cold = prefix().filter(
        (entry) => entry.component instanceof ColdSnapshot
      );
      await app.emit({
        type: "tool-call-input-start",
        toolCallId: "EMPTY_B",
        toolName: "fixture",
      });
      unchanged(cold);
      await app.emit({ type: "turn-abort" });
      expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it.each(["error-text", "execution-denied"] as const)(
    "appends a late %s result without changing the old tool",
    async (type) => {
      const app = await fixture();
      try {
        await app.start();
        await app.emit({
          type: "tool-call",
          toolCallId: "A",
          toolName: "fixture",
          input: {},
        });
        await app.emit({ type: "assistant-output", text: "LATER_ANSWER" });
        const cold = prefix();
        await app.emit({
          type: "tool-result",
          toolCallId: "A",
          toolName: "fixture",
          output: { type, value: "ERROR_RESULT", reason: "DENIED_RESULT" },
        });
        unchanged(cold);
        expect(chat().children.every((c) => c instanceof ColdSnapshot)).toBe(
          true
        );
      } finally {
        await app.close();
      }
    }
  );

  it("keeps concurrent extension prompts in the HOT composer, restores focus and preserves COLD", async () => {
    let ui!: CodingAgentExtensionUi;
    let secondUi!: CodingAgentExtensionUi;
    const firstHost = new AbortController();
    const secondHost = new AbortController();
    const app = await fixture({
      onExtensionUiReady: (create) => {
        ui = create(firstHost.signal);
        secondUi = create(secondHost.signal);
      },
    });
    try {
      await app.start();
      await app.emit({ type: "assistant-output-delta", text: "ANSWER" });
      await app.finish();
      const cold = prefix();
      const overlay = vi.spyOn(surface(), "showOverlay");
      const one = ui.input({ label: "FIRST_PROMPT", initialValue: "draft" });
      const two = secondUi.select({
        label: "SECOND_PROMPT",
        options: [
          { label: "ONE", value: "one" },
          { label: "TWO", value: "two" },
        ],
      });
      const composer = surface().children.at(-1) as Container;
      expect(stripTerminalSequences(rows(composer).join("\n"))).toContain(
        "SECOND_PROMPT"
      );
      firstHost.abort();
      await expect(one).resolves.toBeUndefined();
      expect(stripTerminalSequences(rows(composer).join("\n"))).toContain(
        "SECOND_PROMPT"
      );
      terminal.send("\x1b[13;1:3u");
      expect(composer.children[0]).not.toBeUndefined();
      terminal.send("\x1b[B");
      send("\r");
      await expect(two).resolves.toBe("two");
      unchanged(cold);
      expect(overlay).not.toHaveBeenCalled();
      expect(composer.children.at(-1)?.render(100)).toHaveLength(1);
      const confirm = ui.confirm("ABORTED");
      await expect(confirm).resolves.toBe(false);
      const input = secondUi.input({ label: "CANCEL_PROMPT" });
      send("\x03");
      await expect(input).resolves.toBeUndefined();
    } finally {
      firstHost.abort();
      secondHost.abort();
      await app.close();
    }
  });
});
