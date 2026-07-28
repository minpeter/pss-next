import type { CodingAgentExtensionUi } from "../extensions/types";
import type { SessionChangeEvent } from "../sessions/session-guards";
import type { SessionIndexEntry } from "../sessions/session-index";
import {
  describeSession,
  type SessionLifecycleReason,
  type SessionManager,
} from "../sessions/session-manager";
import type {
  TuiCommand,
  TuiCommandArgumentCompletion,
  TuiCommandResult,
} from "./command";

/** Extension-UI select is capped at 100 options. */
const MAX_PICKER_OPTIONS = 100;

/**
 * Dependencies the session commands need from the interactive session.
 * Injected so command behavior is unit-testable without a live TUI.
 */
export interface SessionCommandContext {
  /** The session whose thread handle is currently driving the TUI. */
  currentSession(): SessionIndexEntry;
  /**
   * Consult extension session guards; throws when an extension cancels the
   * change.
   */
  ensureApproved(
    kind: "fork" | "switch",
    event: SessionChangeEvent
  ): Promise<void>;
  readonly manager: SessionManager;
  /** Update TUI state after the current session was renamed. */
  onRenamed(entry: SessionIndexEntry): void;
  /** Replace the active thread handle and emit lifecycle events. */
  switchThread(
    entry: SessionIndexEntry,
    reason: SessionLifecycleReason
  ): Promise<void>;
  /** Interactive prompts for pickers; absent in embedded hosts. */
  ui?(): CodingAgentExtensionUi | undefined;
}

export function createSessionCommands(
  context: SessionCommandContext
): TuiCommand[] {
  return [
    createNewCommand(context),
    createResumeCommand(context),
    createForkCommand(context),
    createNameCommand(context),
  ];
}

function createNewCommand(context: SessionCommandContext): TuiCommand {
  return {
    description: "Start a new session: /new [name]",
    execute: (input) =>
      runSessionCommand(async () => {
        const name = optionalName(input.args);
        await context.ensureApproved("switch", {
          fromKey: context.currentSession().key,
          reason: "new",
        });
        const entry = await context.manager.createSession(name);
        await context.switchThread(entry, "new");
        return {
          action: { clear: true, type: "session" },
          message: `Started new session ${describeSession(entry)}.`,
          success: true,
        };
      }),
    name: "new",
  };
}

function createResumeCommand(context: SessionCommandContext): TuiCommand {
  return {
    description:
      "Resume, rename, or delete a session: /resume [key|name] (no argument opens the picker)",
    execute: (input) =>
      runSessionCommand(async () => {
        if (input.args.length === 0) {
          return await runSessionPicker(context);
        }
        const query = input.args.join(" ");
        const entry = await context.manager.findSession(query);
        if (entry === undefined) {
          return {
            message: `No session matches ${JSON.stringify(query)}. Use /resume to list sessions.`,
            success: false,
          };
        }
        return await resumeSession(context, entry);
      }),
    getArgumentCompletions: async (argumentPrefix) => {
      const sessions = await context.manager.listSessions();
      const prefix = argumentPrefix.toLowerCase();
      const completions: TuiCommandArgumentCompletion[] = [];
      for (const session of sessions) {
        if (session.key === context.currentSession().key) {
          continue;
        }
        const value = session.name ?? session.key;
        if (prefix.length > 0 && !value.toLowerCase().startsWith(prefix)) {
          continue;
        }
        completions.push({
          description: `updated ${session.updatedAt}`,
          label: describeSession(session),
          value,
        });
      }
      return completions;
    },
    name: "resume",
  };
}

function createForkCommand(context: SessionCommandContext): TuiCommand {
  return {
    description:
      "Fork the current session: /fork [name] (no argument offers earlier fork points)",
    execute: (input) =>
      runSessionCommand(async () => {
        const name = optionalName(input.args);
        const fromKey = context.currentSession().key;
        let beforeHistoryIndex: number | undefined;
        if (name === undefined) {
          const point = await pickForkPoint(context, fromKey);
          if (point.kind === "cancelled") {
            return { message: "Fork cancelled.", success: true };
          }
          beforeHistoryIndex = point.beforeHistoryIndex;
        }
        await context.ensureApproved("fork", { fromKey, reason: "fork" });
        const entry = await context.manager.forkSession(fromKey, {
          ...(beforeHistoryIndex === undefined ? {} : { beforeHistoryIndex }),
          ...(name === undefined ? {} : { name }),
        });
        await context.switchThread(entry, "fork");
        const suffix =
          beforeHistoryIndex === undefined
            ? ""
            : ` (before user message #${beforeHistoryIndex + 1})`;
        return {
          action: { clear: true, type: "session" },
          message: `Forked into session ${describeSession(entry)}${suffix}.`,
          success: true,
        };
      }),
    name: "fork",
  };
}

function createNameCommand(context: SessionCommandContext): TuiCommand {
  return {
    description: "Name the current session: /name <name>",
    execute: (input) =>
      runSessionCommand(async () => {
        const name = input.args.join(" ").trim();
        if (name.length === 0) {
          return { message: "Usage: /name <name>", success: false };
        }
        const entry = await context.manager.renameSession(
          context.currentSession().key,
          name
        );
        context.onRenamed(entry);
        return {
          action: { type: "refresh-header" },
          message: `Session named ${JSON.stringify(name)}.`,
          success: true,
        };
      }),
    name: "name",
  };
}

