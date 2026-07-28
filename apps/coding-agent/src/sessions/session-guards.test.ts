import { describe, expect, it } from "vitest";
import {
  approveSessionChange,
  type RegisteredSessionGuard,
} from "./session-guards";

const event = { fromKey: "a", reason: "resume" as const, toKey: "b" };

describe("approveSessionChange", () => {
  it("approves when no guard objects", async () => {
    const approval = await approveSessionChange({
      event,
      guards: [],
      kind: "switch",
    });
    expect(approval).toEqual({ approved: true });
  });

  it("approves when guards allow explicitly or implicitly", async () => {
    const guards: RegisteredSessionGuard[] = [
      { extensionId: "a", guard: { beforeSwitch: () => undefined } },
      { extensionId: "b", guard: { beforeSwitch: () => ({ cancel: false }) } },
      { extensionId: "c", guard: { beforeFork: () => ({ cancel: true }) } },
    ];
    const approval = await approveSessionChange({
      event,
      guards,
      kind: "switch",
    });
    expect(approval).toEqual({ approved: true });
  });

  it("cancels with the first cancelling guard's reason", async () => {
    const guards: RegisteredSessionGuard[] = [
      { extensionId: "a", guard: { beforeSwitch: () => undefined } },
      {
        extensionId: "b",
        guard: {
          beforeSwitch: () => ({ cancel: true, reason: "unsaved work" }),
        },
      },
    ];
    const approval = await approveSessionChange({
      event,
      guards,
      kind: "switch",
    });
    expect(approval).toEqual({
      approved: false,
      extensionId: "b",
      reason: "unsaved work",
    });
  });

  it("consults beforeFork for fork decisions", async () => {
    const guards: RegisteredSessionGuard[] = [
      { extensionId: "a", guard: { beforeFork: () => ({ cancel: true }) } },
    ];
    const approval = await approveSessionChange({
      event: { fromKey: "a", reason: "fork" },
      guards,
      kind: "fork",
    });
    expect(approval).toMatchObject({ approved: false, extensionId: "a" });
  });

  it("fails closed when a guard throws", async () => {
    const guards: RegisteredSessionGuard[] = [
      {
        extensionId: "boomer",
        guard: {
          beforeSwitch: () => {
            throw new Error("boom");
          },
        },
      },
    ];
    const approval = await approveSessionChange({
      event,
      guards,
      kind: "switch",
    });
    expect(approval).toMatchObject({ approved: false, extensionId: "boomer" });
  });

  it("fails closed on an explicit null decision", async () => {
    const guards: RegisteredSessionGuard[] = [
      {
        extensionId: "nully",
        guard: {
          beforeSwitch: () => null as unknown as undefined,
        },
      },
    ];
    const approval = await approveSessionChange({
      event,
      guards,
      kind: "switch",
    });
    expect(approval).toMatchObject({ approved: false, extensionId: "nully" });
  });

  it("fails closed on malformed decisions", async () => {
    const guards: RegisteredSessionGuard[] = [
      {
        extensionId: "weird",
        guard: {
          beforeSwitch: () =>
            ({ cancel: "yes" }) as unknown as { cancel: boolean },
        },
      },
    ];
    const approval = await approveSessionChange({
      event,
      guards,
      kind: "switch",
    });
    expect(approval).toMatchObject({
      approved: false,
      extensionId: "weird",
      reason: expect.stringContaining("invalid session guard decision"),
    });
  });

  it("fails closed when a guard exceeds the host timeout", async () => {
    const guards: RegisteredSessionGuard[] = [
      {
        extensionId: "slow",
        guard: {
          beforeSwitch: () => new Promise(() => undefined),
        },
      },
    ];
    const approval = await approveSessionChange({
      event,
      guards,
      kind: "switch",
      timeoutMs: 20,
    });
    expect(approval).toMatchObject({ approved: false, extensionId: "slow" });
  });
});
