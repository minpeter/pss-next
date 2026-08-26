import type { ModelMessage } from "ai";

export interface TaskUtilityFixture {
  readonly deterministicSolution: string;
  readonly finalPrompt: string;
  readonly history: readonly ModelMessage[];
  readonly id:
    | "exec-committed-event-telemetry"
    | "prompt-template-dollar-escape"
    | "workspace-cache-ignore-correction";
  readonly initialSource: string;
  readonly targetFile: string;
}

export const TASK_UTILITY_FIXTURES: readonly TaskUtilityFixture[] = [
  {
    deterministicSolution: `export function buildExecResult(events) {
  return {
    committedEventCount: events.length,
    events,
    metadataSchema: "pss-headless-v1",
  };
}
`,
    finalPrompt:
      "Implement the agreed exec-result telemetry change now. Edit only exec-result.mjs and verify the behavior.",
    history: history([
      "The provisional property name was eventCount.",
      "Review rejected eventCount because streamed deltas are not committed events.",
      "The final public property is committedEventCount.",
      "It must equal result.events.length and be serialized with the result.",
      "Do not add eventCount. Preserve metadataSchema pss-headless-v1.",
    ]),
    id: "exec-committed-event-telemetry",
    initialSource: `export function buildExecResult(events) {
  return { events, metadataSchema: "pss-headless-v1" };
}
`,
    targetFile: "exec-result.mjs",
  },
  {
    deterministicSolution: `export function expandPromptTemplate(template, args) {
  return template.replace(/\\$\\$|\\$ARGUMENTS|\\$([1-9])/g, (match, index) => {
    if (match === "$$") return "$";
    return match === "$ARGUMENTS"
      ? args.join(" ")
      : (args[Number(index) - 1] ?? "");
  });
}
`,
    finalPrompt:
      "Finish the prompt-template escaping change according to the final review decision. Edit only prompt-template.mjs.",
    history: history([
      "The rejected escape proposal was $0.",
      "The final syntax is $$, which emits one literal dollar sign.",
      "Preserve $1 through $9 and $ARGUMENTS substitution.",
      "Perform one combined source pass; never rescan substituted arguments.",
      "$$ARGUMENTS must become the literal text $ARGUMENTS.",
    ]),
    id: "prompt-template-dollar-escape",
    initialSource: `export function expandPromptTemplate(template, args) {
  return template.replace(/\\$ARGUMENTS|\\$([1-9])/g, (match, index) =>
    match === "$ARGUMENTS" ? args.join(" ") : (args[Number(index) - 1] ?? "")
  );
}
`,
    targetFile: "prompt-template.mjs",
  },
  {
    deterministicSolution: `const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".cache",
]);

export function isIgnoredWorkspacePath(path) {
  return path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));
}
`,
    finalPrompt:
      "Apply the final workspace-ignore decision. Edit only path-safety.mjs and preserve the existing ignored segments.",
    history: history([
      "The provisional ignored segment was .pnpm-store.",
      "Review rejected .pnpm-store and a broad build ignore.",
      "The final segment to ignore is .cache at any path depth.",
      "Do not ignore src/my.cache or .pnpm-store or build.",
      "Preserve the existing node_modules and dist ignored segments.",
    ]),
    id: "workspace-cache-ignore-correction",
    initialSource: `const IGNORED_SEGMENTS = new Set(["node_modules", "dist"]);

export function isIgnoredWorkspacePath(path) {
  return path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));
}
`,
    targetFile: "path-safety.mjs",
  },
];

function history(decisions: readonly string[]): readonly ModelMessage[] {
  const noise = Array.from({ length: 12 }, (_, index) => [
    {
      content: `Status checkpoint ${index + 1}: tests remain green; no final naming decision yet. ${"routine context ".repeat(20)}`,
      role: "user" as const,
    },
    {
      content:
        "Acknowledged. I will wait for the final review decision before editing.",
      role: "assistant" as const,
    },
  ]).flat();
  const decisionMessages = decisions.flatMap((decision) => [
    { content: decision, role: "user" as const },
    {
      content: "Recorded; I will follow that final constraint.",
      role: "assistant" as const,
    },
  ]);
  return [...noise, ...decisionMessages];
}
