import {
  type Container,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ColdSnapshot, TranscriptOwner } from "./transcript-owner";

const text = (owner: Container, width = 80) =>
  stripTerminalSequences(owner.render(width).join("\n"));

describe("single transcript owner", () => {
  it("settles, snapshots, revokes, detaches and disposes before unrelated append", () => {
    const owner = new TranscriptOwner(() => 80);
    const order: string[] = [];
    const lease = owner.acquire(
      (permission) => {
        const view = new Text("PULSE", 0, 0);
        permission.signal.addEventListener("abort", () => {
          order.push("revoke");
          expect(permission.active).toBe(false);
          view.setText("BUGGY_ABORT");
        });
        return view;
      },
      {
        settle: (view) => {
          order.push("settle");
          expect(lease.active).toBe(true);
          view.setText("NORMAL");
        },
        dispose: (view) => {
          order.push("dispose");
          view.setText("BUGGY_DISPOSE");
        },
      }
    );
    owner.addChild(new Text("USER", 0, 0));
    expect(order).toEqual(["settle", "revoke", "dispose"]);
    expect(text(owner)).toContain("NORMAL");
    expect(text(owner)).toContain("USER");
    expect(text(owner)).not.toContain("BUGGY");
    expect(
      owner.children.every((component) => component instanceof ColdSnapshot)
    ).toBe(true);
  });

  it("cannot let one stream's finally freeze another owner's HOT notice", () => {
    const owner = new TranscriptOwner(() => 80);
    const stream = owner.acquire(() => new Text("STREAM", 0, 0));
    const notice = owner.acquire(() => new Text("NOTICE", 0, 0));
    owner.finish(stream);
    expect(stream.active).toBe(false);
    expect(notice.active).toBe(true);
    const hot = owner.children.filter((c) => !(c instanceof ColdSnapshot));
    expect(hot).toHaveLength(1);
    expect(hot[0]?.render(80)).toEqual(notice.view.render(80));
    owner.finish(notice);
    expect(notice.active).toBe(false);
  });

  it("reset revokes callbacks and epoch signals before mounting replacement with reused IDs", () => {
    const owner = new TranscriptOwner(() => 80);
    const epochSignal = owner.signal;
    const publish = vi.fn();
    const old = owner.acquire(() => new Text("OLD", 0, 0));
    const callback = () => {
      old.view.setText("STALE");
      if (old.active) {
        publish();
      }
    };
    owner.reset("session-navigation");
    const current = owner.acquire(() => new Text("NEW", 0, 0));
    callback();
    expect(epochSignal.aborted).toBe(true);
    expect(old.active).toBe(false);
    expect(current.active).toBe(true);
    expect(current.epoch).toBe(old.epoch + 1);
    expect(publish).not.toHaveBeenCalled();
    expect(text(owner)).not.toContain("STALE");
  });

  it("never invokes an old renderer on invalidation/resize, preserving ANSI, wide text and chosen rows", () => {
    let width = 16;
    const owner = new TranscriptOwner(() => width);
    const render = vi.fn(() => ["\x1b[31m漢字🙂ABCDEFG\x1b[0m", "chosen tail"]);
    owner.acquire(() => ({ render, invalidate: vi.fn() }));
    owner.finish();
    const original = owner.render(width);
    const count = render.mock.calls.length;
    width = 5;
    owner.invalidate();
    const narrow = owner.render(width);
    expect(stripTerminalSequences(narrow.join(""))).toContain("漢字🙂ABCDEFG");
    width = 16;
    expect(owner.render(width)).toEqual(original);
    expect(render).toHaveBeenCalledTimes(count);
  });

  it.each([
    "\x1b_Ga=T,f=100;ASSET\x1b\\",
    "\x1b]1337;File=inline=1:ASSET\x07",
    "\x1bPqASSET\x1b\\",
  ])("preserves graphics and reserved rows atomically: %j", (payload) => {
    const lines = [payload, ...Array.from({ length: 12 }, () => "")];
    const snapshot = new ColdSnapshot(lines, 100);
    const original = [...lines];
    lines[0] = "REPLACED_ASSET";
    expect(snapshot.render(10)).toEqual(original);
    expect(snapshot.render(100)).toEqual(original);
    expect(snapshot.render(200)).toHaveLength(13);
  });
});
