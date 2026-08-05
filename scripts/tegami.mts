import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

// Tegami propagates dependency bumps through private packages unless they are
// removed from its graph. Keep every non-release workspace explicit here; the
// config test derives the expected list from package manifests and fails when a
// new private or experimental workspace is not added.
const releaseIgnore = [
  "pss-next",
  // Built-in extensions are bundled into the coding-agent build instead of
  // being published on their own.
  "@minpeter/pss-extension-latex",
  "@minpeter/pss-extension-mermaid",
  "@minpeter/pss-extension-web",
  "@minpeter/pss-worker-agent",
  "@minpeter/pss-bench-shared",
  "@minpeter/pss-benchmark-compaction-score",
  "@minpeter/pss-benchmark-nextjs",
  "@minpeter/pss-edit-format-bench",
  "@minpeter/pss-runtime-edge-image-qa",
  "@minpeter/pss-example-background-subagent",
  "@minpeter/pss-example-basic",
  "@minpeter/pss-example-evals",
  "@minpeter/pss-example-hooks",
  "@minpeter/pss-example-local-file-agent",
  "@minpeter/pss-example-sync-subagent",
];

const paper = tegami({
  ignore: releaseIgnore,
  npm: {
    client: "pnpm",
    bumpDep: ({ dependent, kind }) => {
      if (releaseIgnore.includes(dependent.name)) {
        return false;
      }
      switch (kind) {
        case "dependencies":
        case "optionalDependencies":
          return "patch";
        case "devDependencies":
          return false;
        case "peerDependencies":
          return "major";
        default:
          return false;
      }
    },
    trustedPublish: {
      provider: "github",
      workflow: "release.yml",
    },
  },
  packages: {
    "@minpeter/pss-runtime": {
      prerelease: "next",
      npm: {
        distTag: "next",
      },
    },
    "@minpeter/pss-coding-agent": {
      prerelease: "next",
      npm: {
        distTag: "next",
      },
    },
  },
  plugins: [
    github({
      repo: "minpeter/pss-runtime",
      versionPr: {
        base: "main",
      },
    }),
  ],
});

await runCli(paper);
