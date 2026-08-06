import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import { createInMemoryHost } from "./execution-host";

describeAgentHostFaultContract({
  createHost: () => ({ host: createInMemoryHost() }),
  name: "in-memory",
});