async function resumeSession(
  context: SessionCommandContext,
  entry: SessionIndexEntry
): Promise<TuiCommandResult> {
  if (entry.key === context.currentSession().key) {
    return { message: "Already on that session.", success: true };
  }
  await context.ensureApproved("switch", {
    fromKey: context.currentSession().key,
    reason: "resume",
    toKey: entry.key,
  });
  const switched = await context.manager.switchToSession(entry.key);
  await context.switchThread(switched, "resume");
  return {
    action: { clear: true, type: "session" },
    message: `Resumed session ${describeSession(switched)}.`,
    success: true,
  };
}

/**
 * Interactive `/resume` picker: choose a session, then switch, rename, or
 * delete it. Falls back to a plain listing when no interactive UI is bound
 * (embedded hosts).
 */
async function runSessionPicker(
  context: SessionCommandContext
): Promise<TuiCommandResult> {
  const sessions = await context.manager.listSessions();
  if (sessions.length === 0) {
    return {
      message: "No sessions recorded for this directory yet.",
      success: true,
    };
  }
  const ui = context.ui?.();
  if (ui === undefined) {
    return { message: formatSessionList(context, sessions), success: true };
  }
  const currentKey = context.currentSession().key;
  const selectedKey = await ui.select({
    label: "Sessions (Enter to choose, Esc to cancel)",
    options: sessions.slice(0, MAX_PICKER_OPTIONS).map((session) => ({
      description: `updated ${session.updatedAt}`,
      label:
        session.key === currentKey
          ? `${describeSession(session)} (current)`
          : describeSession(session),
      value: session.key,
    })),
  });
  const target = sessions.find((session) => session.key === selectedKey);
  if (target === undefined) {
    return { message: "Resume cancelled.", success: true };
  }
  return await runSessionAction(context, ui, target);
}

async function runSessionAction(
  context: SessionCommandContext,
  ui: CodingAgentExtensionUi,
  target: SessionIndexEntry
): Promise<TuiCommandResult> {
  const isCurrent = target.key === context.currentSession().key;
  const action = await ui.select({
    label: `Session ${describeSession(target)}`,
    options: [
      ...(isCurrent ? [] : [{ label: "Switch to it", value: "switch" }]),
      { label: "Rename", value: "rename" },
      // Deleting the session that drives the live thread would strand the
      // active handle; switch away first.
      ...(isCurrent ? [] : [{ label: "Delete", value: "delete" }]),
      { label: "Cancel", value: "cancel" },
    ],
  });
  if (action === "switch") {
    return await resumeSession(context, target);
  }
  if (action === "rename") {
    const name = await ui.input({
      ...(target.name === undefined ? {} : { initialValue: target.name }),
      label: "New session name",
    });
    if (name === undefined || name.trim().length === 0) {
      return { message: "Rename cancelled.", success: true };
    }
    const renamed = await context.manager.renameSession(
      target.key,
      name.trim()
    );
    if (target.key === context.currentSession().key) {
      context.onRenamed(renamed);
    }
    return {
      action: { type: "refresh-header" },
      message: `Session named ${JSON.stringify(name.trim())}.`,
      success: true,
    };
  }
  if (action === "delete") {
    const confirmed = await ui.confirm(
      `Delete session ${describeSession(target)}? This removes its stored history.`
    );
    if (!confirmed) {
      return { message: "Delete cancelled.", success: true };
    }
    await context.manager.removeSession(target.key);
    return {
      message: `Deleted session ${describeSession(target)}.`,
      success: true,
    };
  }
  return { message: "Resume cancelled.", success: true };
}

type ForkPointChoice =
  | { readonly beforeHistoryIndex?: number; readonly kind: "chosen" }
  | { readonly kind: "cancelled" };

/**
 * Offer earlier user messages as fork points. Without an interactive UI or
 * without any stored user messages the fork branches at the latest state.
 */
async function pickForkPoint(
  context: SessionCommandContext,
  fromKey: string
): Promise<ForkPointChoice> {
  const ui = context.ui?.();
  if (ui === undefined) {
    return { kind: "chosen" };
  }
  const points = await context.manager.listForkPoints(fromKey);
  if (points.length === 0) {
    return { kind: "chosen" };
  }
  const recentFirst = [...points].reverse().slice(0, MAX_PICKER_OPTIONS - 1);
  const value = await ui.select({
    label: "Fork from (Esc to cancel)",
    options: [
      { label: "The latest state", value: "head" },
      ...recentFirst.map((point) => ({
        label: `Before user message #${point.historyIndex + 1}: ${point.preview}`,
        value: String(point.historyIndex),
      })),
    ],
  });
  if (value === undefined) {
    return { kind: "cancelled" };
  }
  if (value === "head") {
    return { kind: "chosen" };
  }
  return { beforeHistoryIndex: Number(value), kind: "chosen" };
}

function formatSessionList(
  context: SessionCommandContext,
  sessions: readonly SessionIndexEntry[]
): string {
  const currentKey = context.currentSession().key;
  const lines = sessions.map((session) => {
    const marker = session.key === currentKey ? "* " : "  ";
    return `${marker}${describeSession(session)} — updated ${session.updatedAt}`;
  });
  return [
    "Sessions for this directory (/resume <key|name> to switch):",
    ...lines,
  ].join("\n");
}

async function runSessionCommand(
  task: () => Promise<TuiCommandResult>
): Promise<TuiCommandResult> {
  try {
    return await task();
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      success: false,
    };
  }
}

function optionalName(args: readonly string[]): string | undefined {
  const name = args.join(" ").trim();
  return name.length === 0 ? undefined : name;
}
