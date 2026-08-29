import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import {
  ackScheduledDurableObjectRun,
  ackScheduledDurableObjectThreadPrompt,
  createDurableObjectScheduledWorkScheduler,
  InMemoryDurableObjectStorage,
  listScheduledDurableObjectRuns,
  listScheduledDurableObjectThreadPrompts,
} from "./storage-host";

describeExecutionSchedulerContract({
  createHarness: () => {
    const storage = new InMemoryDurableObjectStorage();
    return {
      ackRun: (runId) => ackScheduledDurableObjectRun(storage, runId),
      ackThreadPrompt: (prompt) =>
        ackScheduledDurableObjectThreadPrompt(storage, prompt),
      listRuns: (options) =>
        listScheduledDurableObjectRuns(storage, { limit: options?.limit }),
      listThreadPrompts: (options) =>
        listScheduledDurableObjectThreadPrompts(storage, {
          limit: options?.limit,
        }),
      scheduler: createDurableObjectScheduledWorkScheduler({ storage }),
    };
  },
  name: "durable object",
  supportsDueTimeFiltering: false,
});
