import { describeExecutionLeaseContract } from "../../contracts/execution-store/lease-contract";
import { InMemoryExecutionStore } from "../memory/execution/store";
import { SqlHostStore } from "./store";

describeExecutionLeaseContract(
  "SQL port adapter",
  () => new SqlHostStore(new InMemoryExecutionStore())
);
