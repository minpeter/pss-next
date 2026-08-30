import { describeCheckpointStoreContract } from "../../../contracts/execution-store/checkpoint-contract";
import { createInMemoryHost } from "./execution-host";

describeCheckpointStoreContract({
  createStore: () => createInMemoryHost().store,
});
