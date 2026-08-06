import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import { createInMemoryHost } from "./execution-host";

describeAgentHostFaultContract({
  createHost: createInMemoryHost,
  name: "in-memory",
});
