export const examplePackages = [
  {
    name: "@minpeter/pss-example-basic",
    path: "examples/basic",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-hooks",
    path: "examples/hooks",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-local-file-agent",
    path: "examples/local-file-agent",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-sync-subagent",
    path: "examples/sync-subagent",
    requiredSource: "src/index.ts",
  },
  {
    name: "@minpeter/pss-example-background-subagent",
    path: "examples/background-subagent",
    requiredSource: "src/index.ts",
  },
];
export const appPackages = [
  {
    name: "@minpeter/pss-coding-agent",
    path: "apps/coding-agent",
    requiredSource: "src/index.ts",
    buildScript: "tsdown",
  },
];
