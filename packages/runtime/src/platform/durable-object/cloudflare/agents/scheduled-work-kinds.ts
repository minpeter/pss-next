import type { ScheduledWorkKind } from "../../storage/sqlite/scheduled-work-table";

export const agentsRunKind = "agents-run" satisfies ScheduledWorkKind;
export const agentsThreadPromptKind =
  "agents-thread-prompt" satisfies ScheduledWorkKind;
// The shared kinds are owned by the alarm scheduler
// (createCloudflareScheduledWorkScheduler); the Agents adapter reads them so a
// Durable Object migrated from the alarm adapter keeps its pending work.
export const alarmRunKind = "run" satisfies ScheduledWorkKind;
export const alarmThreadPromptKind =
  "thread-prompt" satisfies ScheduledWorkKind;
