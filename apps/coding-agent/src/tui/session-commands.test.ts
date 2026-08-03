import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { CodingAgentExtensionUi } from "../extensions/types";
import type { SessionIndexEntry } from "../sessions/session-index";
import type { SessionManager } from "../sessions/session-manager";
import {
  createSessionCommands,
  type SessionCommandContext,
} from "./session-commands";

const entry = (
  key: string,
  overrides?: Partial<SessionIndexEntry>
): SessionIndexEntry => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  cwd: "/work",
  key,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

interface FakeUiScript {
  readonly confirms?: boolean[];
  readonly inputs?: (string | undefined)[];
  readonly selects?: (string | undefined)[];
}

function fakeUi(script: FakeUiScript): {
  selectLabels: string[];
  selectOptions: { label: string; value: string }[][];
  statusClears: () => number;
  statusMessages: string[];
  ui: CodingAgentExtensionUi;
} {
  const selects = [...(script.selects ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const selectLabels: string[] = [];
  const selectOptions: { label: string; value: string }[][] = [];
  const statusMessages: string[] = [];
  let statusClears = 0;
  const ui: CodingAgentExtensionUi = {
    confirm: () => Promise.resolve(confirms.shift() ?? false),
    input: () => Promise.resolve(inputs.shift()),
    notify: () => undefined,
    select: ({ label, options }) => {
      selectLabels.push(label);
      selectOptions.push(
        options.map(({ label: optionLabel, value }) => ({
          label: optionLabel,
          value,
        }))
      );
      return Promise.resolve(selects.shift());
    },
    status: (message) => {
      statusMessages.push(message);
      return () => {
        statusClears += 1;
      };
    },
  };
  return {
    selectLabels,
    selectOptions,
    statusClears: () => statusClears,
    statusMessages,
    ui,
  };
}

function createContext(overrides?: Partial<SessionCommandContext>): {
  context: SessionCommandContext;
  manager: SessionManager;
  switched: [SessionIndexEntry, string][];
} {
  const switched: [SessionIndexEntry, string][] = [];
  const manager = {
    createSession: vi.fn((name?: string) =>
      Promise.resolve(
        entry("cwd:/work#new", name === undefined ? {} : { name })
      )
    ),
    cwd: "/work",
    findSession: vi.fn(() => Promise.resolve(undefined)),
    forkSession: vi.fn(
      (
        fromKey: string,
        options?: { beforeHistoryIndex?: number; name?: string }
      ) =>
        Promise.resolve(
          entry("cwd:/work#fork", {
            parentKey: fromKey,
            ...(options?.name === undefined ? {} : { name: options.name }),
          })
        )
    ),
    getSession: vi.fn(() => Promise.resolve(undefined)),
    listForkPoints: vi.fn(() => Promise.resolve([])),
    loadSessionHistory: vi.fn(() => Promise.resolve([])),
    listResumableSessions: vi.fn(() => Promise.resolve([])),
    listSessions: vi.fn(() => Promise.resolve([])),
    removeSession: vi.fn(() => Promise.resolve()),
    renameSession: vi.fn((key: string, name: string) =>
      Promise.resolve(entry(key, { name }))
    ),
    resolveStartupSession: vi.fn(() => Promise.resolve(entry("cwd:/work"))),
    switchToSession: vi.fn((key: string) => Promise.resolve(entry(key))),
    touchSession: vi.fn(() => Promise.resolve()),
  } as unknown as SessionManager;
  const context: SessionCommandContext = {
    currentSession: () => entry("cwd:/work"),
    ensureApproved: vi.fn(() => Promise.resolve()),
    manager,
    onRenamed: vi.fn(),
    switchThread: (target, reason) => {
      switched.push([target, reason]);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { context, manager, switched };
}

function command(context: SessionCommandContext, name: string) {
  const found = createSessionCommands(context).find(
    (candidate) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return found;
}

describe("/new", () => {
  it("owns clear as an alias", () => {
    const { context } = createContext();
    expect(command(context, "new").aliases).toContain("clear");
    expect(
      createSessionCommands(context).some(
        (candidate) => candidate.name === "clear"
      )
    ).toBe(false);
  });

  it("creates a named session and switches to it", async () => {
    const { context, manager, switched } = createContext();
    const result = await command(context, "new").execute({
      args: ["spike", "work"],
    });
    expect(manager.createSession).toHaveBeenCalledWith("spike work");
    expect(switched).toHaveLength(1);
    expect(switched[0]?.[1]).toBe("new");
    expect(result).toMatchObject({
      action: { clear: true, type: "session" },
      success: true,
    });
  });

  it("reports guard cancellations without switching", async () => {
    const { context, switched } = createContext({
      ensureApproved: () => Promise.reject(new Error("cancelled by extension")),
    });
    const result = await command(context, "new").execute({ args: [] });
    expect(result).toMatchObject({
      message: "cancelled by extension",
      success: false,
    });
    expect(switched).toEqual([]);
  });
});

describe("/resume", () => {
  it("opens the inline session selector without arguments", async () => {
    const { context } = createContext();
    const result = await command(context, "resume").execute({ args: [] });
    expect(result).toEqual({
      action: { type: "select-session" },
      success: true,
    });
  });

  it("switches to a matching session", async () => {
    const { context, manager, switched } = createContext();
    (manager.findSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      entry("cwd:/work#2")
    );
    const result = await command(context, "resume").execute({
      args: ["cwd:/work#2"],
    });
    expect(manager.switchToSession).toHaveBeenCalledWith("cwd:/work#2");
    expect(switched[0]?.[1]).toBe("resume");
    expect(result.success).toBe(true);
  });

  it("opens the picker with unmatched text as its search query", async () => {
    const { context, switched } = createContext();
    const result = await command(context, "resume").execute({
      args: ["parser", "spike"],
    });
    expect(result).toEqual({
      action: { query: "parser spike", type: "select-session" },
      success: true,
    });
    expect(switched).toEqual([]);
  });

  it("is a no-op when already on the target session", async () => {
    const { context, manager, switched } = createContext();
    (manager.findSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      entry("cwd:/work")
    );
    const result = await command(context, "resume").execute({
      args: ["cwd:/work"],
    });
    expect(result).toMatchObject({ success: true });
    expect(switched).toEqual([]);
  });

  it("offers completions excluding the current session", async () => {
    const { context, manager } = createContext();
    (
      manager.listResumableSessions as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      entry("cwd:/work"),
      entry("cwd:/work#2", { name: "spike" }),
    ]);
    const completions = await command(
      context,
      "resume"
    ).getArgumentCompletions?.("sp");
    expect(completions).toEqual([
      expect.objectContaining({
        description: "updated 2026-01-01 00:00",
        value: "spike",
      }),
    ]);
    const label = completions?.[0]?.label ?? "";
    expect(visibleWidth(label.slice(0, label.indexOf("#")))).toBe(21);
  });

  it("matches unnamed sessions by their displayed untitled label", async () => {
    const { context, manager } = createContext();
    (
      manager.listResumableSessions as ReturnType<typeof vi.fn>
    ).mockResolvedValue([entry("cwd:/work"), entry("cwd:/work#deadbeef")]);

    const completions = await command(
      context,
      "resume"
    ).getArgumentCompletions?.("t");

    expect(completions).toEqual([
      expect.objectContaining({
        label: expect.stringContaining("untitled"),
        value: "cwd:/work#deadbeef",
      }),
    ]);
  });

  it("does not load sessions until a search query is entered", async () => {
    const { statusMessages, ui } = fakeUi({});
    const { context, manager } = createContext({ ui: () => ui });

    await expect(
      command(context, "resume").getArgumentCompletions?.(" ")
    ).resolves.toBeNull();
    expect(manager.listResumableSessions).not.toHaveBeenCalled();
    expect(statusMessages).toEqual([]);
  });

  it("shows loading status while session completions are pending", async () => {
    const { statusClears, statusMessages, ui } = fakeUi({});
    const { context, manager } = createContext({ ui: () => ui });
    let resolveSessions: ((sessions: SessionIndexEntry[]) => void) | undefined;
    (
      manager.listResumableSessions as ReturnType<typeof vi.fn>
    ).mockImplementation(
      () =>
        new Promise<SessionIndexEntry[]>((resolve) => {
          resolveSessions = resolve;
        })
    );

    const completions = command(context, "resume").getArgumentCompletions?.(
      "t"
    );

    expect(statusMessages).toEqual(["Loading sessions..."]);
    expect(statusClears()).toBe(0);
    resolveSessions?.([entry("cwd:/work#deadbeef")]);
    await completions;
    expect(statusClears()).toBe(1);
  });

  it("keeps the short id visible in long autocomplete labels", async () => {
    const { context, manager } = createContext();
    (
      manager.listResumableSessions as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      entry("cwd:/work#deadbeef", {
        name: "ultralongtitlehanlding-test-ulralooooooooooooooooooooooooooong",
      }),
    ]);
    const completions = await command(
      context,
      "resume"
    ).getArgumentCompletions?.("ultra");
    const label = completions?.[0]?.label ?? "";
    expect(visibleWidth(label)).toBeLessThanOrEqual(30);
    expect(label).toContain("#deadbeef");
  });

  it("aligns hashes across short and long autocomplete titles", async () => {
    const { context, manager } = createContext();
    (
      manager.listResumableSessions as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      entry("cwd:/work#aaaaaaaa"),
      entry("cwd:/work#bbbbbbbb", {
        name: "ultralongtitlehanlding-test-ulralooooooooooooooooooooooooooong",
      }),
    ]);
    const completions = await command(
      context,
      "resume"
    ).getArgumentCompletions?.("#");
    const hashColumns = completions?.map(({ label }) =>
      visibleWidth(label.slice(0, label.indexOf("#")))
    );
    expect(hashColumns).toEqual([21, 21]);
  });

  it("defers no-argument selection to the TUI without mutating sessions", async () => {
    const { context, manager, switched } = createContext();
    const result = await command(context, "resume").execute({ args: [] });
    expect(result).toEqual({
      action: { type: "select-session" },
      success: true,
    });
    expect(manager.switchToSession).not.toHaveBeenCalled();
    expect(manager.renameSession).not.toHaveBeenCalled();
    expect(manager.removeSession).not.toHaveBeenCalled();
    expect(switched).toEqual([]);
  });
});

describe("/fork", () => {
  it("consults the fork guard and switches to the fork", async () => {
    const { context, manager, switched } = createContext();
    const result = await command(context, "fork").execute({
      args: ["experiment"],
    });
    expect(context.ensureApproved).toHaveBeenCalledWith("fork", {
      fromKey: "cwd:/work",
      reason: "fork",
    });
    expect(manager.forkSession).toHaveBeenCalledWith("cwd:/work", {
      name: "experiment",
    });
    expect(switched[0]?.[1]).toBe("fork");
    expect(result.success).toBe(true);
  });

  it("forks at head without a UI or fork points", async () => {
    const { context, manager } = createContext();
    const result = await command(context, "fork").execute({ args: [] });
    expect(manager.forkSession).toHaveBeenCalledWith("cwd:/work", {});
    expect(result.success).toBe(true);
  });

  it("offers earlier user messages recent-first and forks before one", async () => {
    const { selectOptions, ui } = fakeUi({ selects: ["2"] });
    const { context, manager, switched } = createContext({ ui: () => ui });
    (manager.listForkPoints as ReturnType<typeof vi.fn>).mockResolvedValue([
      { historyIndex: 0, preview: "first ask" },
      { historyIndex: 2, preview: "second ask" },
    ]);
    const result = await command(context, "fork").execute({ args: [] });
    expect(manager.forkSession).toHaveBeenCalledWith("cwd:/work", {
      beforeHistoryIndex: 2,
    });
    expect(switched[0]?.[1]).toBe("fork");
    expect(result.message).toContain("before user message #3");
    expect(selectOptions[0]?.map((option) => option.value)).toEqual([
      "head",
      "2",
      "0",
    ]);
  });

  it("cancels the fork when the picker is dismissed", async () => {
    const { ui } = fakeUi({ selects: [undefined] });
    const { context, manager } = createContext({ ui: () => ui });
    (manager.listForkPoints as ReturnType<typeof vi.fn>).mockResolvedValue([
      { historyIndex: 0, preview: "first ask" },
    ]);
    const result = await command(context, "fork").execute({ args: [] });
    expect(manager.forkSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ message: "Fork cancelled.", success: true });
  });
});

describe("/name", () => {
  it("renames the current session", async () => {
    const { context, manager } = createContext();
    const result = await command(context, "name").execute({
      args: ["my", "session"],
    });
    expect(manager.renameSession).toHaveBeenCalledWith(
      "cwd:/work",
      "my session"
    );
    expect(context.onRenamed).toHaveBeenCalled();
    expect(result).toMatchObject({
      action: { type: "refresh-header" },
      success: true,
    });
  });

  it("requires a name argument", async () => {
    const { context } = createContext();
    const result = await command(context, "name").execute({ args: [] });
    expect(result).toMatchObject({ success: false });
  });
});
