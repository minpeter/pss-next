export function taskValidatorCheckIds(fixtureId: string): readonly string[] {
  switch (fixtureId) {
    case "exec-committed-event-telemetry":
      return [
        "scope",
        "committed-count",
        "no-provisional-name",
        "metadata-schema",
        "serialized-count",
        "source-no-eventCount",
      ];
    case "prompt-template-dollar-escape":
      return [
        "scope",
        "combined-expansion",
        "literal-arguments",
        "no-rescan",
        "zero-literal",
      ];
    case "workspace-cache-ignore-correction":
      return [
        "scope",
        "root-cache",
        "nested-cache",
        "substring-not-segment",
        "pnpm-store-not-ignored",
        "build-not-ignored",
        "preserve-dist",
      ];
    default:
      throw new TypeError(`Unknown task utility fixture: ${fixtureId}`);
  }
}
