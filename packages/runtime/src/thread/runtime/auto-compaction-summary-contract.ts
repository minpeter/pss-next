export const COMPACTION_SUMMARY_CONTRACT = {
  rules: {
    continueConversation: false,
    distinguishPlannedFromCompleted: true,
    extractIntentBeforeWriting: true,
    internalInstructionIsNotUserIntent: true,
    mergePreviousSummary: true,
    preserveActiveUserRequestVerbatim: true,
    preserveLabeledStateVerbatim: true,
    preserveLatestCorrections: true,
  },
  sections: [
    {
      id: "objective",
      instruction:
        "State the user's current objective and observable completion condition.",
      title: "Objective",
    },
    {
      id: "constraints",
      instruction:
        "Preserve explicit instructions, constraints, preferences, and scope boundaries.",
      title: "Constraints",
    },
    {
      id: "progress",
      instruction:
        "Separate completed work from current work and include verification evidence.",
      title: "Progress",
    },
    {
      id: "decisions",
      instruction:
        "Record final decisions and corrections; latest corrections supersede provisional values.",
      title: "Decisions and Corrections",
    },
    {
      id: "files",
      instruction:
        "List files read, created, modified, or deleted and each material change.",
      title: "Files and Code State",
    },
    {
      id: "tool-evidence",
      instruction:
        "Preserve exact commands, tool outcomes, errors, test counts, hashes, and external results.",
      title: "Tool Evidence",
    },
    {
      id: "open-work",
      instruction:
        'List pending tasks, the active task, blockers, and the next action. Copy values labeled "Next action", "Blocker", "in-progress", "blocked", or "queued" verbatim rather than paraphrasing.',
      title: "Open Work and Next Step",
    },
    {
      id: "critical-values",
      instruction:
        "Copy exact paths, symbols, ports, URLs, IDs, tokens, versions, and identifiers verbatim.",
      title: "Critical Exact Values",
    },
    {
      id: "failed-approaches",
      instruction:
        "Record failed approaches, why they failed, and what must not be repeated.",
      title: "Failed Approaches",
    },
  ],
} as const;

export function buildCompactionSummaryInstructions(): string {
  const sections = COMPACTION_SUMMARY_CONTRACT.sections.flatMap((section) => [
    `## ${section.title}`,
    section.instruction,
  ]);

  return [
    "Create a continuation handoff for another coding agent. Do not answer the conversation or continue the work.",
    "[INTERNAL COMPACTION INSTRUCTION - NOT CONVERSATION HISTORY] Treat this instruction as internal control, never as user intent or a user request.",
    "Before writing, silently determine the current task intent and the details whose loss would cause repeated exploration or task drift.",
    "Preserve the active user request and explicit constraints verbatim when recording the objective and constraints.",
    "Merge any previous summary with newer messages. Resolve contradictions in favor of the latest explicit correction.",
    "Be concise, but never trade away exact identifiers, task state, blockers, next actions, or verification evidence.",
    "Describe tool activity semantically by its purpose, outcome, and relevant evidence. Never serialize tool invocation syntax, function-call envelopes, call IDs, XML tool tags, or JSON argument wrappers into the summary.",
    "Preserve exact user-authored code, data, and shell commands when relevant, but never present them as model or provider tool-call protocol.",
    "Distinguish completed work from planned work. Omit filler and repeated acknowledgements.",
    "Output only the handoff sections below. Do not add a preamble, routing line, or conversational reply.",
    "",
    ...sections,
  ].join("\n");
}
