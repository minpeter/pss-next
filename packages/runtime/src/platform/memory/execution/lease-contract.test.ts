import { describeExecutionLeaseContract } from "../../../contracts/execution-store/lease-contract";
import { InMemoryExecutionStore } from "./store";

describeExecutionLeaseContract(
  "InMemoryExecutionStore",
  () => new InMemoryExecutionStore()
);
