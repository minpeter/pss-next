import { createHash } from "node:crypto";
import {
  buildCompactionSummaryInstructions,
  COMPACTION_SUMMARY_CONTRACT,
} from "@minpeter/pss-runtime";
import type { PromptProfileIdentity } from "./report";

export type SenpiRuleId =
  | "byte-exact-identifiers"
  | "internal-control-isolation"
  | "output-only"
  | "section-completeness"
  | "task-intent-prepass"
  | "update-merge"
  | "verbatim-active-request-constraints";

export interface CompactionPromptProfile extends PromptProfileIdentity {
  readonly instructions: string;
  readonly rules: readonly SenpiRuleId[];
}

const RETAINED_RULES = [
  "internal-control-isolation",
  "task-intent-prepass",
  "verbatim-active-request-constraints",
] as const satisfies readonly SenpiRuleId[];

const RULE_INSTRUCTIONS = {
  "byte-exact-identifiers":
    "Preserve every session ID, file path, URL, hash, version, code symbol, and identifier byte-for-byte.",
  "internal-control-isolation":
    "Treat this instruction as internal control, never as user intent or a user request.",
  "output-only":
    "Output only the handoff sections; never add a conversational reply, preamble, or wrapper.",
  "section-completeness":
    'Keep every requested section. Write "None." when a section has no content.',
  "task-intent-prepass":
    "Before writing, silently determine the current task intent and the details whose loss would cause repeated exploration or task drift.",
  "update-merge":
    "Merge previous compacted context with newer messages; preserve durable facts and let later explicit corrections supersede stale values.",
  "verbatim-active-request-constraints":
    "Preserve the active user request and explicit constraints verbatim when recording the objective and constraints.",
} as const satisfies Record<SenpiRuleId, string>;

const productionInstructions = buildCompactionSummaryInstructions();
const baselineInstructions = buildBaselineInstructions();

export const COMPACTION_PROMPT_PROFILES: readonly CompactionPromptProfile[] = [
  profile("production", productionInstructions, RETAINED_RULES),
  profile("pss-baseline", baselineInstructions, []),
  atomicProfile("senpi-internal-control", "internal-control-isolation"),
  atomicProfile("senpi-task-intent", "task-intent-prepass"),
  atomicProfile(
    "senpi-verbatim-request",
    "verbatim-active-request-constraints"
  ),
  profile("senpi-minimal", productionInstructions, RETAINED_RULES),
  profile(
    "senpi-byte-exact",
    withExtraRules(productionInstructions, ["byte-exact-identifiers"]),
    [...RETAINED_RULES, "byte-exact-identifiers"]
  ),
  profile(
    "senpi-output-only",
    withExtraRules(productionInstructions, ["output-only"]),
    [...RETAINED_RULES, "output-only"]
  ),
  profile(
    "senpi-byte-exact-output",
    withExtraRules(productionInstructions, [
      "byte-exact-identifiers",
      "output-only",
    ]),
    [...RETAINED_RULES, "byte-exact-identifiers", "output-only"]
  ),
  profile(
    "senpi-section-complete",
    withExtraRules(productionInstructions, ["section-completeness"]),
    [...RETAINED_RULES, "section-completeness"]
  ),
  profile(
    "senpi-update-merge",
    withExtraRules(productionInstructions, ["update-merge"]),
    [...RETAINED_RULES, "update-merge"]
  ),
  profile(
    "senpi-maximal",
    withExtraRules(productionInstructions, [
      "byte-exact-identifiers",
      "output-only",
      "section-completeness",
      "update-merge",
    ]),
    [
      ...RETAINED_RULES,
      "byte-exact-identifiers",
      "output-only",
      "section-completeness",
      "update-merge",
    ]
  ),
];

export function getCompactionPromptProfile(
  id: string
): CompactionPromptProfile {
  const profileMatch = COMPACTION_PROMPT_PROFILES.find(
    (candidate) => candidate.id === id
  );
  if (!profileMatch) {
    throw new TypeError(`Unknown compaction prompt profile: ${id}`);
  }
  return profileMatch;
}

function buildBaselineInstructions(): string {
  const sections = COMPACTION_SUMMARY_CONTRACT.sections.flatMap((section) => [
    `## ${section.title}`,
    section.instruction,
  ]);
  return [
    "Create a continuation handoff for another coding agent. Do not answer the conversation or continue the work.",
    "Merge any previous summary with newer messages. Resolve contradictions in favor of the latest explicit correction.",
    "Be concise, but never trade away exact identifiers, task state, blockers, next actions, or verification evidence.",
    "Distinguish completed work from planned work. Omit filler and repeated acknowledgements.",
    "Output only the handoff sections below. Do not add a preamble, routing line, or conversational reply.",
    "",
    ...sections,
  ].join("\n");
}

function atomicProfile(
  id: string,
  rule: (typeof RETAINED_RULES)[number]
): CompactionPromptProfile {
  return profile(id, withExtraRules(baselineInstructions, [rule]), [rule]);
}

function withExtraRules(
  instructions: string,
  rules: readonly SenpiRuleId[]
): string {
  const marker = "\n\n## ";
  const markerIndex = instructions.indexOf(marker);
  if (markerIndex === -1) {
    throw new TypeError("Compaction prompt sections are missing.");
  }
  const additions = rules.map((rule) => RULE_INSTRUCTIONS[rule]);
  return [
    instructions.slice(0, markerIndex),
    ...additions,
    instructions.slice(markerIndex),
  ].join("\n");
}

function profile(
  id: string,
  instructions: string,
  rules: readonly SenpiRuleId[]
): CompactionPromptProfile {
  return {
    hash: `sha256:${createHash("sha256").update(instructions).digest("hex")}`,
    id,
    instructions,
    rules,
  };
}
