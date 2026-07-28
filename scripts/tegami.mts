import { tegami } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

const paper = tegami({
  ignore: [
    "pss-next",
    "@minpeter/pss-worker-agent",
    "@minpeter/pss-runtime-edge-image-qa",
    /^@minpeter\/pss-example-/,
  ],
  npm: {
    client: "pnpm",
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
    "@minpeter/pss-extension-api": {
      prerelease: "next",
      npm: {
        distTag: "next",
      },
    },
    "@minpeter/pss-extension-latex": {
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
