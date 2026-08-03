type WebToolName = "web_fetch" | "web_search";

export class CodingAgentToolsConfigError extends Error {
  readonly code = "client-open-search-options-conflict";

  constructor() {
    super("Provide either client or openSearchOptions, not both.");
    this.name = "CodingAgentToolsConfigError";
  }
}

export class CodingAgentToolAbortError extends Error {
  readonly reason: unknown;
  readonly toolName: WebToolName;

  constructor(toolName: WebToolName, reason: unknown) {
    super(`${toolName} aborted.`);
    this.name = "CodingAgentToolAbortError";
    this.reason = reason;
    this.toolName = toolName;
  }
}

export function abortIfRequested(
  signal: AbortSignal | undefined,
  toolName: WebToolName
): void {
  if (signal === undefined || !signal.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw new CodingAgentToolAbortError(toolName, signal.reason);
}
