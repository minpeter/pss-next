import { describeCheckpointStoreContract } from "../../../../contracts/execution-store/checkpoint-contract";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";
import { TransactionalInMemorySqlStorage } from "./store-delete-thread.test-support";

describeCheckpointStoreContract({
  createStore: () =>
    new DurableObjectExecutionStore({
      prefix: "checkpoint-contract-test",
      storage: new InMemoryDurableObjectStorage({
        sql: new TransactionalInMemorySqlStorage(),
      }),
    }),
});
