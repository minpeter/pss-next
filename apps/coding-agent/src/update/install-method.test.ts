import { describe, expect, it } from "vitest";
import { CODING_AGENT_PACKAGE_NAME } from "./check";
import {
  classifyInstallPath,
  detectInstallMethod,
  type InstallMethod,
  type ProbeRunner,
} from "./install-method";

describe("classifyInstallPath", () => {
  const cases: readonly {
    readonly path: string;
    readonly expected: InstallMethod;
  }[] = [
    {
      path: "/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/@minpeter+pss-coding-agent@0.0.13/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "global", manager: "pnpm" },
    },
    {
      path: "C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@minpeter\\pss-coding-agent\\bin\\pss.js",
      expected: { kind: "global", manager: "pnpm" },
    },
    {
      path: "/usr/local/lib/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "global", manager: "npm" },
    },
    {
      path: "/home/u/.nvm/versions/node/v24.18.0/lib/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "global", manager: "npm" },
    },
    {
      path: "/home/u/.bun/install/global/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "global", manager: "bun" },
    },
    {
      path: "/home/u/.config/yarn/global/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "global", manager: "yarn" },
    },
    {
      path: "/home/u/.npm/_npx/abc123/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "ephemeral", runner: "npx" },
    },
    {
      path: "/home/u/.cache/pnpm/dlx/def456/node_modules/.pnpm/@minpeter+pss-coding-agent@0.0.13/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "ephemeral", runner: "pnpm dlx" },
    },
    {
      path: "/home/u/.bun/install/cache/@minpeter/pss-coding-agent@0.0.13/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      expected: { kind: "ephemeral", runner: "bunx" },
    },
    {
      path: "/repo/apps/coding-agent/bin/pss.js",
      expected: { kind: "unknown" },
    },
    {
      path: "/usr/local/lib/node_modules/some-other-cli/bin/pss.js",
      expected: { kind: "unknown" },
    },
  ];

  for (const { path, expected } of cases) {
    it(`classifies ${path} as ${JSON.stringify(expected)}`, () => {
      expect(classifyInstallPath(path)).toEqual(expected);
    });
  }
});

describe("detectInstallMethod", () => {
  const probeThrows: ProbeRunner = () =>
    Promise.reject(new Error("probe must not run"));

  it("short-circuits when the path already identifies the manager", async () => {
    const method = await detectInstallMethod({
      binPath:
        "/home/u/.bun/install/global/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      probe: probeThrows,
    });

    expect(method).toEqual({ kind: "global", manager: "bun" });
  });

  it("falls back to probing when the path is inconclusive", async () => {
    const calls: string[] = [];
    const probe: ProbeRunner = (command, args) => {
      calls.push(command);
      return Promise.resolve({
        code: 0,
        stdout:
          command === "npm" && args.includes("@minpeter/pss-coding-agent")
            ? "/usr/local/lib\n└── @minpeter/pss-coding-agent@0.0.13\n"
            : "",
      });
    };

    const method = await detectInstallMethod({
      binPath: "/opt/custom/bin/pss.js",
      probe,
    });

    expect(method).toEqual({ kind: "global", manager: "npm" });
    expect(calls.sort((a, b) => a.localeCompare(b))).toEqual([
      "bun",
      "npm",
      "pnpm",
      "yarn",
    ]);
  });

  it("refuses to guess when multiple managers report the package", async () => {
    const probe: ProbeRunner = () =>
      Promise.resolve({ code: 0, stdout: "@minpeter/pss-coding-agent@0.0.13" });

    const method = await detectInstallMethod({
      binPath: "/opt/custom/bin/pss.js",
      probe,
    });

    expect(method).toEqual({ kind: "unknown" });
  });

  it("treats a crashing probe as a non-match", async () => {
    const probe: ProbeRunner = (command) =>
      command === "pnpm"
        ? Promise.resolve({
            code: 0,
            stdout: "@minpeter/pss-coding-agent@0.0.13",
          })
        : Promise.reject(new Error("spawn ENOENT"));

    const method = await detectInstallMethod({
      binPath: "/opt/custom/bin/pss.js",
      probe,
    });

    expect(method).toEqual({ kind: "global", manager: "pnpm" });
  });

  it("ignores package output from a nonzero probe", async () => {
    const method = await detectInstallMethod({
      binPath: "/opt/custom/pss",
      probe: (command) =>
        Promise.resolve(
          command === "npm"
            ? { code: 1, stdout: CODING_AGENT_PACKAGE_NAME }
            : { code: 0, stdout: "" }
        ),
    });

    expect(method).toEqual({ kind: "unknown" });
  });

  it("reports unknown when no probe matches", async () => {
    const probe: ProbeRunner = () => Promise.resolve({ code: 1, stdout: "" });

    const method = await detectInstallMethod({
      binPath: "/opt/custom/bin/pss.js",
      probe,
    });

    expect(method).toEqual({ kind: "unknown" });
  });
});
