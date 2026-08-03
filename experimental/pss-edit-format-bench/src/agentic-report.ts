import type { AgenticAttempt } from "./agentic";
import { EDIT_TASKS, type EditTask } from "./tasks";

export const buildAgenticReport = (
  attempts: readonly AgenticAttempt[]
): string => {
  const passAtOne = attempts.filter(
    (attempt) => attempt.firstEditPassed
  ).length;
  const recovered = attempts.filter((attempt) => attempt.recovered).length;
  const transportFailures = attempts.filter(
    (attempt) => attempt.transportStatus === "failed"
  ).length;
  const toolFailures = attempts.filter(
    (attempt) => attempt.toolStatus === "failed"
  ).length;
  const verificationFailures = attempts.filter(
    (attempt) => attempt.verificationStatus === "failed"
  ).length;
  const total = attempts.length;
  const sections = [
    "# Agentic edit benchmark",
    "",
    "Exact workspace bytes are the primary score. Infrastructure retries and semantic recovery are reported separately.",
    "",
    "## Outcome",
    "",
    "| metric | value |",
    "|---|---:|",
    `| attempts | ${total} |`,
    `| exact final pass | ${attempts.filter((attempt) => attempt.passed).length}/${total} |`,
    `| pass@1 | ${passAtOne}/${total} |`,
    `| recovered after first edit | ${recovered}/${total} |`,
    `| transport failures | ${transportFailures} |`,
    `| tool failures | ${toolFailures} |`,
    `| verification failures | ${verificationFailures} |`,
    `| input tokens | ${attempts.reduce((total, attempt) => total + (attempt.inputTokens ?? 0), 0)} |`,
    `| output tokens | ${attempts.reduce((total, attempt) => total + (attempt.outputTokens ?? 0), 0)} |`,
    "",
    renderSlice("language", attempts, (task) => task.metadata.language),
    "",
    renderSlice("kind", attempts, (task) => task.metadata.category),
    "",
    renderSlice("difficulty", attempts, (task) => task.metadata.difficulty),
  ];
  return sections.join("\n");
};

const tasksById = new Map(EDIT_TASKS.map((task) => [task.id, task]));

const renderSlice = (
  name: "difficulty" | "kind" | "language",
  attempts: readonly AgenticAttempt[],
  select: (task: EditTask) => string
): string => {
  const groups = new Map<string, AgenticAttempt[]>();
  for (const attempt of attempts) {
    const task = tasksById.get(attempt.task);
    const value = task === undefined ? "unknown" : select(task);
    const group = groups.get(value) ?? [];
    group.push(attempt);
    groups.set(value, group);
  }
  const rows = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, group]) => {
      const passed = group.filter((attempt) => attempt.passed).length;
      const passAtOne = group.filter(
        (attempt) => attempt.firstEditPassed
      ).length;
      const recovered = group.filter((attempt) => attempt.recovered).length;
      const transportFailures = group.filter(
        (attempt) => attempt.transportStatus === "failed"
      ).length;
      return `| ${value} | ${passed}/${group.length} | ${passAtOne}/${group.length} | ${recovered} | ${transportFailures} |`;
    });
  return [
    `## By ${name}`,
    "",
    `| ${name} | exact pass | pass@1 | recovered | transport failures |`,
    "|---|---:|---:|---:|---:|",
    ...rows,
  ].join("\n");
};
