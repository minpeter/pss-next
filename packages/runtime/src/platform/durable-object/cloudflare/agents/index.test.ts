import { beforeEach, describe, expect, it, vi } from "vitest";

const installEdgeCodecs = vi.fn();

vi.mock("../image-codecs-edge", () => ({
  installCloudflareImageCodecs: installEdgeCodecs,
}));

import { installCloudflareImageCodecs } from "./index";

describe("Cloudflare adapter entrypoint", () => {
  beforeEach(() => {
    installEdgeCodecs.mockClear();
  });

  it("installs edge codecs when requested", async () => {
    await installCloudflareImageCodecs();

    expect(installEdgeCodecs).toHaveBeenCalledOnce();
  });
});
