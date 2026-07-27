import { describe, expect, it } from "vitest";
import { decideUpdateNotice, formatUpdateNotice } from "./check";

describe("decideUpdateNotice", () => {
  it("notifies a stable user when a newer stable version exists", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.13", channel: "latest" },
      { latest: "0.0.14", next: "0.0.15-next.0" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "latest",
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
    });
  });

  it("never offers a stable user a prerelease", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.13", channel: "latest" },
      { latest: "0.0.13", next: "0.0.14-next.2" }
    );

    expect(notice).toBeUndefined();
  });

  it("notifies a next user when a newer next version exists", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.1", channel: "next" },
      { latest: "0.0.13", next: "0.0.14-next.2" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "next",
      currentVersion: "0.0.14-next.1",
      latestVersion: "0.0.14-next.2",
    });
  });

  it("offers a next user the stable release that surpasses their prerelease", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.2", channel: "next" },
      { latest: "0.0.14", next: "0.0.14-next.2" }
    );

    expect(notice).toEqual({
      kind: "stable-surpassed",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.14",
    });
  });

  it("prefers the in-channel update when both channels moved", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.2", channel: "next" },
      { latest: "0.0.14", next: "0.0.15-next.0" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "next",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.15-next.0",
    });
  });

  it("notifies a user on any prerelease channel when that channel advances", () => {
    const notice = decideUpdateNotice(
      { version: "1.0.0-beta.1", channel: "beta" },
      { beta: "1.0.0-beta.3", latest: "1.0.0" }
    );

    expect(notice).toEqual({
      kind: "channel-update",
      channel: "beta",
      currentVersion: "1.0.0-beta.1",
      latestVersion: "1.0.0-beta.3",
    });
  });

  it("offers any prerelease user the stable release that surpasses them", () => {
    const notice = decideUpdateNotice(
      { version: "1.0.0-beta.3", channel: "beta" },
      { beta: "1.0.0-beta.3", latest: "1.0.0" }
    );

    expect(notice).toEqual({
      kind: "stable-surpassed",
      currentVersion: "1.0.0-beta.3",
      latestVersion: "1.0.0",
    });
  });

  it("stays silent when everything is up to date", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.14-next.2", channel: "next" },
      { latest: "0.0.13", next: "0.0.14-next.2" }
    );

    expect(notice).toBeUndefined();
  });

  it("ignores malformed tag versions from the registry", () => {
    const notice = decideUpdateNotice(
      { version: "0.0.13", channel: "latest" },
      { latest: "not-a-version" }
    );

    expect(notice).toBeUndefined();
  });
});

describe("formatUpdateNotice", () => {
  it("points an in-channel update at pss update", () => {
    const line = formatUpdateNotice({
      kind: "channel-update",
      channel: "latest",
      currentVersion: "0.0.13",
      latestVersion: "0.0.14",
    });

    expect(line).toContain("0.0.13");
    expect(line).toContain("0.0.14");
    expect(line).toContain("pss update");
  });

  it("points a stable-surpassed update at the explicit channel switch", () => {
    const line = formatUpdateNotice({
      kind: "stable-surpassed",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.14",
    });

    expect(line).toContain("0.0.14");
    expect(line).toContain("pss update --channel latest");
  });
});
