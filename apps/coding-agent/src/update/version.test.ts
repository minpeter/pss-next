import { describe, expect, it } from "vitest";
import {
  compareVersions,
  extractUpdateChannel,
  isSameMajorVersion,
  isValidVersion,
} from "./version";

describe("extractUpdateChannel", () => {
  it("tracks the latest channel for a stable release version", () => {
    expect(extractUpdateChannel("0.0.13")).toBe("latest");
  });

  it("tracks the next channel for a next prerelease version", () => {
    expect(extractUpdateChannel("0.0.14-next.2")).toBe("next");
  });

  it("maps any prerelease label to its own channel", () => {
    expect(extractUpdateChannel("1.0.0-beta.1")).toBe("beta");
    expect(extractUpdateChannel("2.0.0-canary.3")).toBe("canary");
    expect(extractUpdateChannel("1.0.0-rc.2")).toBe("rc");
    expect(extractUpdateChannel("1.0.0-alpha")).toBe("alpha");
  });

  it("uses latest when a prerelease starts with a numeric identifier", () => {
    expect(extractUpdateChannel("1.0.0-0")).toBe("latest");
    expect(extractUpdateChannel("1.0.0-1.beta")).toBe("latest");
  });
});

describe("isValidVersion", () => {
  it("accepts release, prerelease, and build-metadata versions", () => {
    expect(isValidVersion("0.0.13")).toBe(true);
    expect(isValidVersion("0.0.14-next.2")).toBe(true);
    expect(isValidVersion("1.2.3-rc.10")).toBe(true);
    expect(isValidVersion("1.2.3+build.7")).toBe(true);
    expect(isValidVersion("1.2.3-next.4+sha.abcdef")).toBe(true);
  });

  it("accepts alphanumeric prerelease identifiers", () => {
    expect(isValidVersion("1.0.0-alpha.1")).toBe(true);
    expect(isValidVersion("1.0.0-x-y-z.-")).toBe(true);
  });

  it("rejects malformed versions", () => {
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("0.0")).toBe(false);
    expect(isValidVersion("v0.0.13")).toBe(false);
    expect(isValidVersion("0.0.13-")).toBe(false);
    expect(isValidVersion("0.0.x")).toBe(false);
  });

  it("rejects numeric identifiers with leading zeroes", () => {
    expect(isValidVersion("01.0.0")).toBe(false);
    expect(isValidVersion("1.01.0")).toBe(false);
    expect(isValidVersion("1.0.0-01")).toBe(false);
    expect(isValidVersion("1.0.0-next.01")).toBe(false);
    expect(isValidVersion("1.0.0-0")).toBe(true);
  });
});

describe("isSameMajorVersion", () => {
  it("matches within the same major line", () => {
    expect(isSameMajorVersion("0.0.13", "0.0.14")).toBe(true);
    expect(isSameMajorVersion("0.0.14-next.2", "0.0.15-next.0")).toBe(true);
    expect(isSameMajorVersion("0.0.13", "1.0.0")).toBe(false);
    expect(isSameMajorVersion("1.0.0-next.0", "1.0.0")).toBe(true);
  });

  it("rejects invalid input", () => {
    expect(isSameMajorVersion("0.0.13", "not-a-version")).toBe(false);
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch numerically", () => {
    expect(compareVersions("0.0.13", "0.0.13")).toBe(0);
    expect(compareVersions("0.0.14", "0.0.13")).toBeGreaterThan(0);
    expect(compareVersions("0.0.9", "0.0.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.0.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("orders a release after its own prereleases", () => {
    expect(compareVersions("0.0.14", "0.0.14-next.2")).toBeGreaterThan(0);
    expect(compareVersions("0.0.14-next.1", "0.0.14")).toBeLessThan(0);
  });

  it("orders prerelease identifiers numerically", () => {
    expect(compareVersions("0.0.14-next.2", "0.0.14-next.1")).toBeGreaterThan(
      0
    );
    expect(compareVersions("0.0.14-next.2", "0.0.14-next.10")).toBeLessThan(0);
  });

  it("orders numeric identifiers without losing integer precision", () => {
    expect(
      compareVersions("9007199254740993.0.0", "9007199254740992.0.0")
    ).toBeGreaterThan(0);
    expect(
      compareVersions(
        "1.0.0-next.9007199254740993",
        "1.0.0-next.9007199254740992"
      )
    ).toBeGreaterThan(0);
  });

  it("ignores build metadata for precedence", () => {
    expect(compareVersions("1.2.3+build.7", "1.2.3+build.8")).toBe(0);
    expect(compareVersions("1.2.3-next.2+one", "1.2.3-next.2+two")).toBe(0);
  });
});
