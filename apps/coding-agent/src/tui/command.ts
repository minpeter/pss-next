import type { Agent } from "@minpeter/pss-runtime";
import type {
  CodingAgentExtensionMode,
  CodingAgentExtensionServices,
} from "../extensions/types";

/**
 * Local slash-command model for the pss TUI. Mirrors the harness `Command`
 * contract plugsuits used, scoped down to what the interactive session needs.
 */
export type TuiCommandAction =
  | { type: "new-session" }
  | { type: "refresh-header" }
  | { type: "reload" }
  | { type: "select-model"; query?: string };

export interface TuiCommandResult {
  action?: TuiCommandAction;
  message?: string;
  success: boolean;
}

export interface TuiCommandContext {
  readonly agent: Agent;
  readonly mode: CodingAgentExtensionMode;
  readonly services: CodingAgentExtensionServices;
  readonly signal: AbortSignal;
  readonly workspace: string;
}

export interface TuiCommand {
  aliases?: readonly string[];
  /** Static completion values for simple commands. */
  argumentSuggestions?: readonly string[];
  description: string;
  displayName?: string;
  execute: (
    input: {
      args: string[];
    },
    context?: TuiCommandContext
  ) => Promise<TuiCommandResult> | TuiCommandResult;
  /** Async completion source for commands backed by runtime data. */
  getArgumentCompletions?: (
    argumentPrefix: string
  ) => Promise<TuiCommandArgumentCompletion[] | null>;
  name: string;
}

export interface TuiCommandArgumentCompletion {
  readonly description?: string;
  readonly label: string;
  readonly value: string;
}

export interface ParsedCommand {
  args: string[];
  name: string;
}

const COMMAND_PREFIX = "/";
const WHITESPACE_PATTERN = /\s+/;

export const isCommand = (input: string): boolean =>
  input.trimStart().startsWith(COMMAND_PREFIX);

export const parseCommand = (input: string): ParsedCommand | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const withoutPrefix = trimmed.slice(COMMAND_PREFIX.length);
  const firstWhitespace = withoutPrefix.search(WHITESPACE_PATTERN);
  if (firstWhitespace < 0) {
    return { args: [], name: withoutPrefix };
  }

  const name = withoutPrefix.slice(0, firstWhitespace);
  const args = withoutPrefix
    .slice(firstWhitespace)
    .trim()
    .split(WHITESPACE_PATTERN)
    .filter((arg) => arg.length > 0);

  return { args, name };
};
