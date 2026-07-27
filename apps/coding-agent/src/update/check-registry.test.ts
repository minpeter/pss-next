import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_PACKAGE_NAME,
  DEFAULT_REGISTRY_BASE_URL,
  fetchDistTags,
  publishedTagVersion,
  resolveUpdateRegistryBaseUrl,
} from "./check";

describe("fetchDistTags", () => {
  it("returns every published dist-tag from one packument request", async () => {
    const urls: string[] = [];
    const tags = await fetchDistTags({
      fetchImpl: (url: string) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": {
                latest: "0.0.14",
                next: "0.0.15-next.0",
                canary: "0.0.16-canary.2",
              },
            }),
        });
      },
    });

    expect(tags).toEqual({
      latest: "0.0.14",
      next: "0.0.15-next.0",
      canary: "0.0.16-canary.2",
    });
    expect(urls).toEqual([
      `${DEFAULT_REGISTRY_BASE_URL}/${encodeURIComponent(CODING_AGENT_PACKAGE_NAME)}`,
    ]);
  });

  it("drops dist-tags whose value is not a valid version", async () => {
    const tags = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": { latest: "0.0.14", bogus: "not-a-version" },
            }),
        }),
    });

    expect(tags).toEqual({ latest: "0.0.14" });
  });

  it("preserves prototype-looking dist-tags as own properties", async () => {
    const tags = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": JSON.parse(
                '{"latest":"0.0.14","__proto__":"0.0.15-proto.0"}'
              ),
            }),
        }),
    });

    expect(Object.hasOwn(tags, "__proto__")).toBe(true);
    expect(publishedTagVersion(tags, "__proto__")).toBe("0.0.15-proto.0");
  });

  it("drops dist-tags whose names are outside the tag charset", async () => {
    const tags = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              "dist-tags": {
                latest: "0.0.14",
                "evil\u001b[31m": "9.9.9",
                "with space": "9.9.9",
              },
            }),
        }),
    });

    expect(tags).toEqual({ latest: "0.0.14" });
  });

  it("reads only own tag entries through publishedTagVersion", () => {
    expect(publishedTagVersion({ latest: "1.0.0" }, "latest")).toBe("1.0.0");
    expect(
      publishedTagVersion({ latest: "1.0.0" }, "toString")
    ).toBeUndefined();
    expect(
      publishedTagVersion({ latest: "1.0.0" }, "constructor")
    ).toBeUndefined();
  });

  it("returns an empty map when the registry fails or the payload is malformed", async () => {
    const rejected = await fetchDistTags({
      fetchImpl: () => Promise.reject(new Error("network down")),
    });
    expect(rejected).toEqual({});

    const notOk = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    });
    expect(notOk).toEqual({});

    const malformed = await fetchDistTags({
      fetchImpl: () =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 1 }) }),
    });
    expect(malformed).toEqual({});
  });
});

describe("resolveUpdateRegistryBaseUrl", () => {
  it("defaults to the npm registry", () => {
    expect(resolveUpdateRegistryBaseUrl({})).toBe(DEFAULT_REGISTRY_BASE_URL);
  });

  it("honors the registry override environment variable", () => {
    expect(
      resolveUpdateRegistryBaseUrl({
        PSS_UPDATE_REGISTRY_BASE_URL: "http://127.0.0.1:4873",
      })
    ).toBe("http://127.0.0.1:4873");
  });
});
