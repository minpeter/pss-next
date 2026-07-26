export class AgentHookError extends Error {
  readonly hook: keyof import("./hooks").AgentHooks;

  constructor(hook: keyof import("./hooks").AgentHooks, cause: unknown) {
    super(`Agent hook "${hook}" failed`, { cause });
    this.name = "AgentHookError";
    this.hook = hook;
  }
}
