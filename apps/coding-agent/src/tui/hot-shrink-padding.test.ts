import {
  type Component,
  type MarkdownTheme,
  stripTerminalSequences,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_SPINNER_INTERVAL_MS } from "./pending-spinner";
import { addChatComponent } from "./stream-handlers";
import { BaseToolCallView } from "./tool-call-view";
import { ColdSnapshot, TranscriptOwner } from "./transcript-owner";

const identity = (text: string): string => text;
const theme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};
const long = Array.from({ length: 30 }, (_, i) => `ROW_${i}`).join("\n");
const blanks = (count: number) => Array.from({ length: count }, () => "");
const mount = (owner: TranscriptOwner) =>
  owner.acquire(() => new BaseToolCallView("call", "custom", theme), {
    leadingSpacer: false,
    settle: (view) => view.settle(),
    dispose: (view) => view.dispose(),
  });

function expectReservation(
  owner: TranscriptOwner,
  view: Component,
  width: number,
  height: number
): void {
  const real = view.render(width);
  expect(owner.render(width)).toEqual([
    ...real,
    ...blanks(height - real.length),
  ]);
}

describe("HOT block height reservation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps the pending spinner live and settles it when sealing", () => {
    const owner = new TranscriptOwner(() => 100);
    const lease = mount(owner);
    const initial = owner.render(100);
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    const tick = owner.render(100);
    expect(tick).not.toEqual(initial);
    expect(tick).toHaveLength(initial.length);
    owner.finish(lease);
    const cold = owner.render(100);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
    expect(owner.render(100)).toEqual(cold);
  });

  it("retains same-view total height below a shrinking eight-row body", () => {
    const owner = new TranscriptOwner(() => 100);
    const lease = mount(owner);
    lease.view.setPrettyBlock("HEADER", long);
    expect(owner.render(100)).toHaveLength(10);
    lease.view.setPrettyBlock("HEADER", "SHORT");
    expect(lease.view.render(100)).toHaveLength(3);
    expectReservation(owner, lease.view, 100, 10);
    lease.view.setPrettyBlock("HEADER", long);
    expectReservation(owner, lease.view, 100, 10);
    owner.finish();
  });

  it("includes header wrapping and continuation labels outside the body cap", () => {
    const owner = new TranscriptOwner(() => 48);
    const lease = owner.acquire(
      () => new BaseToolCallView("call", "custom", theme),
      {
        label: "Continuation",
        leadingSpacer: false,
        dispose: (v) => v.dispose(),
      }
    );
    lease.view.setPrettyBlock("HEADER ".repeat(30), long);
    const before = owner.render(48);
    expect(before.length).toBeGreaterThan(11);
    lease.view.setPrettyBlock("SHORT", long);
    const after = owner.render(48);
    expect(after).toHaveLength(before.length);
    expect(after.slice(1, 11)).toEqual(lease.view.render(48));
    expect(after.slice(11)).toEqual(blanks(before.length - 11));
    owner.finish();
  });

  it("seals a custom empty result with padding and preserves full input/output", async () => {
    const owner = new TranscriptOwner(() => 100);
    const lease = owner.acquire(
      () =>
        new BaseToolCallView("call", "custom", theme, undefined, false, {
          custom: (view, _input, output) => {
            if (output !== undefined) {
              view.setPrettyBlock("DONE", "");
            }
          },
        }),
      { leadingSpacer: false, dispose: (v) => v.dispose() }
    );
    const input = { message: long };
    const buffer = JSON.stringify(input);
    await lease.view.appendInputChunk(buffer);
    expect(owner.render(100)).toHaveLength(10);
    lease.view.setFinalInput(input);
    lease.view.setOutput("original result");
    expect(lease.view.render(100)).toHaveLength(1);
    // Result delivery seals without an intervening HOT render.
    owner.finish(lease);
    const snapshot = owner.render(100);
    expect(snapshot).toEqual([...lease.view.render(100), ...blanks(9)]);
    expect(owner.children[0]).toBeInstanceOf(ColdSnapshot);
    expect(owner.children[0]?.render(100)).toEqual(lease.view.render(100));
    expect(lease).toMatchObject({ active: false });
    expect(lease.view).toMatchObject({
      inputBuffer: buffer,
      finalInput: input,
      output: "original result",
    });
    lease.view.setOutput("late mutation");
    owner.invalidate();
    expect(owner.render(100)).toEqual(snapshot);
  });

  it.each([false, true])(
    "retains actual partial-parser replacement height (raw=%s)",
    async (raw) => {
      const owner = new TranscriptOwner(() => 100);
      const lease = owner.acquire(
        () => new BaseToolCallView("call", "custom", theme, undefined, raw),
        { leadingSpacer: false, dispose: (v) => v.dispose() }
      );
      const prefix = JSON.stringify({ message: long }).slice(0, -1);
      await lease.view.appendInputChunk(prefix);
      const height = owner.render(100).length;
      const suffix = ',"message":"SHORT"}';
      await lease.view.appendInputChunk(suffix);
      expect(lease.view.render(100).length).toBeLessThan(height);
      expectReservation(owner, lease.view, 100, height);
      expect(lease.active).toBe(true);
      expect(lease.view).toMatchObject({
        inputBuffer: prefix + suffix,
        parsedInput: { message: "SHORT" },
      });
      owner.finish();
    }
  );

  it("transfers only synthetic reservation to the shared tail", () => {
    const owner = new TranscriptOwner(() => 100);
    const first = mount(owner);
    first.view.setPrettyBlock("HEADER", long);
    owner.render(100);
    first.view.setPrettyBlock("HEADER", "SHORT");
    const second = owner.acquire(() => new Text("NEXT", 0, 0), {
      leadingSpacer: false,
    });
    expect(owner.children[0]?.render(100)).toEqual(first.view.render(100));
    expect(owner.children[0]?.render(100)).toHaveLength(3);
    expect(owner.children[1]?.render(100)).toEqual(second.view.render(100));
    expect(owner.render(100)).toEqual([
      ...first.view.render(100),
      ...second.view.render(100),
      ...blanks(6),
    ]);
    owner.finish();
  });

  it.each([false, true])(
    "reuses six rows after a ten-to-four shrink (immediate seal=%s)",
    (immediate) => {
      const owner = new TranscriptOwner(() => 100);
      const first = owner.acquire(() => new Text(`${"A\n".repeat(9)}A`, 0, 0), {
        leadingSpacer: false,
      });
      expect(owner.render(100)).toHaveLength(10);
      first.view.setText("A1\nA2\nA3\nA4");
      if (!immediate) {
        expect(owner.render(100)).toHaveLength(10);
      }
      owner.finish(first);
      const cold = owner.children[0];
      const actual = first.view.render(100);
      expect(cold?.render(100)).toEqual(actual);
      expect(actual).toHaveLength(4);
      expect(owner.render(100)).toEqual([...actual, ...blanks(6)]);
      const second = owner.acquire(() => new Text("B1\nB2\nB3", 0, 0));
      expect(owner.render(100)).toEqual([
        ...actual,
        "",
        ...second.view.render(100),
        ...blanks(2),
      ]);
      second.view.setText("B1\nB2\nB3\nB4\nB5");
      expect(owner.render(100)).toHaveLength(10);
      second.view.setText("B1\nB2\nB3\nB4\nB5\nB6");
      expect(owner.render(100)).toHaveLength(11);
      second.view.setText("B1");
      owner.finish(second);
      const third = owner.acquire(() => new Text("C1\nC2", 0, 0), {
        label: "Continuation",
      });
      expect(owner.render(100)).toHaveLength(11);
      expect(owner.render(100).slice(0, 7)).toEqual([
        ...actual,
        "",
        ...second.view.render(100),
        "",
      ]);
      owner.finish(third);
      expect(cold?.render(100)).toEqual(actual);
      expect(owner.children).toContain(cold);
    }
  );

  it("one-shot appends consume the reserve, including their normal separator", () => {
    const owner = new TranscriptOwner(() => 100);
    const first = mount(owner);
    first.view.setPrettyBlock("HEADER", long);
    expect(owner.render(100)).toHaveLength(10);
    first.view.setPrettyBlock("HEADER", "SHORT");
    addChatComponent(owner, new Text("USER1\nUSER2\nUSER3", 0, 0));
    const actual = owner.children.flatMap((child) => child.render(100));
    expect(actual).toHaveLength(7);
    expect(owner.render(100)).toEqual([...actual, ...blanks(3)]);
    owner.reset("session-navigation");
    expect(owner.render(100)).toEqual([]);
    owner.addChild(new Text("NEW", 0, 0));
    expect(owner.render(100)).toHaveLength(1);
  });

  it.each(["", "ERROR"])(
    "partial or error output preserves earlier genuine blank rows: %j",
    async (result) => {
      const owner = new TranscriptOwner(() => 100);
      const genuine = ["OLD", "", "", "MARKDOWN GAP", "", ""];
      owner.addChild({ render: () => genuine, invalidate: vi.fn() });
      const cold = owner.children[0];
      const lease = mount(owner);
      await lease.view.appendInputChunk(
        JSON.stringify({ message: long }).slice(0, -1)
      );
      const height = owner.render(100).length;
      lease.view.setPrettyBlock("DONE", result, { isError: result !== "" });
      owner.finish();
      addChatComponent(owner, new Text("USER", 0, 0));
      expect(cold?.render(100)).toEqual(genuine);
      expect(owner.render(100).slice(0, genuine.length)).toEqual(genuine);
      expect(owner.render(100)).toHaveLength(height);
    }
  );

  it("drops sealed synthetic reserve on resize without reopening COLD content", () => {
    let width = 100;
    const owner = new TranscriptOwner(() => width);
    let rows = ["ACTUAL", ...blanks(9)];
    const render = vi.fn(() => rows);
    owner.acquire(() => ({ render, invalidate: vi.fn() }), {
      leadingSpacer: false,
    });
    owner.render(width);
    rows = ["ACTUAL", "", ""];
    owner.finish();
    const count = render.mock.calls.length;
    expect(owner.render(width)).toHaveLength(10);
    width = 48;
    expect(owner.render(width)).toEqual(rows);
    width = 100;
    expect(owner.render(width)).toEqual(rows);
    expect(render).toHaveBeenCalledTimes(count);
  });

  it.each([
    "REAL\n\n",
    "\x1b_Ga=T,f=100;ASSET\x1b\\",
    "\x1b]1337;File=inline=1:ASSET\x07",
    "\x1bPqASSET\x1b\\",
  ])("never reclaims genuine blank or graphic reserved rows: %j", (payload) => {
    const owner = new TranscriptOwner(() => 100);
    const actual = [...payload.split("\n"), ...blanks(4)];
    let rows = [...actual, ...Array.from({ length: 8 }, () => "PREVIEW")];
    owner.acquire(() => ({ render: () => rows, invalidate: vi.fn() }), {
      leadingSpacer: false,
    });
    const high = owner.render(100).length;
    rows = actual;
    owner.finish();
    const cold = owner.children[0];
    owner.acquire(() => new Text("NEXT", 0, 0));
    expect(cold?.render(100)).toEqual(actual);
    expect(owner.render(100)).toEqual([
      ...actual,
      "",
      ...new Text("NEXT", 0, 0).render(100),
      ...blanks(6),
    ]);
    expect(owner.render(100)).toHaveLength(high);
    owner.finish();
    expect(cold?.render(100)).toEqual(actual);
  });

  it("recomputes on every width change, including returning to a prior width", () => {
    let width = 48;
    const owner = new TranscriptOwner(() => width);
    const lease = mount(owner);
    lease.view.setPrettyBlock("HEADER", "word ".repeat(35));
    const narrow = owner.render(width).length;
    width = 100;
    const wide = owner.render(width).length;
    expect(wide).toBeLessThan(narrow);
    expect(owner.render(width)).toEqual(lease.view.render(width));
    lease.view.setPrettyBlock("HEADER", "SHORT");
    expectReservation(owner, lease.view, width, wide);
    width = 48;
    owner.invalidate();
    expect(owner.render(width)).toEqual(lease.view.render(width));
    expect(owner.render(width)).toHaveLength(3);
    width = 100;
    owner.finish();
    expect(owner.render(width)).toHaveLength(3);
  });

  it("uses empty rows, never copies ANSI backgrounds, links or cursor markers", () => {
    const owner = new TranscriptOwner(() => 48);
    const lease = mount(owner);
    lease.view.setPrettyBlock("HEADER", `\x1b[31m${long}\x1b[0m`, {
      allowAnsi: true,
    });
    owner.render(48);
    lease.view.setPrettyBlock(
      "HEADER",
      "\x1b]8;;https://example.test\x07ERR\x1b]8;;\x07",
      { allowAnsi: true, isError: true }
    );
    const real = lease.view.render(48);
    const padded = owner.render(48);
    expect(padded.slice(0, real.length)).toEqual(real);
    expect(padded.slice(real.length)).toEqual(blanks(7));
    expect(padded.every((row) => visibleWidth(row) <= 48)).toBe(true);
    expect(padded.slice(real.length).map(stripTerminalSequences)).toEqual(
      blanks(7)
    );
    owner.finish();
  });

  it("delegates invalidation and counts only rendered, not unseen, heights", () => {
    const owner = new TranscriptOwner(() => 48);
    let rows = ["LONG", ...blanks(8)];
    const invalidate = vi.fn();
    const lease = owner.acquire(() => ({ render: () => rows, invalidate }), {
      leadingSpacer: false,
    });
    rows = ["SHORT"];
    expect(owner.render(48)).toEqual(rows);
    owner.invalidate();
    expect(invalidate).toHaveBeenCalledTimes(1);
    owner.finish(lease);
  });
});
