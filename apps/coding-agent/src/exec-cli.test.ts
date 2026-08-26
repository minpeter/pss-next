import { describe, expect, it } from "vitest";
import { formatExecUsage, parseExecArguments, runExecCli } from "./exec-cli";

const INVALID_OPTION_MESSAGE = "Invalid pss exec option.";
const invalidOptionPattern = /Invalid pss exec option\./u;

describe("headless exec arguments", () => {
  it("parses a pinned benchmark invocation", () => {
    expect(
      parseExecArguments(
        [
          "--workspace",
          "fixture",
          "--stdin",
          "--model",
          "qwen3.8-max-preview",
          "--base-url",
          "https://gateway.example/v1",
          "--timeout-seconds",
          "900",
          "--web-tools",
          "disabled",
          "--result-file",
          "/tmp/result.json",
        ],
        "/repo"
      )
    ).toStrictEqual({
      baseUrl: "https://gateway.example/v1",
      extensionPaths: [],
      help: false,
      model: "qwen3.8-max-preview",
      readStdin: true,
      resultFile: "/tmp/result.json",
      timeoutSeconds: 900,
      webToolsAvailability: "disabled",
      workspace: "/repo/fixture",
    });
  });

  it("requires exactly one prompt source", () => {
    expect(() => parseExecArguments([], "/repo")).toThrow(invalidOptionPattern);
    expect(() =>
      parseExecArguments(["--prompt", "one", "--stdin"], "/repo")
    ).toThrow(invalidOptionPattern);
  });

  it("rejects unknown options and invalid timeouts", () => {
    expect(() =>
      parseExecArguments(["--prompt", "one", "--wat"], "/repo")
    ).toThrow(invalidOptionPattern);
    for (const timeout of ["1201", "30s", "1.5"]) {
      expect(() =>
        parseExecArguments(
          ["--prompt", "one", "--timeout-seconds", timeout],
          "/repo"
        )
      ).toThrow(invalidOptionPattern);
    }
  });

  it.each([
    ["C0", "\u0000"],
    ["C1", "\u009b"],
    ["Cf", "\u2066"],
    ["Zl", "\u2028"],
    ["Zp", "\u2029"],
    ["malformed high surrogate", "\ud800"],
    ["malformed low surrogate", "\udc00"],
  ])(
    "returns a static error for an unknown option containing %s",
    (_case, text) => {
      // Given
      const option = `--unknown${text}EXEC_ARG_SECRET`;

      // When
      const parse = () => parseExecArguments([option], "/repo");

      // Then
      expect(parse).toThrow(INVALID_OPTION_MESSAGE);
    }
  );

  it("returns a static error for a huge unknown option", () => {
    // Given
    const option = `--unknown-EXEC_ARG_SECRET${"x".repeat(16_384)}`;

    // When
    const parse = () => parseExecArguments([option], "/repo");

    // Then
    expect(parse).toThrow(INVALID_OPTION_MESSAGE);
  });

  it.each([
    ["option terminator", ["--"]],
    ["missing prompt", []],
    ["missing option value", ["--prompt"]],
    ["invalid web tools value", ["--prompt", "ok", "--web-tools", "private"]],
  ])("returns a static error for %s", (_case, argv) => {
    // Given
    const parse = () => parseExecArguments(argv, "/repo");

    // When
    let message = "";
    try {
      parse();
    } catch (error) {
      message = error instanceof Error ? error.message : "non-error";
    }

    // Then
    expect(message).toBe(INVALID_OPTION_MESSAGE);
  });

  it("allows help without a prompt", () => {
    expect(parseExecArguments(["--help"], "/repo").help).toBe(true);
    expect(formatExecUsage()).toContain("pss exec --workspace");
    expect(formatExecUsage()).toContain("--extension");
  });

  it("preserves errors raised after option parsing", async () => {
    // Given
    const missingPromptPath = "/missing/EXEC_ARG_SECRET.txt";

    // When
    const execution = runExecCli({
      argv: ["--prompt-file", missingPromptPath],
      cwd: "/repo",
      env: {},
      stdout: { write: () => undefined },
    });

    // Then
    await expect(execution).rejects.toThrow(missingPromptPath);
  });

  it("collects repeatable -e/--extension paths", () => {
    expect(
      parseExecArguments(
        ["--stdin", "-e", "./one.ts", "--extension", "./two.mjs"],
        "/repo"
      ).extensionPaths
    ).toEqual(["./one.ts", "./two.mjs"]);
    expect(() => parseExecArguments(["--stdin", "-e"], "/repo")).toThrow(
      invalidOptionPattern
    );
  });
});
