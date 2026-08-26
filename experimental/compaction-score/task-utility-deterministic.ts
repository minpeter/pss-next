import { writeFile } from "node:fs/promises";
import { criticalTaskFacts } from "./task-utility-classification";
import type { TaskUtilityFixture } from "./task-utility-fixtures";
import type { TaskArmExecution, TaskUtilityArm } from "./task-utility-types";

export async function runDeterministicTaskArm(
  fixture: TaskUtilityFixture,
  workspace: string,
  arm: TaskUtilityArm
): Promise<TaskArmExecution> {
  await writeFile(
    `${workspace}/${fixture.targetFile}`,
    fixture.deterministicSolution
  );
  return {
    assistantOutput: "Applied the final recorded decision.",
    events: [{ type: "deterministic-complete" }],
    summary: arm === "compact" ? criticalTaskFacts(fixture) : null,
  };
}
