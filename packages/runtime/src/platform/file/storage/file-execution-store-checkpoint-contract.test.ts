import { describeCheckpointStoreContract } from "../../../contracts/execution-store/checkpoint-contract";
import { FileExecutionStore } from "./file-execution-store";
import { contractTempDir } from "./file-execution-store-test-support";

describeCheckpointStoreContract({
  createStore: () => new FileExecutionStore(contractTempDir()),
});
