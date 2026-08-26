import { TASK_UTILITY_FIXTURES } from "./task-utility-fixtures";
import type {
  TaskUtilityCheckpointIdentity,
  TaskUtilityMode,
} from "./task-utility-types";

export const TASK_UTILITY_FULL_CONTROL_ATTEMPTS = 3;

interface TaskUtilityCheckpointOptions {
  readonly attemptTimeoutMs: number;
  readonly mode: TaskUtilityMode;
  readonly model: string;
  readonly repetitions: number;
}

export function createTaskUtilityCheckpointIdentity(
  options: TaskUtilityCheckpointOptions
): TaskUtilityCheckpointIdentity {
  return {
    fixtures: TASK_UTILITY_FIXTURES.map(({ id }) => id),
    mode: options.mode,
    model: options.model,
    policy: {
      attemptTimeoutMs: options.attemptTimeoutMs,
      fullControlAttempts: TASK_UTILITY_FULL_CONTROL_ATTEMPTS,
      validator: "subprocess-v1",
    },
    repetitions: options.repetitions,
  };
}
