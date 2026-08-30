import { describeExecutionLeaseContract } from "../../../../contracts/execution-store/lease-contract";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";
import { TransactionalInMemorySqlStorage } from "./store-delete-thread.test-support";

describeExecutionLeaseContract(
  "DurableObjectExecutionStore",
  () =>
    new DurableObjectExecutionStore({
      prefix: "lease-contract",
      storage: new InMemoryDurableObjectStorage({
        sql: new TransactionalInMemorySqlStorage(),
      }),
    })
);
