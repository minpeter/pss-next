export type CodingAgentExtensionPhase =
  | "activate"
  | "configure"
  | "dispose"
  | "event"
  | "hook";

export class CodingAgentExtensionError extends Error {
  readonly extensionId: string;
  readonly phase: CodingAgentExtensionPhase;

  constructor(
    extensionId: string,
    phase: CodingAgentExtensionPhase,
    cause: unknown
  ) {
    super(`Coding agent extension "${extensionId}" failed during ${phase}`, {
      cause,
    });
    this.name = "CodingAgentExtensionError";
    this.extensionId = extensionId;
    this.phase = phase;
  }
}
