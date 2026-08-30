import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import { InMemoryExecutionScheduler } from "./scheduler";

describeExecutionSchedulerContract({
  createHarness: () => {
    const scheduler = new InMemoryExecutionScheduler();
    return {
      ackRun: (runId) => scheduler.ackScheduledRun(runId),
      ackThreadPrompt: (prompt) => scheduler.ackScheduledThreadPrompt(prompt),
      listRuns: (options) => scheduler.listScheduledRuns(options),
      listThreadPrompts: (options) =>
        scheduler.listScheduledThreadPrompts(options),
      scheduler,
    };
  },
  name: "in-memory",
  supportsDueTimeFiltering: true,
});
