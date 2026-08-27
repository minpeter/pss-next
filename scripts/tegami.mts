import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

// Built-in extensions publish on their own so `pss extension install/update`
// can deliver them between coding-agent releases; the coding-agent bundle
// still inlines them as the default fallback. They publish to `latest`
// (not `next`) because the extension manager resolves tagless installs
// through the latest dist-tag, and the extensions have no stable line to
// keep separate.
const builtinExtensions = new Set([
  "@minpeter/pss-extension-latex",
  "@minpeter/pss-extension-mermaid",
  "@minpeter/pss-extension-web",
]);

// Tegami propagates dependency bumps through private packages unless they are
// removed from its graph. Keep every non-release workspace explicit here; the
// config test derives the expected list from package manifests and fails when a
// new private or experimental workspace is not added.
const releaseIgnore = [
  "pss-next",
  "@minpeter/pss-worker-agent",
  "@minpeter/pss-bench-shared",
  "@minpeter/pss-benchmark-compaction-score",
  "@minpeter/pss-benchmark-nextjs",
  "@minpeter/pss-edit-format-bench",
  "@minpeter/pss-runtime-edge-image-qa",
  "@minpeter/pss-celld-qa",
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
      // Built-in extensions peer-depend on the coding agent; a coding-agent
      // release must refresh their peer range with a patch, never a major.
      if (
        kind === "peerDependencies" &&
        builtinExtensions.has(dependent.name)
      ) {
        return "patch";
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
    "@minpeter/pss-extension-latex": {
      prerelease: "next",
      npm: {
        distTag: "latest",
      },
    },
    "@minpeter/pss-extension-mermaid": {
      prerelease: "next",
      npm: {
        distTag: "latest",
      },
    },
    "@minpeter/pss-extension-web": {
      prerelease: "next",
      npm: {
        distTag: "latest",
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
