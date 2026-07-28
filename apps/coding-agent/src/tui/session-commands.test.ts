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
  ui: CodingAgentExtensionUi;
} {
  const selects = [...(script.selects ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const selectLabels: string[] = [];
  const selectOptions: { label: string; value: string }[][] = [];
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
    status: () => () => undefined,
  };
  return { selectLabels, selectOptions, ui };
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
  it("lists sessions when no interactive UI is bound", async () => {
    const { context, manager } = createContext();
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work", { name: "main" }),
      entry("cwd:/work#2", { updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const result = await command(context, "resume").execute({ args: [] });
    expect(result.success).toBe(true);
    expect(result.message).toContain("cwd:/work#2");
    expect(result.message).toContain('* cwd:/work "main"');
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

  it("rejects unknown queries", async () => {
    const { context, switched } = createContext();
    const result = await command(context, "resume").execute({
      args: ["ghost"],
    });
    expect(result.success).toBe(false);
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
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work"),
      entry("cwd:/work#2", { name: "spike" }),
    ]);
    const completions = await command(
      context,
      "resume"
    ).getArgumentCompletions?.("sp");
    expect(completions).toEqual([expect.objectContaining({ value: "spike" })]);
  });

  it("switches through the interactive picker", async () => {
    const { selectOptions, ui } = fakeUi({
      selects: ["cwd:/work#2", "switch"],
    });
    const { context, manager, switched } = createContext({ ui: () => ui });
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work"),
      entry("cwd:/work#2"),
    ]);
    const result = await command(context, "resume").execute({ args: [] });
    expect(manager.switchToSession).toHaveBeenCalledWith("cwd:/work#2");
    expect(switched[0]?.[1]).toBe("resume");
    expect(result).toMatchObject({
      action: { clear: true, type: "session" },
      success: true,
    });
    // The current session is marked and its action list omits switch/delete.
    expect(selectOptions[0]?.[0]?.label).toContain("(current)");
  });

  it("renames through the picker and syncs the header for the current session", async () => {
    const { ui } = fakeUi({
      inputs: ["renamed"],
      selects: ["cwd:/work", "rename"],
    });
    const { context, manager } = createContext({ ui: () => ui });
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work"),
    ]);
    const result = await command(context, "resume").execute({ args: [] });
    expect(manager.renameSession).toHaveBeenCalledWith("cwd:/work", "renamed");
    expect(context.onRenamed).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });

  it("deletes non-current sessions after confirmation", async () => {
    const { selectOptions, ui } = fakeUi({
      confirms: [true],
      selects: ["cwd:/work#2", "delete"],
    });
    const { context, manager } = createContext({ ui: () => ui });
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work"),
      entry("cwd:/work#2"),
    ]);
    const result = await command(context, "resume").execute({ args: [] });
    expect(manager.removeSession).toHaveBeenCalledWith("cwd:/work#2");
    expect(result.message).toContain("Deleted");
    // The non-current target offers switch and delete.
    expect(selectOptions[1]?.map((option) => option.value)).toEqual([
      "switch",
      "rename",
      "delete",
      "cancel",
    ]);
  });

  it("never offers delete for the current session", async () => {
    const { selectOptions, ui } = fakeUi({ selects: ["cwd:/work", "cancel"] });
    const { context, manager } = createContext({ ui: () => ui });
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work"),
    ]);
    await command(context, "resume").execute({ args: [] });
    expect(selectOptions[1]?.map((option) => option.value)).toEqual([
      "rename",
      "cancel",
    ]);
  });

  it("cancels cleanly when the picker is dismissed", async () => {
    const { ui } = fakeUi({ selects: [undefined] });
    const { context, manager, switched } = createContext({ ui: () => ui });
    (manager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry("cwd:/work"),
    ]);
    const result = await command(context, "resume").execute({ args: [] });
    expect(result).toMatchObject({ success: true });
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
